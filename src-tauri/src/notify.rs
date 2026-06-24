//! Native notifications — ports Notifier.swift.
//!
//! On macOS we use `osascript`, which delivers a banner in *every* build — signed
//! or not — so notifications work in a locally-built unsigned app without a runtime
//! permission prompt. On other platforms we use the Tauri notification plugin.
//! (For a signed/notarized macOS distribution you may prefer the plugin for proper
//! app attribution; swap the macOS branch for `tauri-plugin-notification` then.)

#[cfg(target_os = "macos")]
pub fn send(_app: &tauri::AppHandle, title: &str, subtitle: Option<&str>, body: &str) {
    let mut script = format!(
        "display notification {} with title {}",
        quote(body),
        quote(title)
    );
    if let Some(s) = subtitle {
        if !s.is_empty() {
            script.push_str(&format!(" subtitle {}", quote(s)));
        }
    }
    let _ = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .spawn();
}

#[cfg(not(target_os = "macos"))]
pub fn send(app: &tauri::AppHandle, title: &str, subtitle: Option<&str>, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let full = match subtitle {
        Some(s) if !s.is_empty() => format!("{s} — {body}"),
        _ => body.to_string(),
    };
    let _ = app.notification().builder().title(title).body(full).show();
}

#[cfg(target_os = "macos")]
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}
