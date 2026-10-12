//! The menu bar's question sections (P9-15; docs/DESKTOP.md §2): the Node side's `menu` line
//! (`apps/desktop/src/tray-menu.ts`) turned into menu entries, and a clicked entry's id turned
//! back into an action. Pure — no Tauri — so it is tested on its own like `links.rs`:
//! `pnpm --filter @galactic/desktop test:rust`. (`serde` is only derived in the app build: the
//! standalone test build has no crates.)
//!
//! - "Permission requests (N)": one submenu per request, "<agent>: <tool> <summary>", with
//!   "Allow once", "Deny" and "Open in GalacticAgents"; never an "always". At most what the Node
//!   side sent (10), then "N more — open the app".
//! - "Questions (N)": the clarification questions the user holds, each opening the app on it
//!   (an answer needs typing).
//!
//! - The phone section (P9-16): "Phone: https://<name>" (a click copies the address) or
//!   "Phone: off — <reason>", the "Phone Access" switch and "Show the Phone QR Code".
//!
//! Every title is agent-provided text: the Node side already redacted, cleaned and capped it; it
//! is cleaned again here (control and bidirectional-formatting characters removed, one line,
//! capped) and `&` is doubled, which the menu library would otherwise read as a mnemonic marker.

/// The longest title shown, in characters (the Node side caps at 80 already).
pub const TITLE_MAX: usize = 90;

#[cfg_attr(not(test), derive(serde::Deserialize))]
#[cfg_attr(not(test), serde(rename_all = "camelCase"))]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TrayMenu {
    pub permissions: Vec<PermissionItem>,
    pub permission_count: usize,
    pub questions: Vec<QuestionItem>,
    pub question_count: usize,
}

#[cfg_attr(not(test), derive(serde::Deserialize))]
#[derive(Clone, Debug, PartialEq)]
pub struct PermissionItem {
    pub id: String,
    pub version: u64,
    pub title: String,
    pub sending: Option<bool>,
}

#[cfg_attr(not(test), derive(serde::Deserialize))]
#[derive(Clone, Debug, PartialEq)]
pub struct QuestionItem {
    pub id: String,
    pub title: String,
}

/// One menu entry: a line (clickable when `enabled`) or a submenu of lines.
#[derive(Clone, Debug, PartialEq)]
pub enum Entry {
    Item(Item),
    Submenu { title: String, items: Vec<Item> },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    /// The menu id (`allow:<version>:<question>`, `deny:…`, `focus:<question>`, `open`, or
    /// `none` for a disabled line).
    pub id: String,
    pub text: String,
    pub enabled: bool,
}

/// What a click on one of these entries asks for.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Answer { question_id: String, version: u64, allow: bool },
    Focus { question_id: String },
    /// The Phone line: copy the phone's address (P9-16).
    CopyPhoneUrl,
    /// "Phone Access": the switch was clicked.
    TogglePhone,
    /// "Show the Phone QR Code": the window at Settings → Access.
    ShowPhoneQr,
}

/// The Node side's `phone` line (P9-16, `apps/desktop/src/phone.ts`).
#[cfg_attr(not(test), derive(serde::Deserialize))]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PhoneLine {
    pub on: bool,
    pub label: String,
    pub url: Option<String>,
    pub detail: Option<String>,
}

pub const PHONE_LINE_ID: &str = "phone-copy";
pub const PHONE_TOGGLE_ID: &str = "phone-toggle";
pub const PHONE_QR_ID: &str = "phone-qr";

/// The phone section of the menu (P9-16): the Phone line (clickable — it copies the address —
/// only when the phone can reach Mission Control at a safe `https://` address), the "Phone
/// Access" switch, and "Show the Phone QR Code".
#[derive(Clone, Debug, PartialEq)]
pub struct PhoneMenu {
    pub line: Item,
    pub toggle_text: String,
    pub checked: bool,
    pub qr: Item,
}

