//! GalacticAgents desktop shell (P8-06; docs/DESKTOP.md).
//!
//! A thin Tauri 2 window around the local Mission Control:
//!
//! - **Server lifecycle** lives in the Node side (`apps/desktop/dist/main.js`, started here with
//!   piped stdio): it attaches to a running Mission Control or starts one with `galactic start`,
//!   and on quit stops only the one it started. It writes JSON lines (server / status / notify /
//!   exited) on stdout; this side writes `quit` / `start` on its stdin. Stdin closing (this
//!   process died) makes it stop what it started.
//! - **Window**: the shell's splash page, then `http://127.0.0.1:<port>` — the server's own origin,
//!   so the page gets its token from `/health` and opens its socket exactly as in a browser. No IPC
//!   capability is granted to any page (`capabilities: []`), and navigation is kept to the shell's
//!   own pages and that origin; other http(s) links — a run's port, a URL deliverable, also when
//!   they ask for a new window — open in the default browser, rate-limited (`links.rs`).
//! - **Menu bar**: status line, server line, the permission requests and questions waiting for
//!   the user (P9-15, `tray_menu.rs`: "Allow once" / "Deny" go to the Node side as an `answer`
//!   command, which answers through the panel's route; "Open in GalacticAgents" shows the window at
//!   `/#focus=question:<id>`), open, start, "Start at login", quit.
//! - **Phone access** (P9-16): the Node side asks Mission Control's `/api/remote/*` routes and
//!   sends a `phone` line; the menu shows "Phone: https://<name>" (a click copies it) or "Phone:
//!   off — <reason>", the "Phone Access" switch (`phone:on` / `phone:off` to the Node side) and
//!   "Show the Phone QR Code" (`/settings#access`).
//! - **Notifications**: posted from here (Rust) for the Node side's `notify` lines; the page's own
//!   notifications are off inside the shell (`window.__GALACTIC_DESKTOP__`).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent, Wry,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_notification::NotificationExt;

mod access;
mod links;
use links::{navigation_target, new_window_target, LinkTarget, OpenLimiter};
mod tray_menu;
use tray_menu::{
    focus_url, parse_action, phone_command, phone_menu, phone_url_ok, sections,
    settings_access_url, Action, Entry, PhoneLine, TrayMenu, PHONE_TOGGLE_ID,
};

/// Tells the page it runs inside the shell: the page then leaves notifications to the shell
/// (apps/web/src/desktop-shell.ts). A flag only — it grants nothing.
const SHELL_FLAG_JS: &str = r#"try { Object.defineProperty(window, '__GALACTIC_DESKTOP__', { value: Object.freeze({ shell: 'tauri', notifications: 'shell' }), configurable: false, writable: false }); } catch (e) {}"#;

/// How long quitting waits for the Node side to stop the server it started (the server's own
/// shutdown deadline is 25 s; the Node side SIGKILLs at 35 s).
const QUIT_DEADLINE: Duration = Duration::from_secs(45);

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Line {
    Server { server: ServerInfo },
    Status { view: TrayView },
    Notify { id: String, title: String, body: Option<String> },
    Menu { menu: TrayMenu },
    Phone { phone: PhoneLine },
    Exited,
}

