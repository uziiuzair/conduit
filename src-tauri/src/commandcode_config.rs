//! Reading and editing Command Code's own configuration from inside Conduit.
//!
//! Command Code keeps personal preferences in `~/.commandcode/config.json` -- the model, the
//! reasoning effort, and `featureModels`, which routes its OWN internal tasks (title
//! generation, compaction, vision) to cheap models. Its normal editing surface is the `/config`
//! slash command, which means you have to be inside a session to change what the next session
//! starts as.
//!
//! Conduit writes that file rather than shelling out to `--config`, for one reason: `--config`
//! is documented as setting a value for a RUN, and a settings panel that silently failed to
//! persist would be worse than no panel. Writing is therefore done the same careful way
//! `hooks::install_profile` writes settings.local.json:
//!
//! - the file is parsed, PATCHED, and re-serialized, so keys Conduit knows nothing about
//!   survive untouched;
//! - a one-time `.conduit-backup` is taken before the first write;
//! - a key set to null is REMOVED, which is how the UI expresses "go back to the default"
//!   without Conduit having to know what the default is.
//!
//! Conduit deliberately does NOT write `settings.json`. That is the project-scoped file a team
//! commits, and `hooks` inside it is already managed by the hook installer.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::{json, Map, Value};

/// The keys this panel owns. Anything else in the file is passed through untouched, and a
/// write naming a key outside this list is refused rather than trusted -- the command is
/// reachable from the webview, so the allowlist is the boundary, not the UI.
///
/// `featureModels` is an object rather than a scalar; it is merged key-by-key so setting one
/// feature's model cannot drop the rest.
const EDITABLE: &[&str] = &[
    "model",
    "reasoningEffort",
    "theme",
    "compactMode",
    "tasteLearning",
    "featureModels",
];

/// What the panel needs to render: where the file is, whether it exists yet, and the
/// current value of every key we own.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommandCodeConfig {
    pub path: String,
    pub exists: bool,
    /// Only the editable keys, so the UI cannot accidentally round-trip something it does
    /// not understand.
    pub values: Value,
}

/// One model Command Code can run, as reported by `--list-models`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandCodeModel {
    /// The full id to pass to `--model` (e.g. `moonshotai/kimi-k2.5`, `claude-sonnet-5`).
    pub id: String,
    /// The vendor's one-line description.
    pub description: String,
    /// The heading it appeared under ("Anthropic", "Open Source", ...), for grouping.
    pub category: String,
}

/// The `.commandcode` directory for an account, or the ambient one.
fn config_dir(account_config_dir: Option<&str>) -> Option<PathBuf> {
    match account_config_dir {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => dirs::home_dir().map(|h| h.join(".commandcode")),
    }
}

fn config_path(account_config_dir: Option<&str>) -> Option<PathBuf> {
    Some(config_dir(account_config_dir)?.join("config.json"))
}

/// Keep only the keys this panel owns.
fn editable_subset(root: &Value) -> Value {
    let mut out = Map::new();
    if let Some(obj) = root.as_object() {
        for k in EDITABLE {
            if let Some(v) = obj.get(*k) {
                out.insert((*k).to_string(), v.clone());
            }
        }
    }
    Value::Object(out)
}

/// Apply a patch to a config document.
///
/// Pure, so the merge rules are testable without touching anyone's real config -- which
/// matters more here than usual, because the failure mode of getting this wrong is
/// destroying settings Conduit does not even know the meaning of.
///
/// Rules:
/// - unknown keys in `root` are preserved;
/// - a key in `patch` that is not editable is IGNORED (not written);
/// - `null` removes the key, which is how "reset to default" is expressed;
/// - `featureModels` merges key-by-key rather than replacing, so setting one feature's
///   model does not silently clear the others. A null INSIDE it removes that one feature.
pub fn apply_patch(root: &Value, patch: &Value) -> Value {
    let mut out = root.as_object().cloned().unwrap_or_default();
    let Some(patch) = patch.as_object() else {
        return Value::Object(out);
    };
    for (k, v) in patch {
        if !EDITABLE.contains(&k.as_str()) {
            continue;
        }
        if k == "featureModels" {
            if v.is_null() {
                out.remove(k);
                continue;
            }
            let Some(incoming) = v.as_object() else {
                continue;
            };
            let mut merged = out
                .get(k)
                .and_then(|f| f.as_object())
                .cloned()
                .unwrap_or_default();
            for (fk, fv) in incoming {
                if fv.is_null() {
                    merged.remove(fk);
                } else {
                    merged.insert(fk.clone(), fv.clone());
                }
            }
            if merged.is_empty() {
                out.remove(k);
            } else {
                out.insert(k.clone(), Value::Object(merged));
            }
            continue;
        }
        if v.is_null() {
            out.remove(k);
        } else {
            out.insert(k.clone(), v.clone());
        }
    }
    Value::Object(out)
}