pub fn phone_menu(phone: &PhoneLine, connected: bool) -> PhoneMenu {
    let url = phone.url.as_deref().filter(|u| phone_url_ok(u));
    let mut label = clean_text(&phone.label, TITLE_MAX);
    if label.is_empty() {
        label = "Phone: off".into();
    }
    PhoneMenu {
        line: item(PHONE_LINE_ID, label, url.is_some()),
        toggle_text: "Phone Access".into(),
        checked: phone.on,
        qr: item(PHONE_QR_ID, "Show the Phone QR Code", connected),
    }
}

/// An address the Phone line may copy: `https://<host>` with a plain host name, nothing else.
pub fn phone_url_ok(url: &str) -> bool {
    let Some(host) = url.strip_prefix("https://") else { return false };
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
}

/// The command a click on "Phone Access" sends, from the switch's new state.
pub fn phone_command(checked: bool) -> &'static str {
    if checked {
        "phone:on"
    } else {
        "phone:off"
    }
}

/// `http://127.0.0.1:<port>/settings#access`: the settings page, scrolled to Access (the QR code).
pub fn settings_access_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/settings#access")
}

fn item(id: impl Into<String>, text: impl Into<String>, enabled: bool) -> Item {
    Item { id: id.into(), text: text.into(), enabled }
}

/// The sections, each a list of entries (the caller puts a separator after each). Empty when
/// nothing waits for the user.
pub fn sections(menu: &TrayMenu) -> Vec<Vec<Entry>> {
    let mut out = Vec::new();
    let permission_count = menu.permission_count.max(menu.permissions.len());
    if permission_count > 0 {
        let mut section = vec![Entry::Item(item(
            "none",
            format!("Permission requests ({permission_count})"),
            false,
        ))];
        for p in &menu.permissions {
            let sending = p.sending.unwrap_or(false);
            let mut title = clean_text(&p.title, TITLE_MAX);
            if sending {
                title.push_str(" — sending…");
            }
            section.push(Entry::Submenu {
                title,
                items: vec![
                    item(format!("allow:{}:{}", p.version, p.id), "Allow once", !sending),
                    item(format!("deny:{}:{}", p.version, p.id), "Deny", !sending),
                    item(format!("focus:{}", p.id), "Open in GalacticAgents", true),
                ],
            });
        }
        let more = permission_count.saturating_sub(menu.permissions.len());
        if more > 0 {
            section.push(Entry::Item(item("open", format!("{more} more — open the app"), true)));
        }
        out.push(section);
    }
    let question_count = menu.question_count.max(menu.questions.len());
    if question_count > 0 {
        let mut section = vec![Entry::Item(item("none", format!("Questions ({question_count})"), false))];
        for q in &menu.questions {
            section.push(Entry::Item(item(format!("focus:{}", q.id), clean_text(&q.title, TITLE_MAX), true)));
        }
        let more = question_count.saturating_sub(menu.questions.len());
        if more > 0 {
            section.push(Entry::Item(item("open", format!("{more} more — open the app"), true)));
        }
        out.push(section);
    }
    out
}

/// The action of a clicked entry's id; `None` for any other id.
pub fn parse_action(id: &str) -> Option<Action> {
    match id {
        PHONE_LINE_ID => return Some(Action::CopyPhoneUrl),
        PHONE_TOGGLE_ID => return Some(Action::TogglePhone),
        PHONE_QR_ID => return Some(Action::ShowPhoneQr),
        _ => {}
    }
    if let Some(question_id) = id.strip_prefix("focus:") {
        return (!question_id.is_empty()).then(|| Action::Focus { question_id: question_id.to_string() });
    }
    let (allow, rest) = if let Some(rest) = id.strip_prefix("allow:") {
        (true, rest)
    } else if let Some(rest) = id.strip_prefix("deny:") {
        (false, rest)
    } else {
        return None;
    };
    let (version, question_id) = rest.split_once(':')?;
    let version = version.parse::<u64>().ok()?;
    if question_id.is_empty() {
        return None;
    }
    Some(Action::Answer { question_id: question_id.to_string(), version, allow })
}