#[derive(Deserialize, Clone)]
struct ServerInfo {
    url: String,
    port: u16,
    owned: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayView {
    label: String,
    title: String,
    tooltip: String,
    server_label: String,
    can_start: bool,
}

struct Menus {
    status: MenuItem<Wry>,
    server: MenuItem<Wry>,
    /// The phone section (P9-16): the Phone line, the "Phone Access" switch, the QR code.
    phone: MenuItem<Wry>,
    phone_access: CheckMenuItem<Wry>,
    phone_qr: MenuItem<Wry>,
    open: MenuItem<Wry>,
    start: MenuItem<Wry>,
    autostart: CheckMenuItem<Wry>,
    quit: MenuItem<Wry>,
}

struct Shell {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    /// The port of the Mission Control the window may show; read by the navigation guard.
    port: Arc<Mutex<Option<u16>>>,
    quitting: AtomicBool,
    may_exit: AtomicBool,
    /// The address the Phone line copies (only an `https://<host>` one, `tray_menu::phone_url_ok`).
    phone_url: Mutex<Option<String>>,
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        // A LaunchAgent, off until the user turns it on from the menu; started hidden at login.
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .setup(|app| {
            let handle = app.handle().clone();
            let hidden = std::env::args().any(|a| a == "--hidden");
            let port = Arc::new(Mutex::new(None::<u16>));
            app.manage(Shell {
                stdin: Mutex::new(None),
                child: Mutex::new(None),
                port: port.clone(),
                quitting: AtomicBool::new(false),
                may_exit: AtomicBool::new(false),
                phone_url: Mutex::new(None),
            });

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("GalacticAgents")
                .inner_size(1280.0, 820.0)
                .min_inner_size(480.0, 400.0)
                .visible(!hidden)
                .initialization_script(SHELL_FLAG_JS)
                .on_navigation(move |url| navigation_allowed(url, &port))
                .on_new_window(|url, _features| new_window(&url))
                .build()?;
            let w = window.clone();
            window.on_window_event(move |event| {
                // Closing the window keeps the app (and Mission Control) running in the menu bar.
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = w.hide();
                }
            });

            build_tray(&handle)?;
            // Off the main thread: finding Node asks the login shell, which may take seconds.
            thread::spawn(move || {
                if let Err(message) = spawn_node_side(&handle) {
                    show_failure(&handle, &message);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the GalacticAgents shell")
        .run(|app, event| match event {
            RunEvent::ExitRequested { api, .. } => {
                let shell = app.state::<Shell>();
                if !shell.may_exit.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    begin_quit(app);
                }
            }
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { .. } => show_window(app),
            RunEvent::Exit => {
                // Last resort: closing the Node side's stdin makes it stop what it started.
                let shell = app.state::<Shell>();
                shell.stdin.lock().unwrap().take();
            }
            _ => {}
        });
}

/// The links handed to the default browser (`links::OpenLimiter`: one a second, five a minute).
static OPENER: Mutex<OpenLimiter> = Mutex::new(OpenLimiter::new());

/// Hands a web address to the default browser, if the rate limit allows (`links.rs`). Only ever
/// called for an `http(s)` URL: `open` gets nothing else.
fn open_externally(url: &Url) {
    if !matches!(url.scheme(), "http" | "https") {
        return;
    }
    if OPENER.lock().unwrap().may_open(Instant::now()) {
        let _ = Command::new("/usr/bin/open").arg(url.as_str()).spawn();
    } else {
        eprintln!("[desktop] not opening {url}: too many links opened just now");
    }
}

/// The window shows the shell's own pages and the Mission Control it is attached to; any other
/// http(s) link (a run's port, a URL deliverable) opens in the default browser (`links.rs`).
fn navigation_allowed(url: &Url, port: &Arc<Mutex<Option<u16>>>) -> bool {
    let current = *port.lock().unwrap();
    match navigation_target(url.scheme(), url.host_str().unwrap_or(""), url.port(), current) {
        LinkTarget::Window => true,
        LinkTarget::Browser => {
            open_externally(url);
            false
        }
        LinkTarget::Refused => false,
    }
}

/// A link that asks for a new window (`target="_blank"` — the panel's port links and URL
/// deliverables, decision 134 — or `window.open`): never a second shell window; an http(s) one
/// opens in the default browser (`links.rs`). Without this handler WebKit drops the click.
fn new_window(url: &Url) -> NewWindowResponse<Wry> {
    if new_window_target(url.scheme(), url.host_str().unwrap_or("")) == LinkTarget::Browser {
        open_externally(url);
    }
    NewWindowResponse::Deny
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "Starting Mission Control…", false, None::<&str>)?;
    let server = MenuItem::with_id(app, "server", "Mission Control: not running", false, None::<&str>)?;
    let initial = phone_menu(&PhoneLine { on: true, label: "Phone: waiting for Mission Control".into(), ..PhoneLine::default() }, false);
    let phone = MenuItem::with_id(app, initial.line.id, initial.line.text, false, None::<&str>)?;
    let phone_access = CheckMenuItem::with_id(app, PHONE_TOGGLE_ID, initial.toggle_text, true, initial.checked, None::<&str>)?;
    let phone_qr = MenuItem::with_id(app, initial.qr.id, initial.qr.text, false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open GalacticAgents", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "Start Mission Control", false, None::<&str>)?;
    let at_login = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start at Login", true, at_login, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit GalacticAgents", true, None::<&str>)?;
    let menus = Menus { status, server, phone, phone_access, phone_qr, open, start, autostart, quit };
    let menu = compose_menu(app, &menus, &TrayMenu::default())?;
    app.manage(menus);
    TrayIconBuilder::with_id("galactic")
        .icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?)
        .icon_as_template(true)
        .tooltip("GalacticAgents")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_window(app),
            "start" => {
                send_command(app, "start");
            }
            "autostart" => toggle_autostart(app),
            "quit" => begin_quit(app),
            id => match parse_action(id) {
                Some(Action::Answer { question_id, version, allow }) => {
                    send_answer(app, &question_id, version, allow)
                }
                Some(Action::Focus { question_id }) => focus_question(app, &question_id),
                Some(Action::CopyPhoneUrl) => copy_phone_url(app),
                Some(Action::TogglePhone) => toggle_phone(app),
                Some(Action::ShowPhoneQr) => show_phone_qr(app),
                None => {}
            },
        })
        .build(app)?;
    Ok(())
}

