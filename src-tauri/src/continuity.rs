//! Locates the bundled continuity plugin (vendored under `resources/continuity-plugin`)
//! so later work can pass `claude --plugin-dir <that dir>` when spawning sessions.

use std::path::PathBuf;
use tauri::Manager; // for app.path()

/// Absolute path to the bundled continuity plugin directory. Tries the packaged resource dir
/// first, then falls back to the in-repo source dir (dev / `pnpm tauri dev`, where the resource
/// may not be staged). Returns None if neither has the expected entrypoint.
pub fn continuity_asset_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    // Packaged: `bundle.resources` in tauri.conf.json is array-notation
    // (`"resources/continuity-plugin/**/*"`), which Tauri v2 stages by reconstructing the
    // *original relative path* under $RESOURCE — i.e. `$RESOURCE/resources/continuity-plugin/...`,
    // not `$RESOURCE/continuity-plugin/...`. See
    // https://v2.tauri.app/develop/resources/#source-path-syntax ("array notation" vs. map
    // notation with an explicit target). Try that shape first, then the flattened shape as a
    // defensive fallback in case bundling behavior differs across Tauri versions/platforms.
    for candidate in ["resources/continuity-plugin", "continuity-plugin"] {
        if let Ok(p) = app
            .path()
            .resolve(candidate, tauri::path::BaseDirectory::Resource)
        {
            if p.join("mcp").join("launch.mjs").exists() {
                return Some(p);
            }
        }
    }
    // Dev fallback: the source tree.
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("continuity-plugin");
    if dev.join("mcp").join("launch.mjs").exists() {
        return Some(dev);
    }
    None
}

/// Parse `node --version` ("v22.5.0", "v24.1.0", "v20.11.1") into (major, minor).
pub fn parse_node_version(s: &str) -> Option<(u32, u32)> {
    let s = s.trim().trim_start_matches('v');
    let mut it = s.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    Some((major, minor))
}

/// node:sqlite requires Node >= 22.5.
pub fn node_supports_sqlite(v: (u32, u32)) -> bool {
    v.0 > 22 || (v.0 == 22 && v.1 >= 5)
}

/// Continuity is enabled for a spawn iff: a board-enabled project, a real (non-shell) Claude
/// session, and Node supports node:sqlite. Pure so it's unit-testable.
pub fn continuity_enabled(
    board_enabled: bool,
    is_claude: bool,
    shell_only: bool,
    node: Option<(u32, u32)>,
) -> bool {
    board_enabled && is_claude && !shell_only && node.map(node_supports_sqlite).unwrap_or(false)
}

/// Run `node --version` and parse it; None if node is missing/unparseable. Scrubs
/// npm_config_prefix like the other spawn sites (nvm-on-PATH robustness).
pub fn detect_node() -> Option<(u32, u32)> {
    use crate::NoWindow; // the CREATE_NO_WINDOW trait used elsewhere
    let out = std::process::Command::new("node")
        .arg("--version")
        .env_remove("npm_config_prefix")
        .no_window()
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_node_version(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(test)]
mod probe_tests {
    use super::*;
    #[test]
    fn parses_and_gates() {
        assert_eq!(parse_node_version("v22.5.0"), Some((22, 5)));
        assert_eq!(parse_node_version("v24.1.0"), Some((24, 1)));
        assert!(node_supports_sqlite((22, 5)));
        assert!(!node_supports_sqlite((22, 4)));
        assert!(!node_supports_sqlite((20, 11)));
        assert_eq!(parse_node_version("garbage"), None);
    }
    #[test]
    fn continuity_gate() {
        assert!(continuity_enabled(true, true, false, Some((22, 5))));
        assert!(!continuity_enabled(false, true, false, Some((24, 0)))); // board off
        assert!(!continuity_enabled(true, false, false, Some((24, 0)))); // not claude
        assert!(!continuity_enabled(true, true, true, Some((24, 0)))); // shell
        assert!(!continuity_enabled(true, true, false, None)); // node absent
        assert!(!continuity_enabled(true, true, false, Some((22, 4)))); // node too old
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vendored_plugin_is_present_in_source_tree() {
        // The dev fallback path must exist in the repo (the bundled asset).
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/continuity-plugin");
        assert!(
            dev.join("mcp/launch.mjs").exists(),
            "missing vendored continuity launch.mjs"
        );
        assert!(
            dev.join("hooks/hooks.json").exists(),
            "missing vendored continuity hooks"
        );
        assert!(
            dev.join(".claude-plugin/plugin.json").exists(),
            "missing vendored plugin manifest"
        );
    }
}