/// Characters never shown in a title: controls, bidirectional embeddings / overrides / isolates
/// and marks, zero-width and invisible formatting characters, line and paragraph separators.
fn unsafe_char(c: char) -> bool {
    c.is_control()
        || matches!(
            c,
            '\u{00AD}'
                | '\u{061C}'
                | '\u{180E}'
                | '\u{200B}'..='\u{200F}'
                | '\u{2028}'..='\u{202E}'
                | '\u{2060}'..='\u{2069}'
                | '\u{FEFF}'
                | '\u{FFF9}'..='\u{FFFB}'
        )
}

/// One line, unsafe characters removed, at most `max` characters (an ellipsis when cut), `&`
/// doubled for the menu library.
pub fn clean_text(text: &str, max: usize) -> String {
    let mut line = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            space = true;
            continue;
        }
        if unsafe_char(c) {
            continue;
        }
        if space && !line.is_empty() {
            line.push(' ');
        }
        space = false;
        line.push(c);
    }
    let count = line.chars().count();
    let cut = if count > max {
        let mut s: String = line.chars().take(max.saturating_sub(1).max(1)).collect();
        s = s.trim_end().to_string();
        s.push('…');
        s
    } else {
        line
    };
    cut.replace('&', "&&")
}

/// `http://127.0.0.1:<port>/#focus=question%3A<id>`: the page selects the question (the push
/// clicks' fragment, `apps/web/src/pwa/notification-clicks.ts`).
pub fn focus_url(port: u16, question_id: &str) -> String {
    let mut encoded = String::new();
    for b in format!("question:{question_id}").bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{b:02X}"));
        }
    }
    format!("http://127.0.0.1:{port}/#focus={encoded}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str, version: u64, title: &str) -> PermissionItem {
        PermissionItem { id: id.into(), version, title: title.into(), sending: None }
    }

    #[test]
    fn nothing_waiting_is_no_section() {
        assert!(sections(&TrayMenu::default()).is_empty());
    }

    #[test]
    fn a_request_is_a_submenu_with_allow_once_deny_and_open() {
        let menu = TrayMenu {
            permissions: vec![request("q-1", 4, "Steward · parser: Bash git push")],
            permission_count: 1,
            ..TrayMenu::default()
        };
        let s = sections(&menu);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0][0], Entry::Item(item("none", "Permission requests (1)", false)));
        assert_eq!(
            s[0][1],
            Entry::Submenu {
                title: "Steward · parser: Bash git push".into(),
                items: vec![
                    item("allow:4:q-1", "Allow once", true),
                    item("deny:4:q-1", "Deny", true),
                    item("focus:q-1", "Open in GalacticAgents", true),
                ],
            }
        );
        let texts: Vec<String> = match &s[0][1] {
            Entry::Submenu { items, .. } => items.iter().map(|i| i.text.to_lowercase()).collect(),
            _ => vec![],
        };
        assert!(texts.iter().all(|t| !t.contains("always")));
    }

    #[test]
    fn a_request_being_answered_offers_no_second_answer() {
        let mut p = request("q-1", 1, "A: Bash ls");
        p.sending = Some(true);
        let menu = TrayMenu { permissions: vec![p], permission_count: 1, ..TrayMenu::default() };
        match &sections(&menu)[0][1] {
            Entry::Submenu { title, items } => {
                assert_eq!(title, "A: Bash ls — sending…");
                assert!(!items[0].enabled && !items[1].enabled && items[2].enabled);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_rest_is_counted_and_questions_open_the_app() {
        let menu = TrayMenu {
            permissions: (0..10).map(|i| request(&format!("q-{i}"), 0, "A: x")).collect(),
            permission_count: 13,
            questions: vec![QuestionItem { id: "c-1".into(), title: "W: Keep the cookie?".into() }],
            question_count: 1,
        };
        let s = sections(&menu);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].len(), 12);
        assert_eq!(s[0][11], Entry::Item(item("open", "3 more — open the app", true)));
        assert_eq!(s[1][0], Entry::Item(item("none", "Questions (1)", false)));
        assert_eq!(s[1][1], Entry::Item(item("focus:c-1", "W: Keep the cookie?", true)));
    }

    #[test]
    fn ids_parse_back_into_actions() {
        assert_eq!(
            parse_action("allow:4:q-1"),
            Some(Action::Answer { question_id: "q-1".into(), version: 4, allow: true })
        );
        assert_eq!(
            parse_action("deny:0:q:with:colons"),
            Some(Action::Answer { question_id: "q:with:colons".into(), version: 0, allow: false })
        );
        assert_eq!(parse_action("focus:c-1"), Some(Action::Focus { question_id: "c-1".into() }));
        for id in ["open", "none", "quit", "allow:x:q-1", "allow:4:", "allow:4", "focus:", "always:1:q"] {
            assert_eq!(parse_action(id), None, "{id}");
        }
    }

    #[test]
    fn titles_are_one_safe_capped_line_with_ampersands_kept() {
        assert_eq!(clean_text("a\n\tb  c", 90), "a b c");
        assert_eq!(clean_text("rm \u{202E}txt.exe\u{202C}\u{200B}\u{7}", 90), "rm txt.exe");
        assert_eq!(clean_text("make && make test", 90), "make &&&& make test");
        assert_eq!(clean_text("abcdef", 4), "abc…");
        assert_eq!(clean_text("🚀🚀🚀🚀", 3), "🚀🚀…");
        let long = "x".repeat(500);
        assert_eq!(clean_text(&long, TITLE_MAX).chars().count(), TITLE_MAX);
    }

    #[test]
    fn the_phone_line_copies_only_a_safe_address() {
        let ready = PhoneLine {
            on: true,
            label: "Phone: https://mymac.tail1234.ts.net · 1 connected".into(),
            url: Some("https://mymac.tail1234.ts.net".into()),
            detail: None,
        };
        let m = phone_menu(&ready, true);
        assert_eq!(m.line, item("phone-copy", "Phone: https://mymac.tail1234.ts.net · 1 connected", true));
        assert_eq!(m.toggle_text, "Phone Access");
        assert!(m.checked);
        assert_eq!(m.qr, item("phone-qr", "Show the Phone QR Code", true));

        let off = PhoneLine { on: false, label: "Phone: off — Tailscale not running".into(), url: None, detail: None };
        let m = phone_menu(&off, false);
        assert_eq!(m.line, item("phone-copy", "Phone: off — Tailscale not running", false));
        assert!(!m.checked);
        assert!(!m.qr.enabled);

        let sneaky = PhoneLine { url: Some("https://evil.example/path?x".into()), ..ready.clone() };
        assert!(!phone_menu(&sneaky, true).line.enabled);
        for bad in ["http://mymac.ts.net", "https://", "https://a b.ts.net", "https://a..ts.net", "file:///etc"] {
            assert!(!phone_url_ok(bad), "{bad}");
        }
        assert!(phone_url_ok("https://mymac.tail1234.ts.net"));
        let empty = PhoneLine { label: "\u{202E}".into(), ..PhoneLine::default() };
        assert_eq!(phone_menu(&empty, true).line.text, "Phone: off");
    }

    #[test]
    fn phone_ids_and_commands() {
        assert_eq!(parse_action("phone-copy"), Some(Action::CopyPhoneUrl));
        assert_eq!(parse_action("phone-toggle"), Some(Action::TogglePhone));
        assert_eq!(parse_action("phone-qr"), Some(Action::ShowPhoneQr));
        assert_eq!(phone_command(true), "phone:on");
        assert_eq!(phone_command(false), "phone:off");
        assert_eq!(settings_access_url(4321), "http://127.0.0.1:4321/settings#access");
    }

    #[test]
    fn the_focus_url_is_the_push_clicks_fragment() {
        assert_eq!(focus_url(4321, "q-1"), "http://127.0.0.1:4321/#focus=question%3Aq-1");
        assert_eq!(focus_url(4400, "a b#c"), "http://127.0.0.1:4400/#focus=question%3Aa%20b%23c");
    }
}