/// Split `--list-models` output into models.
///
/// The format is a run of sections: a bare heading line, then rows of
/// `<id><two-or-more spaces><description>`. Pure, because the alternative is a test that
/// needs Command Code installed and signed in.
///
/// Anything that is not a `id  description` row under a heading is ignored, which is what
/// drops the counted title, the trailing usage examples, and the docs link without matching
/// them by hand.
///
/// Checked against the real `--list-models` output of v1.32.1: 58 models across 8
/// categories, which is exactly the count the command prints in its own header, with no
/// spurious rows.
pub fn parse_models(out: &str) -> Vec<CommandCodeModel> {
    let mut models = Vec::new();
    let mut category = String::new();
    for line in out.lines() {
        let trimmed = line.trim_end();
        if trimmed.trim().is_empty() {
            continue;
        }
        // Indented or otherwise decorated lines are not part of the table.
        if trimmed.starts_with(' ') || trimmed.starts_with('\t') {
            continue;
        }
        match trimmed.split_once("  ") {
            // A row: an id, then whitespace, then prose.
            Some((id, rest)) => {
                let id = id.trim();
                let description = rest.trim();
                // The header line is "Available models  ·  58 models" -- an id never has a
                // space in it, and a real row always has a description.
                if id.is_empty() || description.is_empty() || id.contains(' ') {
                    continue;
                }
                // The trailing examples are real-looking rows ("cmdc --model kimi-k2.5"),
                // but they start with the binary name, which is never a model id.
                if id == "cmdc" || id == "cmd" || id.ends_with(':') {
                    continue;
                }
                models.push(CommandCodeModel {
                    id: id.to_string(),
                    description: description.to_string(),
                    category: category.clone(),
                });
            }
            // No double space: a section heading, as long as it is short and prose-free.
            None => {
                let t = trimmed.trim();
                if !t.contains(':') && t.split_whitespace().count() <= 3 {
                    category = t.to_string();
                }
            }
        }
    }
    models
}

/// Tauri command: read the Command Code config for an account (None = ambient).
#[tauri::command]
pub fn command_code_config(account_config_dir: Option<String>) -> CommandCodeConfig {
    let Some(path) = config_path(account_config_dir.as_deref()) else {
        return CommandCodeConfig::default();
    };
    let raw = std::fs::read_to_string(&path).ok();
    let parsed: Value = raw
        .as_deref()
        .and_then(|r| serde_json::from_str(r).ok())
        .unwrap_or_else(|| json!({}));
    CommandCodeConfig {
        path: path.to_string_lossy().into_owned(),
        exists: raw.is_some(),
        values: editable_subset(&parsed),
    }
}

