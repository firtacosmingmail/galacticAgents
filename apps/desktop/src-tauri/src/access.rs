//! macOS folder access (P8-23). The repository the app runs usually lives under `~/Documents`, a
//! folder macOS guards per app: the first start asks "GalacticAgents would like to access files in
//! your Documents folder". Refused, every read there fails with "operation not permitted" — the
//! Node side dies before it says anything, and the window only knew that its helper stopped. This
//! module turns that refusal into a message that says what happened and how to undo it.

use std::fs;
use std::io;
use std::path::Path;

/// Where the user allows it again, as the System Settings window names it.
pub const SETTINGS_PATH: &str =
    "System Settings → Privacy & Security → Files and Folders → GalacticAgents";

/// The message for a refused folder: what happened, where to allow it, then open the app again.
pub fn refused_message(repo: &Path) -> String {
    format!(
        "macOS refused GalacticAgents access to its project folder ({}), so Mission Control \
         cannot start. Allow it in {SETTINGS_PATH} (turn on the folder's switch, e.g. Documents \
         Folder), then quit and open GalacticAgents again.",
        repo.display()
    )
}

/// Whether an error is macOS refusing the folder (EPERM / EACCES).
pub fn is_refusal(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied
}

/// Reads one file of the project (its `package.json`) before the helper starts: on macOS this is
/// also what asks the question the first time. A refusal comes back as the message to show; any
/// other failure is left to the usual checks.
pub fn check_readable(repo: &Path) -> Result<(), String> {
    match fs::read(repo.join("package.json")) {
        Err(error) if is_refusal(&error) => Err(refused_message(repo)),
        _ => Ok(()),
    }
}

/// When the helper stopped: whether its log has a line where a read inside the project was
/// refused (Node prints "operation not permitted", `EPERM`, `EACCES` or "permission denied" with
/// the path), and then the message to show. The project's path is matched as given and as its real
/// path (`/private/...`, a symlinked `GALACTIC_REPO`).
pub fn failure_from_log(log: &str, repo: &Path) -> Option<String> {
    let mut paths = vec![repo.to_string_lossy().into_owned()];
    if let Ok(real) = fs::canonicalize(repo) {
        let real = real.to_string_lossy().into_owned();
        if !paths.contains(&real) {
            paths.push(real);
        }
    }
    let refused = |line: &str| {
        line.contains("operation not permitted")
            || line.contains("EPERM")
            || line.contains("EACCES")
            || line.contains("permission denied")
    };
    log.lines()
        .any(|line| refused(line) && paths.iter().any(|p| line.contains(p.as_str())))
        .then(|| refused_message(repo))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn repo() -> PathBuf {
        PathBuf::from("/Users/me/Documents/work/GalacticAgents")
    }

    #[test]
    fn the_message_says_what_happened_where_to_allow_it_and_to_reopen() {
        let m = refused_message(&repo());
        assert!(m.contains("macOS refused GalacticAgents access"));
        assert!(m.contains("/Users/me/Documents/work/GalacticAgents"));
        assert!(m.contains("Privacy & Security → Files and Folders → GalacticAgents"));
        assert!(m.contains("Documents Folder"));
        assert!(m.contains("quit and open GalacticAgents again"));
    }

    #[test]
    fn a_refused_read_in_the_helpers_log_is_recognised() {
        // What Node printed when Cosmin refused the prompt (2026-10-22).
        let log = "Error: Cannot read package config \
                   /Users/me/Documents/work/GalacticAgents/package.json: operation not permitted.\n\
                   code: 'ERR_INVALID_PACKAGE_CONFIG'";
        assert_eq!(failure_from_log(log, &repo()), Some(refused_message(&repo())));
        let eperm = "Error: EPERM: operation not permitted, open \
                     '/Users/me/Documents/work/GalacticAgents/apps/desktop/dist/main.js'";
        assert!(failure_from_log(eperm, &repo()).is_some());
    }

    #[test]
    fn other_helper_failures_keep_the_usual_message() {
        assert_eq!(failure_from_log("Error: listen EADDRINUSE 127.0.0.1:4321", &repo()), None);
        assert_eq!(failure_from_log("", &repo()), None);
        // A refusal about some other folder (an agent's workspace) is not the app's own.
        assert_eq!(
            failure_from_log("EPERM: operation not permitted, open '/Volumes/x/y'", &repo()),
            None
        );
    }

    #[test]
    fn the_refusal_and_the_project_path_must_be_on_one_line() {
        // A permissions error elsewhere, with the project named on another line, is not a refusal.
        let log = "Error: EACCES: permission denied, open '/Volumes/x/db.sqlite'\n\
                   at /Users/me/Documents/work/GalacticAgents/apps/server/dist/index.js:1";
        assert_eq!(failure_from_log(log, &repo()), None);
    }

    #[test]
    fn the_projects_real_path_counts_too() {
        let dir = std::env::temp_dir().join(format!("galactic-access-real-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let real = fs::canonicalize(&dir).unwrap();
        let log = format!("Error: EPERM: operation not permitted, open '{}/package.json'", real.display());
        assert!(failure_from_log(&log, &dir).is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_readable_project_passes_and_a_missing_one_is_left_to_the_usual_checks() {
        let dir = std::env::temp_dir().join(format!("galactic-access-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(check_readable(&dir), Ok(())); // no package.json: not a refusal
        fs::write(dir.join("package.json"), "{}").unwrap();
        assert_eq!(check_readable(&dir), Ok(()));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_permission_errors_count_as_a_refusal() {
        assert!(is_refusal(&io::Error::from_raw_os_error(1))); // EPERM
        assert!(is_refusal(&io::Error::from_raw_os_error(13))); // EACCES
        assert!(!is_refusal(&io::Error::from(io::ErrorKind::NotFound)));
    }
}