/// The whole tray menu: the fixed items around the question sections (`tray_menu.rs`).
fn compose_menu(app: &AppHandle, menus: &Menus, model: &TrayMenu) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&menus.status)?;
    menu.append(&menus.server)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&menus.phone)?;
    menu.append(&menus.phone_access)?;
    menu.append(&menus.phone_qr)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for section in sections(model) {
        for entry in section {
            match entry {
                Entry::Item(i) => {
                    menu.append(&MenuItem::with_id(app, i.id, i.text, i.enabled, None::<&str>)?)?
                }
                Entry::Submenu { title, items } => {
                    let sub = Submenu::new(app, title, true)?;
                    for i in items {
                        sub.append(&MenuItem::with_id(app, i.id, i.text, i.enabled, None::<&str>)?)?;
                    }
                    menu.append(&sub)?;
                }
            }
        }
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&menus.open)?;
    menu.append(&menus.start)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&menus.autostart)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&menus.quit)?;
    Ok(menu)
}

/// A `menu` line: the tray menu is rebuilt around the new question sections.
fn on_menu(app: &AppHandle, model: TrayMenu) {
    let menus = app.state::<Menus>();
    match compose_menu(app, &menus, &model) {
        Ok(menu) => {
            if let Some(tray) = tray(app) {
                let _ = tray.set_menu(Some(menu));
            }
        }
        Err(e) => eprintln!("[desktop] the menu could not be rebuilt: {e}"),
    }
}

/// "Allow once" / "Deny": the Node side answers through the panel's route with the token and
/// this version (never "always"; a stale answer is refused there and notified).
fn send_answer(app: &AppHandle, question_id: &str, version: u64, allow: bool) {
    let line = serde_json::json!({
        "type": "answer",
        "questionId": question_id,
        "version": version,
        "decision": if allow { "allow" } else { "deny" },
    });
    send_command(app, &line.to_string());
}

/// "Open in GalacticAgents": the window, on Mission Control's page, selecting the question.
fn focus_question(app: &AppHandle, question_id: &str) {
    show_window(app);
    let port = *app.state::<Shell>().port.lock().unwrap();
    let (Some(port), Some(window)) = (port, main_window(app)) else { return };
    if let Ok(url) = Url::parse(&focus_url(port, question_id)) {
        let _ = window.navigate(url);
    }
}

/// A `phone` line (P9-16): sets the Phone line's text and whether a click copies (only a safe
/// `https://<host>` address while the phone can reach Mission Control), the "Phone Access" check
/// mark (the Node side's effective state: off too while phone access was turned off on purpose,
/// so a click turns it on), and whether "Show the Phone QR Code" is enabled (a live server). The
/// full reason (`detail`) goes to the log.
fn on_phone(app: &AppHandle, phone: PhoneLine) {
    let shell = app.state::<Shell>();
    let connected = shell.port.lock().unwrap().is_some();
    let m = phone_menu(&phone, connected);
    *shell.phone_url.lock().unwrap() = phone.url.filter(|u| phone_url_ok(u) && m.line.enabled);
    let menus = app.state::<Menus>();
    let _ = menus.phone.set_text(&m.line.text);
    let _ = menus.phone.set_enabled(m.line.enabled);
    let _ = menus.phone_access.set_checked(m.checked);
    let _ = menus.phone_qr.set_enabled(m.qr.enabled);
    if let Some(detail) = phone.detail {
        eprintln!("[desktop] phone access: {detail}");
    }
}