/// Tauri command: patch the Command Code config. Returns the config as it now reads.
#[tauri::command]
pub fn set_command_code_config(
    account_config_dir: Option<String>,
    patch: Value,
) -> Result<CommandCodeConfig, String> {
    let path = config_path(account_config_dir.as_deref())
        .ok_or_else(|| "no home directory".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let raw = std::fs::read_to_string(&path).ok();
    // Back up ONCE, before the first write, and only when there was something to lose.
    if let Some(existing) = raw.as_deref() {
        let backup = path.with_extension("json.conduit-backup");
        if !backup.exists() {
            let _ = std::fs::write(&backup, existing);
        }
    }
    let parsed: Value = raw
        .as_deref()
        .and_then(|r| serde_json::from_str(r).ok())
        .unwrap_or_else(|| json!({}));
    // A file that exists but does not parse is NOT overwritten: it is someone's config in a
    // state we do not understand, and clobbering it would be the one unrecoverable outcome.
    if raw.is_some() && serde_json::from_str::<Value>(raw.as_deref().unwrap_or("")).is_err() {
        return Err(format!(
            "{} is not valid JSON; fix or move it before editing from Conduit",
            path.display()
        ));
    }
    let next = apply_patch(&parsed, &patch);
    let body = serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(command_code_config(account_config_dir))
}

/// Tauri command: the models this install can run, via `--list-models`.
///
/// Shells out through the platform's agent-launching shell for the same reason
/// `detect_agents` does: a GUI-launched app's PATH does not include nvm/Homebrew, so
/// spawning the binary directly would report "no models" on a machine that has plenty.
#[tauri::command]
pub async fn command_code_models() -> Result<Vec<CommandCodeModel>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        use crate::NoWindow;
        use std::process::Command;
        let bin = crate::agent::COMMAND_CODE_BIN;
        let cmd = format!("{bin} --list-models");
        #[cfg(windows)]
        let out = {
            let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
            Command::new(shell)
                .args(["/C", &cmd])
                .env_remove("npm_config_prefix")
                .no_window()
                .output()
        };
        #[cfg(not(windows))]
        let out = {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
            Command::new(shell)
                .args(["-i", "-l", "-c", &cmd])
                .env_remove("npm_config_prefix")
                .no_window()
                .output()
        };
        let out = out.map_err(|e| format!("spawn {bin}: {e}"))?;
        if !out.status.success() {
            return Err(format!("{bin} --list-models failed"));
        }
        Ok(parse_models(&String::from_utf8_lossy(&out.stdout)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "Available models  \u{b7}  58 models\n\
        \n\
        Open Source\n\
        \n\
        deepseek/deepseek-v4-flash             fast hybrid-attention reasoning (default)\n\
        moonshotai/kimi-k3                     long-horizon coding with 1M context\n\
        \n\
        Anthropic\n\
        \n\
        claude-sonnet-5                        best combo of speed & intelligence (recommended)\n\
        claude-haiku-4-5                       fastest & most compact, great for quick tasks\n\
        \n\
        Pass the full id, or just the short name after the last \"/\":\n\
        cmdc --model moonshotai/kimi-k2.5\n\
        \n\
        Docs:  https://commandcode.ai/docs/reference/cli/models\n";

    #[test]
    fn models_are_parsed_with_their_category() {
        let m = parse_models(SAMPLE);
        assert_eq!(m.len(), 4, "got {m:?}");
        assert_eq!(m[0].id, "deepseek/deepseek-v4-flash");
        assert_eq!(m[0].category, "Open Source");
        assert_eq!(
            m[0].description,
            "fast hybrid-attention reasoning (default)"
        );
        assert_eq!(m[2].id, "claude-sonnet-5");
        assert_eq!(m[2].category, "Anthropic");
    }

    #[test]
    fn the_chrome_around_the_table_is_not_a_model() {
        let models = parse_models(SAMPLE);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        // The counted title, the usage example, and the docs link all superficially look
        // like `id  description` rows.
        assert!(!ids.contains(&"Available"), "title row");
        assert!(!ids.contains(&"cmdc"), "usage example");
        assert!(!ids.contains(&"Docs:"), "docs link");
        assert!(
            !ids.iter().any(|i| i.contains(' ')),
            "ids never contain spaces"
        );
    }

    #[test]
    fn empty_or_broken_output_yields_no_models_rather_than_junk() {
        assert!(parse_models("").is_empty());
        assert!(parse_models("Not authenticated. Please login.").is_empty());
    }

    #[test]
    fn patch_preserves_keys_conduit_does_not_know() {
        let root =
            json!({ "model": "old", "somethingElse": { "deep": 1 }, "collapsePastedText": true });
        let next = apply_patch(&root, &json!({ "model": "claude-sonnet-5" }));
        assert_eq!(next["model"], "claude-sonnet-5");
        assert_eq!(next["somethingElse"]["deep"], 1);
        assert_eq!(next["collapsePastedText"], true);
    }

    #[test]
    fn patch_refuses_keys_outside_the_allowlist() {
        // The command is reachable from the webview, so the allowlist is a boundary rather
        // than a UI convention. `hooks` in particular is owned by the hook installer.
        let next = apply_patch(
            &json!({}),
            &json!({ "hooks": { "Stop": [] }, "apiKey": "x" }),
        );
        assert!(next.get("hooks").is_none());
        assert!(next.get("apiKey").is_none());
    }

    #[test]
    fn null_removes_a_key_so_the_default_comes_back() {
        let root = json!({ "model": "pinned", "theme": "dark" });
        let next = apply_patch(&root, &json!({ "model": null }));
        assert!(next.get("model").is_none(), "reset to default");
        assert_eq!(next["theme"], "dark", "unrelated keys untouched");
    }

    #[test]
    fn feature_models_merge_instead_of_replacing() {
        let root = json!({
            "featureModels": { "titleGeneration": "a", "compaction": "b" }
        });
        // Setting ONE feature must not clear the others -- replacing the object wholesale
        // is the obvious implementation and the wrong one.
        let next = apply_patch(&root, &json!({ "featureModels": { "compaction": "c" } }));
        assert_eq!(next["featureModels"]["titleGeneration"], "a");
        assert_eq!(next["featureModels"]["compaction"], "c");

        // A null inside removes just that feature...
        let cleared = apply_patch(&next, &json!({ "featureModels": { "compaction": null } }));
        assert!(cleared["featureModels"].get("compaction").is_none());
        assert_eq!(cleared["featureModels"]["titleGeneration"], "a");

        // ...and emptying it entirely drops the key rather than leaving `{}` behind.
        let empty = apply_patch(
            &cleared,
            &json!({ "featureModels": { "titleGeneration": null } }),
        );
        assert!(empty.get("featureModels").is_none());
    }

    #[test]
    fn editable_subset_hides_everything_else() {
        let v = editable_subset(&json!({ "model": "m", "apiKey": "secret", "provider": "p" }));
        assert_eq!(v["model"], "m");
        // An api key lives in auth.json, but a config file that had one must not be
        // round-tripped through the webview.
        assert!(v.get("apiKey").is_none());
        assert!(v.get("provider").is_none());
    }
}
