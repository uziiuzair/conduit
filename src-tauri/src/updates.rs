//! Auto-update helper logic. The `tauri-plugin-updater` plugin owns fetching the
//! manifest, comparing the running version, verifying the minisign signature, and
//! installing. The only decision that's ours: when the user clicked "Later" on a
//! version, don't re-notify until something strictly newer appears.

/// True if `candidate` is a strictly newer semver than `baseline`.
/// Tolerant: missing components count as 0; non-numeric junk on a component
/// counts as 0 so a malformed string never spuriously reads as "newer".
pub fn is_newer(candidate: &str, baseline: &str) -> bool {
    fn parts(v: &str) -> (u64, u64, u64) {
        let mut it = v
            .split('.')
            .map(|c| c.trim().parse::<u64>().unwrap_or(0));
        (
            it.next().unwrap_or(0),
            it.next().unwrap_or(0),
            it.next().unwrap_or(0),
        )
    }
    parts(candidate) > parts(baseline)
}

/// The frontend calls this after the plugin reports an available `remote` version.
/// Returns true if we should surface the notice: always, unless the user skipped
/// this-or-newer already.
#[tauri::command]
pub fn update_should_notify(remote_version: String, skipped_version: Option<String>) -> bool {
    match skipped_version {
        None => true,
        Some(skipped) => is_newer(&remote_version, &skipped),
    }
}

#[cfg(test)]
mod tests {
    use super::is_newer;

    #[test]
    fn compares_patch_minor_major() {
        assert!(is_newer("0.5.1", "0.5.0"));
        assert!(is_newer("0.6.0", "0.5.9"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(!is_newer("0.5.0", "0.5.0"));
        assert!(!is_newer("0.5.0", "0.5.1"));
    }

    #[test]
    fn tolerates_missing_components_and_junk() {
        assert!(is_newer("0.5", "0.4.9")); // "0.5" == 0.5.0 > 0.4.9
        assert!(!is_newer("0.5", "0.5.0")); // equal
        assert!(!is_newer("garbage", "0.0.1")); // junk → 0.0.0, not newer
        assert!(is_newer("0.0.2", "garbage")); // baseline junk → 0.0.0
    }
}