/// The Phone line: the phone's address to the clipboard (`pbcopy`, the address on its stdin).
fn copy_phone_url(app: &AppHandle) {
    let Some(url) = app.state::<Shell>().phone_url.lock().unwrap().clone() else { return };
    let Ok(mut child) = Command::new("/usr/bin/pbcopy")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(url.as_bytes());
    }
    let _ = child.wait();
    let _ = app
        .notification()
        .builder()
        .title("Phone address copied")
        .body(url)
        .show();
}

/// "Phone Access": the switch has already flipped itself; its new state goes to the Node side,
/// whose next `phone` line confirms it. With the Node side gone nothing would change: the check
/// mark goes back to what it was.
fn toggle_phone(app: &AppHandle) {
    let menus = app.state::<Menus>();
    let checked = menus.phone_access.is_checked().unwrap_or(false);
    if !send_command(app, phone_command(checked)) {
        let _ = menus.phone_access.set_checked(!checked);
    }
}

/// "Show the Phone QR Code": the window at Settings → Access (the code shows after its own click).
fn show_phone_qr(app: &AppHandle) {
    show_window(app);
    let port = *app.state::<Shell>().port.lock().unwrap();
    let (Some(port), Some(window)) = (port, main_window(app)) else { return };
    if let Ok(url) = Url::parse(&settings_access_url(port)) {
        let _ = window.navigate(url);
    }
}

fn tray(app: &AppHandle) -> Option<TrayIcon<Wry>> {
    app.tray_by_id("galactic")
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow<Wry>> {
    app.get_webview_window("main")
}

fn show_window(app: &AppHandle) {
    if let Some(w) = main_window(app) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn toggle_autostart(app: &AppHandle) {
    let launcher = app.autolaunch();
    let enabled = launcher.is_enabled().unwrap_or(false);
    let result = if enabled { launcher.disable() } else { launcher.enable() };
    if let Err(e) = result {
        eprintln!("[desktop] start at login: {e}");
    }
    let menus = app.state::<Menus>();
    let _ = menus.autostart.set_checked(launcher.is_enabled().unwrap_or(false));
}

/// Writes one command line to the Node side; `false` when it is gone (no pipe, or the write failed).
fn send_command(app: &AppHandle, command: &str) -> bool {
    let shell = app.state::<Shell>();
    let mut stdin = shell.stdin.lock().unwrap();
    match stdin.as_mut() {
        Some(pipe) => writeln!(pipe, "{command}").and_then(|()| pipe.flush()).is_ok(),
        None => false,
    }
}

/// Quit: the Node side stops the server only if it started it, then exits; the app exits when
/// it has (or after `QUIT_DEADLINE`).
fn begin_quit(app: &AppHandle) {
    let shell = app.state::<Shell>();
    if shell.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let menus = app.state::<Menus>();
    let _ = menus.status.set_text("Stopping…");
    if let Some(w) = main_window(app) {
        let _ = w.hide();
    }
    let pipe = shell.stdin.lock().unwrap().take();
    match pipe {
        Some(mut pipe) => {
            let _ = writeln!(pipe, "quit");
            let _ = pipe.flush();
            drop(pipe);
            let handle = app.clone();
            thread::spawn(move || {
                thread::sleep(QUIT_DEADLINE);
                eprintln!("[desktop] the Node side did not exit in time; quitting anyway");
                allow_exit(&handle);
            });
        }
        None => allow_exit(app),
    }
}

fn allow_exit(app: &AppHandle) {
    app.state::<Shell>().may_exit.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// The repository whose built server, web app and Node side the shell runs: `GALACTIC_REPO`, else
/// the checkout this shell was built from.
fn repo_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("GALACTIC_REPO") {
        return PathBuf::from(dir);
    }
    let built_from = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    fs::canonicalize(&built_from).unwrap_or(built_from)
}

/// Node and the user's PATH. An app opened from the Finder gets a minimal PATH, while Mission
/// Control's agents need the user's (git, the agent CLIs, the project's tools): the login shell is
/// asked once. `GALACTIC_NODE` overrides the node binary.
fn find_node() -> (Option<PathBuf>, Option<String>) {
    let (probed_node, probed_path) = probe_login_shell();
    if let Some(node) = std::env::var_os("GALACTIC_NODE") {
        return (Some(PathBuf::from(node)), probed_path);
    }
    if let Some(node) = probed_node.filter(|p| p.is_file()) {
        return (Some(node), probed_path);
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
        PathBuf::from(format!("{home}/.volta/bin/node")),
    ];
    if let Ok(entries) = fs::read_dir(format!("{home}/.nvm/versions/node")) {
        let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path().join("bin/node")).collect();
        versions.sort();
        candidates.extend(versions.into_iter().rev());
    }
    (candidates.into_iter().find(|p| p.is_file()), probed_path)
}

/// Asks the login shell for its PATH and node, off the main thread, for at most 10 s (the shell
/// is killed then). `-lc`, not `-ilc`: an interactive shell would source `.zshrc` and whatever it
/// starts (prompts, plugin managers, `exec tmux`…) with no terminal to run in. The tradeoff: a
/// PATH set only in `.zshrc` is not seen — `.zprofile` / `.zshenv` are, and the usual node
/// install folders (Homebrew, Volta, nvm) are tried anyway; `GALACTIC_NODE` overrides it all
/// (docs/DESKTOP.md).
fn probe_login_shell() -> (Option<PathBuf>, Option<String>) {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let Ok(mut child) = Command::new(shell)
        .args([
            "-lc",
            r#"printf '__GALACTIC_PATH__%s\n' "$PATH"; printf '__GALACTIC_NODE__%s\n' "$(command -v node)""#,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return (None, None);
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return (None, None);
    };
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        let _ = tx.send(text);
    });
    let text = match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(text) => text,
        Err(_) => {
            eprintln!("[desktop] the login shell did not answer in 10 s; it was stopped");
            let _ = child.kill();
            let _ = child.wait();
            return (None, None);
        }
    };
    let _ = child.wait();
    let mut node = None;
    let mut path = None;
    for line in text.lines() {
        if let Some(p) = line.strip_prefix("__GALACTIC_PATH__") {
            path = Some(p.to_string()).filter(|p| !p.is_empty());
        } else if let Some(n) = line.strip_prefix("__GALACTIC_NODE__") {
            node = Some(PathBuf::from(n)).filter(|p| p.is_absolute());
        }
    }
    (node, path)
}

