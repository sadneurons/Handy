use crate::TranscriptionCoordinator;
#[cfg(unix)]
use log::debug;
use log::warn;
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
use signal_hook::consts::SIGUSR1;
#[cfg(unix)]
use signal_hook::consts::SIGUSR2;
#[cfg(unix)]
use signal_hook::iterator::Signals;
#[cfg(unix)]
use std::thread;

/// Send a transcription input to the coordinator.
/// Used by signal handlers, CLI flags, and any other external trigger.
pub fn send_transcription_input(app: &AppHandle, binding_id: &str, source: &str) {
    if let Some(c) = app.try_state::<TranscriptionCoordinator>() {
        c.send_external_input(binding_id, source);
    } else {
        warn!("TranscriptionCoordinator not initialized");
    }
}

/// Value of `--dictionary X` or `--dictionary=X` in a raw argv, if present.
pub fn dictionary_arg(args: &[String]) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--dictionary" {
            return iter.next().cloned();
        }
        if let Some(value) = arg.strip_prefix("--dictionary=") {
            return Some(value.to_string());
        }
    }
    None
}

/// Switches the active replacement dictionary to the one `value` names (id
/// or case-insensitive name). Returns whether a switch happened; an unknown
/// value only logs a warning.
pub fn apply_dictionary_arg(app: &AppHandle, value: &str) -> bool {
    let settings = crate::settings::get_settings(app);
    let Some(id) = settings.resolve_dictionary(value).map(|d| d.id.clone()) else {
        warn!("--dictionary: no replacement dictionary named or identified by '{value}'");
        return false;
    };
    match crate::shortcut::set_active_dictionary_id(app, Some(id)) {
        Ok(()) => true,
        Err(e) => {
            warn!("--dictionary: {e}");
            false
        }
    }
}

/// Listen for Unix signals that remotely toggle transcription.
///
/// SIGUSR2 toggles plain transcription on all Unix platforms. SIGUSR1
/// (transcription with post-processing) is only handled on macOS: on Linux,
/// WebKitGTK's JavaScriptCore garbage collector sends SIGUSR1 to its own
/// threads to suspend them, so handling it caused phantom recordings on every
/// GC cycle (#1660). Linux users should use `handy --toggle-post-process`
/// instead.
#[cfg(unix)]
pub fn setup_signal_handler(app_handle: AppHandle) {
    #[cfg(target_os = "macos")]
    let mut signals =
        Signals::new([SIGUSR1, SIGUSR2]).expect("failed to register transcription signal handlers");
    #[cfg(not(target_os = "macos"))]
    let mut signals =
        Signals::new([SIGUSR2]).expect("failed to register transcription signal handlers");
    #[cfg(target_os = "macos")]
    debug!("Signal handlers registered (SIGUSR1, SIGUSR2)");
    #[cfg(not(target_os = "macos"))]
    debug!("Signal handler registered (SIGUSR2; SIGUSR1 is left to WebKitGTK)");
    thread::spawn(move || {
        for sig in signals.forever() {
            let (binding_id, signal_name) = match sig {
                #[cfg(target_os = "macos")]
                SIGUSR1 => ("transcribe_with_post_process", "SIGUSR1"),
                SIGUSR2 => ("transcribe", "SIGUSR2"),
                _ => continue,
            };
            debug!("Received {signal_name}");
            send_transcription_input(&app_handle, binding_id, signal_name);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::dictionary_arg;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_space_and_equals_forms() {
        assert_eq!(
            dictionary_arg(&args(&[
                "handy",
                "--dictionary",
                "creative",
                "--toggle-transcription"
            ])),
            Some("creative".to_string())
        );
        assert_eq!(
            dictionary_arg(&args(&["handy", "--dictionary=Clinical"])),
            Some("Clinical".to_string())
        );
    }

    #[test]
    fn absent_returns_none() {
        assert_eq!(
            dictionary_arg(&args(&["handy", "--toggle-transcription"])),
            None
        );
        assert_eq!(dictionary_arg(&args(&["handy", "--dictionary"])), None);
    }
}
