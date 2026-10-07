//! Where a link followed inside the desktop window goes (P8-06, P9-11; decisions 110, 134;
//! docs/DESKTOP.md). Pure (std only), so its tests run without building Tauri:
//! `rustc --edition 2021 --test src/links.rs -o <tmp>/links && <tmp>/links`
//! (`pnpm --filter @galactic/desktop test:rust`).
//!
//! - The window shows the shell's own pages and the Mission Control it is attached to
//!   (`http://127.0.0.1:<its port>`), nothing else.
//! - Any other `http(s)` link — a run's port (`http://localhost:5173`), a URL deliverable, an
//!   outside link — opens in the default browser, at most once a second and `OPEN_PER_MINUTE` a
//!   minute, so a page (or an agent's output in it) cannot flood the Mac with browser tabs.
//! - A link that asks for a new window (`target="_blank"`, `window.open`) never gets a window of
//!   the shell: an `http(s)` one goes to the default browser the same way.
//! - Every other scheme (`file:`, `javascript:`, `data:`, custom app schemes …) is refused: the
//!   shell never hands anything but a web address to `open`.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// What happens to a link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkTarget {
    /// Shown in the shell's window.
    Window,
    /// Handed to the default browser (if the rate limit allows).
    Browser,
    /// Neither: nothing happens.
    Refused,
}

fn is_web(scheme: &str) -> bool {
    matches!(scheme.as_bytes(), b"http" | b"https")
}

/// A navigation of the window itself (a link without a target, a redirect).
pub fn navigation_target(
    scheme: &str,
    host: &str,
    port: Option<u16>,
    current: Option<u16>,
) -> LinkTarget {
    match scheme {
        "tauri" | "about" => LinkTarget::Window,
        _ if is_web(scheme) => {
            if host == "tauri.localhost" {
                return LinkTarget::Window;
            }
            if scheme == "http" && host == "127.0.0.1" && port.is_some() && port == current {
                return LinkTarget::Window;
            }
            LinkTarget::Browser
        }
        _ => LinkTarget::Refused,
    }
}

/// A request for a new window (`target="_blank"`, `window.open`): the shell opens no second
/// window; a web address goes to the default browser, anything else is refused.
pub fn new_window_target(scheme: &str, host: &str) -> LinkTarget {
    if is_web(scheme) && host != "tauri.localhost" && !host.is_empty() {
        LinkTarget::Browser
    } else {
        LinkTarget::Refused
    }
}

/// Links handed to the default browser per minute, at most.
pub const OPEN_PER_MINUTE: usize = 5;

/// The rate limit of links handed to the default browser: one a second, `OPEN_PER_MINUTE` a
/// minute.
pub struct OpenLimiter {
    opened: VecDeque<Instant>,
}

impl OpenLimiter {
    pub const fn new() -> Self {
        Self { opened: VecDeque::new() }
    }

    /// Whether another link may go to the default browser at `now` (recorded when it may).
    pub fn may_open(&mut self, now: Instant) -> bool {
        while self
            .opened
            .front()
            .is_some_and(|t| now.duration_since(*t) >= Duration::from_secs(60))
        {
            self.opened.pop_front();
        }
        let too_soon = self
            .opened
            .back()
            .is_some_and(|t| now.duration_since(*t) < Duration::from_secs(1));
        if too_soon || self.opened.len() >= OPEN_PER_MINUTE {
            return false;
        }
        self.opened.push_back(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MC: Option<u16> = Some(4400);

    #[test]
    fn the_window_keeps_its_own_pages_and_its_mission_control() {
        assert_eq!(navigation_target("tauri", "localhost", None, MC), LinkTarget::Window);
        assert_eq!(navigation_target("about", "", None, MC), LinkTarget::Window);
        assert_eq!(navigation_target("http", "tauri.localhost", None, MC), LinkTarget::Window);
        assert_eq!(navigation_target("http", "127.0.0.1", Some(4400), MC), LinkTarget::Window);
    }

    #[test]
    fn port_links_and_other_web_addresses_open_in_the_browser() {
        // A run's port (decision 134), on localhost or 127.0.0.1.
        assert_eq!(navigation_target("http", "localhost", Some(5173), MC), LinkTarget::Browser);
        assert_eq!(navigation_target("http", "127.0.0.1", Some(5173), MC), LinkTarget::Browser);
        // Mission Control's port over https, or before the shell knows its port.
        assert_eq!(navigation_target("https", "127.0.0.1", Some(4400), MC), LinkTarget::Browser);
        assert_eq!(navigation_target("http", "127.0.0.1", Some(4400), None), LinkTarget::Browser);
        assert_eq!(navigation_target("https", "example.com", None, MC), LinkTarget::Browser);
    }

    #[test]
    fn other_schemes_are_refused() {
        let schemes = ["file", "javascript", "data", "blob", "ftp", "vscode", "x-apple-help", "ssh"];
        for scheme in schemes {
            assert_eq!(navigation_target(scheme, "", None, MC), LinkTarget::Refused, "{scheme}");
            assert_eq!(new_window_target(scheme, "host"), LinkTarget::Refused, "{scheme}");
        }
    }

    #[test]
    fn a_new_window_is_never_the_shells_own() {
        assert_eq!(new_window_target("http", "localhost"), LinkTarget::Browser);
        assert_eq!(new_window_target("https", "example.com"), LinkTarget::Browser);
        assert_eq!(new_window_target("http", "127.0.0.1"), LinkTarget::Browser);
        assert_eq!(new_window_target("http", "tauri.localhost"), LinkTarget::Refused);
        assert_eq!(new_window_target("about", ""), LinkTarget::Refused);
        assert_eq!(new_window_target("http", ""), LinkTarget::Refused);
    }

    #[test]
    fn one_link_a_second_and_five_a_minute() {
        let mut limit = OpenLimiter::new();
        let t0 = Instant::now();
        let at = |s: u64| t0 + Duration::from_millis(s);
        assert!(limit.may_open(at(0)));
        assert!(!limit.may_open(at(500)), "within a second");
        for s in 1..OPEN_PER_MINUTE as u64 {
            assert!(limit.may_open(at(s * 1_000)));
        }
        assert!(!limit.may_open(at(10_000)), "five already this minute");
        assert!(limit.may_open(at(60_000)), "the first one has aged out");
    }
}
