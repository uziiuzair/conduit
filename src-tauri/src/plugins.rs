//! What a plugin is and how the OS sees it: the manifest model, validation,
//! persisted `PluginRecord`, and the Tauri command surface for discovery and
//! lifecycle. Pure parsing/validation stays free-function + unit-tested; the
//! commands are thin wrappers over the store and filesystem.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

/// What the frontend sees for one discovered plugin folder.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginDescriptor {
    pub id: String,
    pub path: String,
    /// Present when the manifest parsed. `None` when parse failed (see `problems`).
    pub manifest: Option<PluginManifest>,
    /// Validation problems (empty when valid). Non-empty ⇒ cannot enable.
    pub problems: Vec<String>,
    pub record: Option<PluginRecord>,
}

/// The plugins directory: `<data_dir>/plugins`. Created if missing.
pub fn plugins_dir() -> PathBuf {
    let dir = crate::store::data_dir().join("plugins");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Permission ids valid in increment #1. Unknown ids are rejected at validation.
pub const KNOWN_PERMISSIONS: &[&str] = &[
    "commands",
    "hooks:session",
    "hooks:fleet",
    "hooks:lifecycle",
    "notifications",
    "clipboard:write",
    "net",
];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommandContribution {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hotkey: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Contributes {
    #[serde(default)]
    pub commands: Vec<CommandContribution>,
    #[serde(default)]
    pub hooks: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub description: String,
    pub min_app_version: String,
    #[serde(default = "default_main")]
    pub main: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub contributes: Contributes,
}

fn default_main() -> String {
    "main.js".to_string()
}

/// True if a manifest `main` path stays inside the plugin folder (no `..` escape,
/// not absolute). Shared by `validate_manifest` and `read_plugin_source` so the
/// two checks can never drift.
fn main_path_is_safe(main: &str) -> bool {
    !main.contains("..") && !main.starts_with('/')
}

/// Parse manifest JSON. Returns the manifest or a human-readable error.
pub fn parse_manifest(json: &str) -> Result<PluginManifest, String> {
    serde_json::from_str::<PluginManifest>(json).map_err(|e| format!("invalid manifest.json: {e}"))
}

pub fn is_valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let ok = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-';
    let edge = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    edge(bytes[0]) && edge(bytes[bytes.len() - 1]) && bytes.iter().all(|&c| ok(c))
}

/// Parse "a.b.c" into (u64,u64,u64); trailing junk / missing parts default to 0.
fn semver_triple(v: &str) -> Option<(u64, u64, u64)> {
    let mut it = v.split('.').map(|p| {
        p.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u64>()
            .ok()
    });
    let a = it.next()??;
    let b = it.next().flatten().unwrap_or(0);
    let c = it.next().flatten().unwrap_or(0);
    Some((a, b, c))
}

/// True if `have` (semver) >= `need` (semver). Non-semver `have` counts as satisfied
/// (dev builds); non-semver `need` is a validation error handled by the caller.
pub fn version_satisfies(have: &str, need: &str) -> bool {
    match (semver_triple(have), semver_triple(need)) {
        (Some(h), Some(n)) => h >= n,
        (None, _) => true, // non-semver dev build: treat as satisfied
        (_, None) => true, // caller separately flags a bad need
    }
}

/// Validate a parsed manifest against the folder name + the current app version.
/// Returns the list of problems (empty = valid).
pub fn validate_manifest(m: &PluginManifest, folder_name: &str, app_version: &str) -> Vec<String> {
    let mut problems = Vec::new();
    if !is_valid_id(&m.id) {
        problems.push(format!(
            "invalid plugin id '{}': must be lowercase [a-z0-9.-]",
            m.id
        ));
    }
    if m.id != folder_name {
        problems.push(format!(
            "plugin id '{}' must equal its folder name '{}'",
            m.id, folder_name
        ));
    }
    if semver_triple(&m.version).is_none() {
        problems.push(format!("invalid version '{}'", m.version));
    }
    if semver_triple(&m.min_app_version).is_none() {
        problems.push(format!("invalid minAppVersion '{}'", m.min_app_version));
    } else if !version_satisfies(app_version, &m.min_app_version) {
        problems.push(format!(
            "requires Conduit >= {} (this is {})",
            m.min_app_version, app_version
        ));
    }
    if !main_path_is_safe(&m.main) {
        problems.push(format!(
            "main '{}' must stay inside the plugin folder",
            m.main
        ));
    }
    for perm in &m.permissions {
        if !KNOWN_PERMISSIONS.contains(&perm.as_str()) {
            problems.push(format!("unknown permission '{}'", perm));
        }
    }
    for hook in &m.contributes.hooks {
        let group = hook.split('.').next().unwrap_or("");
        let need = format!("hooks:{group}");
        if !m.permissions.iter().any(|p| p == &need) {
            problems.push(format!("hook '{}' requires permission '{}'", hook, need));
        }
    }
    problems
}

/// Persisted per-plugin state. No secrets here.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecord {
    pub id: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub granted_permissions: Vec<String>,
    /// The manifest version the user last consented to (for escalation detection).
    #[serde(default)]
    pub consented_version: String,
}

fn read_descriptor(dir: &Path, records: &[PluginRecord]) -> Option<PluginDescriptor> {
    let folder = dir.file_name()?.to_string_lossy().to_string();
    let manifest_path = dir.join("manifest.json");
    let raw = std::fs::read_to_string(&manifest_path).ok()?;
    let path = dir.to_string_lossy().to_string();
    match parse_manifest(&raw) {
        Ok(m) => {
            let problems = validate_manifest(&m, &folder, env!("CARGO_PKG_VERSION"));
            let record = records.iter().find(|r| r.id == m.id).cloned();
            Some(PluginDescriptor {
                id: m.id.clone(),
                path,
                manifest: Some(m),
                problems,
                record,
            })
        }
        Err(e) => Some(PluginDescriptor {
            id: folder,
            path,
            manifest: None,
            problems: vec![e],
            record: None,
        }),
    }
}

