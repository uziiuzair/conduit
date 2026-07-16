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