/// `--port <n>` and `--home <dir>` on the shell's command line become `GALACTIC_PORT` and
/// `GALACTIC_HOME` for the Node side (and its server); the environment variables work as well.
fn cli_overrides() -> Vec<(&'static str, String)> {
    let args: Vec<String> = std::env::args().collect();
    let mut env = Vec::new();
    for (i, arg) in args.iter().enumerate() {
        let value = args.get(i + 1).cloned();
        match (arg.as_str(), value) {
            ("--port", Some(v)) => env.push(("GALACTIC_PORT", v)),
            ("--home", Some(v)) => env.push(("GALACTIC_HOME", v)),
            _ => {}
        }
    }
    env
}

fn log_path(app: &AppHandle) -> Option<PathBuf> {
    match std::env::var_os("GALACTIC_DESKTOP_LOG") {
        Some(p) => Some(PathBuf::from(p)),
        None => Some(app.path().app_log_dir().ok()?.join("desktop.log")),
    }
}

fn log_file(app: &AppHandle) -> Option<File> {
    let path = log_path(app)?;
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    File::create(path).ok()
}

fn spawn_node_side(app: &AppHandle) -> Result<(), String> {
    let repo = repo_dir();
    // P8-23: macOS guards ~/Documents per app; a refused prompt gets its own message — checked
    // first, since a refused folder also makes the build check below fail ("not built").
    access::check_readable(&repo)?;
    let entry = repo.join("apps/desktop/dist/main.js");
    if !entry.is_file() {
        return Err(format!(
            "GalacticAgents is not built ({} is missing). Run `pnpm build` in {}.",
            entry.display(),
            repo.display()
        ));
    }
    let (node, login_path) = find_node();
    if app.state::<Shell>().quitting.load(Ordering::SeqCst) {
        return Ok(()); // quit while the login shell was asked: start nothing
    }
    let node = node.ok_or("Node.js was not found. Install Node 22+ or set GALACTIC_NODE.")?;
    let mut path = login_path.unwrap_or_default();
    if let Ok(current) = std::env::var("PATH") {
        path = if path.is_empty() { current } else { format!("{path}:{current}") };
    }
    let stderr = match log_file(app) {
        Some(file) => Stdio::from(file),
        None => Stdio::inherit(),
    };
    let mut command = Command::new(&node);
    command
        .arg(&entry)
        .current_dir(&repo)
        .env("PATH", path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(stderr);
    for (key, value) in cli_overrides() {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Cannot start {}: {e}", node.display()))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let shell = app.state::<Shell>();
    *shell.stdin.lock().unwrap() = child.stdin.take();
    *shell.child.lock().unwrap() = Some(child);

    let handle = app.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            match serde_json::from_str::<Line>(&line) {
                Ok(parsed) => on_line(&handle, parsed),
                Err(e) => eprintln!("[desktop] unreadable line from the Node side: {e}"),
            }
        }
        // The Node side exited: reap it, then quit if quitting, else say so.
        let shell = handle.state::<Shell>();
        if let Some(mut child) = shell.child.lock().unwrap().take() {
            let _ = child.wait();
        }
        if shell.quitting.load(Ordering::SeqCst) {
            allow_exit(&handle);
        } else {
            // A refused folder (P8-23) says so; anything else keeps the usual message.
            let log = log_path(&handle).and_then(|p| fs::read_to_string(p).ok()).unwrap_or_default();
            let message = access::failure_from_log(&log, &repo_dir()).unwrap_or_else(|| {
                "The shell's helper stopped. Quit and open GalacticAgents again.".to_string()
            });
            show_failure(&handle, &message);
        }
    });
    Ok(())
}