#[tauri::command]
pub fn list_plugins(store: State<'_, Arc<crate::store::Store>>) -> Vec<PluginDescriptor> {
    let records = store.list_plugins();
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(plugins_dir()) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                if let Some(d) = read_descriptor(&p, &records) {
                    out.push(d);
                }
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Return the plugin's `main.js` source, guarding against path escape.
#[tauri::command]
pub fn read_plugin_source(id: String) -> Result<String, String> {
    if !is_valid_id(&id) {
        return Err("invalid plugin id".into());
    }
    let dir = plugins_dir().join(&id);
    let manifest_raw =
        std::fs::read_to_string(dir.join("manifest.json")).map_err(|e| e.to_string())?;
    let m = parse_manifest(&manifest_raw)?;
    if !main_path_is_safe(&m.main) {
        return Err("main path escapes plugin folder".into());
    }
    std::fs::read_to_string(dir.join(&m.main)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_plugin_enabled(
    id: String,
    enabled: bool,
    store: State<'_, Arc<crate::store::Store>>,
) -> Result<(), String> {
    if !is_valid_id(&id) {
        return Err("invalid plugin id".into());
    }
    store.update_plugin_record(&id, |r| r.enabled = enabled);
    Ok(())
}

#[tauri::command]
pub fn set_plugin_grants(
    id: String,
    permissions: Vec<String>,
    consented_version: String,
    store: State<'_, Arc<crate::store::Store>>,
) -> Result<(), String> {
    if !is_valid_id(&id) {
        return Err("invalid plugin id".into());
    }
    // Defense in depth: only persist ids we recognize, so a bad caller can't
    // stash arbitrary permission strings that some future code path might trust.
    let permissions: Vec<String> = permissions
        .into_iter()
        .filter(|p| KNOWN_PERMISSIONS.contains(&p.as_str()))
        .collect();
    store.update_plugin_record(&id, |r| {
        r.granted_permissions = permissions;
        r.consented_version = consented_version;
    });
    Ok(())
}

#[tauri::command]
pub fn remove_plugin(id: String, store: State<'_, Arc<crate::store::Store>>) -> Result<(), String> {
    if !is_valid_id(&id) {
        return Err("invalid plugin id".into());
    }
    let dir = plugins_dir().join(&id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    store.remove_plugin_record(&id);
    Ok(())
}

#[tauri::command]
pub fn open_plugins_dir() -> Result<String, String> {
    Ok(plugins_dir().to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good() -> PluginManifest {
        parse_manifest(
            r#"{"id":"com.acme.logger","name":"Logger","version":"1.0.0",
                "minAppVersion":"0.14.0","permissions":["hooks:session"],
                "contributes":{"hooks":["session.start"]}}"#,
        )
        .unwrap()
    }

    #[test]
    fn parses_camelcase_min_app_version() {
        let m = good();
        assert_eq!(m.min_app_version, "0.14.0");
        assert_eq!(m.main, "main.js"); // default applied
    }

    #[test]
    fn valid_manifest_has_no_problems() {
        assert!(validate_manifest(&good(), "com.acme.logger", "0.14.0").is_empty());
    }

    #[test]
    fn id_must_match_folder() {
        let p = validate_manifest(&good(), "com.acme.OTHER", "0.14.0");
        assert!(p.iter().any(|s| s.contains("folder")));
    }

    #[test]
    fn rejects_bad_id() {
        assert!(!is_valid_id("Com.Acme")); // uppercase
        assert!(!is_valid_id("-lead"));
        assert!(is_valid_id("com..acme")); // still matches charset; ok to allow — only charset checked
        assert!(is_valid_id("com.acme.logger"));
    }

    #[test]
    fn rejects_unknown_permission() {
        let mut m = good();
        m.permissions = vec!["hooks:session".into(), "read:everything".into()];
        let p = validate_manifest(&m, "com.acme.logger", "0.14.0");
        assert!(p.iter().any(|s| s.contains("read:everything")));
    }

    #[test]
    fn rejects_hook_without_permission() {
        let mut m = good();
        m.permissions = vec![]; // declares a hook but not hooks:session
        m.contributes.hooks = vec!["session.start".into()];
        let p = validate_manifest(&m, "com.acme.logger", "0.14.0");
        assert!(p.iter().any(|s| s.contains("session.start")));
    }

    #[test]
    fn rejects_incompatible_app_version() {
        let p = validate_manifest(&good(), "com.acme.logger", "0.13.0");
        assert!(p
            .iter()
            .any(|s| s.contains("minAppVersion") || s.contains("0.14.0")));
    }

    #[test]
    fn version_satisfies_basic() {
        assert!(version_satisfies("0.14.0", "0.14.0"));
        assert!(version_satisfies("0.15.2", "0.14.0"));
        assert!(!version_satisfies("0.13.9", "0.14.0"));
        assert!(version_satisfies("dev", "0.14.0")); // non-semver dev build passes
    }

    #[test]
    fn descriptor_problems_block_enable_semantics() {
        let m =
            parse_manifest(r#"{"id":"x","name":"x","version":"1.0.0","minAppVersion":"9.9.9"}"#)
                .unwrap();
        let problems = validate_manifest(&m, "x", "0.14.0");
        assert!(!problems.is_empty()); // future-version requirement blocks it
    }
}