fn on_line(app: &AppHandle, line: Line) {
    match line {
        Line::Server { server } => on_server(app, server),
        Line::Status { view } => on_status(app, view),
        Line::Notify { id, title, body } => {
            let mut builder = app.notification().builder().title(title);
            if let Some(body) = body {
                builder = builder.body(body);
            }
            if let Err(e) = builder.show() {
                eprintln!("[desktop] notification {id}: {e}");
            }
        }
        Line::Menu { menu } => on_menu(app, menu),
        Line::Phone { phone } => on_phone(app, phone),
        Line::Exited => {}
    }
}

fn on_server(app: &AppHandle, server: ServerInfo) {
    let shell = app.state::<Shell>();
    *shell.port.lock().unwrap() = Some(server.port);
    let menus = app.state::<Menus>();
    let _ = menus.quit.set_text(if server.owned {
        "Quit GalacticAgents (stops Mission Control)"
    } else {
        "Quit GalacticAgents"
    });
    let Some(window) = main_window(app) else { return };
    let Ok(target) = Url::parse(&format!("{}/", server.url)) else { return };
    let same = window
        .url()
        .map(|u| u.scheme() == "http" && u.port() == target.port())
        .unwrap_or(false);
    if !same {
        let _ = window.navigate(target);
    }
}

fn on_status(app: &AppHandle, view: TrayView) {
    let menus = app.state::<Menus>();
    let _ = menus.status.set_text(&view.label);
    let _ = menus.server.set_text(&view.server_label);
    let _ = menus.start.set_enabled(view.can_start);
    if let Some(tray) = tray(app) {
        let title = if view.title.is_empty() { None } else { Some(view.title.as_str()) };
        let _ = tray.set_title(title);
        let _ = tray.set_tooltip(Some(view.tooltip.as_str()));
    }
    set_splash_text(app, &view.label);
}

/// While the window still shows the splash page, it says what the menu bar says.
fn set_splash_text(app: &AppHandle, text: &str) {
    let Some(window) = main_window(app) else { return };
    let on_splash = window.url().map(|u| u.scheme() != "http" || u.host_str() != Some("127.0.0.1")).unwrap_or(true);
    if on_splash {
        if let Ok(js) = serde_json::to_string(text) {
            let _ = window.eval(format!(
                "var s = document.getElementById('status'); if (s) s.textContent = {js};"
            ));
        }
    }
}

fn show_failure(app: &AppHandle, message: &str) {
    eprintln!("[desktop] {message}");
    if let Some(menus) = app.try_state::<Menus>() {
        let _ = menus.status.set_text(message);
    }
    if let Some(tray) = tray(app) {
        let _ = tray.set_title(Some("!"));
    }
    set_splash_text(app, message);
    show_window(app);
}
