//! Format Document: pipe the BUFFER (never the file on disk) through the project's
//! own formatter — prettier / rustfmt / gofmt — stdin to stdout, so unsaved changes
//! survive and the frontend can apply the result as one undo-preserving edit.
//! Read-only with respect to the filesystem.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FormatResult {
    pub formatted: String,
    /// Which tool ran, for the toast ("prettier" | "rustfmt" | "gofmt").
    pub formatter: String,
}

/// A subset of prettier's config, all optional — the eight options Conduit's bundled
/// fallback honors. camelCase matches both prettier's own keys and the frontend option
/// names, so it round-trips to the renderer with no remapping.
#[derive(Serialize, Deserialize, Default, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PrettierConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub print_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_tabs: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semi: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub single_quote: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trailing_comma: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bracket_spacing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_of_line: Option<String>,
}

/// Parse a `.prettierrc`/`.prettierrc.json`/`.prettierrc.yaml` body. `.prettierrc` may be
/// either JSON or YAML, so try JSON first, then YAML. Unknown keys are ignored by serde.
/// Returns None on parse failure (caller falls through to global config).
fn parse_config_str(s: &str) -> Option<PrettierConfig> {
    if let Ok(c) = serde_json::from_str::<PrettierConfig>(s) {
        return Some(c);
    }
    serde_yaml::from_str::<PrettierConfig>(s).ok()
}

/// Pull a `"prettier"` object out of a package.json body. A string value points to an
/// external config file — v1 skips that (returns None). No `"prettier"` key → None.
fn extract_package_prettier(s: &str) -> Option<PrettierConfig> {
    let v: serde_json::Value = serde_json::from_str(s).ok()?;
    let p = v.get("prettier")?;
    if p.is_object() {
        serde_json::from_value::<PrettierConfig>(p.clone()).ok()
    } else {
        None
    }
}

const PRETTIER_CONFIG_NAMES: &[&str] = &[
    ".prettierrc",
    ".prettierrc.json",
    ".prettierrc.yaml",
    ".prettierrc.yml",
];

/// Walk up from the file looking for the nearest static prettier config (prettier's own
/// upward search). First hit wins. `.prettierrc.js`/`prettier.config.js` are ignored —
/// they can't be read without executing them. Returns None when nothing is found.
pub fn resolve_prettier_config(path: &Path) -> Option<PrettierConfig> {
    let mut dir = path.parent()?;
    loop {
        for name in PRETTIER_CONFIG_NAMES {
            let f = dir.join(name);
            if f.is_file() {
                if let Ok(body) = std::fs::read_to_string(&f) {
                    if let Some(c) = parse_config_str(&body) {
                        return Some(c);
                    }
                }
            }
        }
        let pkg = dir.join("package.json");
        if pkg.is_file() {
            if let Ok(body) = std::fs::read_to_string(&pkg) {
                if let Some(c) = extract_package_prettier(&body) {
                    return Some(c);
                }
            }
        }
        dir = dir.parent()?;
    }
}

const PRETTIER_EXTS: &[&str] = &[
    "js", "jsx", "ts", "tsx", "mjs", "cjs", "json", "jsonc", "css", "scss", "less", "html", "vue",
    "md", "markdown", "yaml", "yml",
];

/// Walk up from the file toward the root looking for the project-local prettier
/// binary — the project's own version + config always beats a global install.
fn local_prettier(from: &Path) -> Option<PathBuf> {
    let bin = if cfg!(windows) {
        "prettier.cmd"
    } else {
        "prettier"
    };
    let mut dir = from.parent()?;
    loop {
        let candidate = dir.join("node_modules").join(".bin").join(bin);
        if candidate.is_file() {
            return Some(candidate);
        }
        match dir.parent() {
            Some(p) => dir = p,
            None => return None,
        }
    }
}

/// Resolve a tool through the user's login shell on unix — a GUI-launched app's
/// PATH misses nvm/homebrew dirs (same problem `detect_agents` solves). Windows GUI
/// apps inherit the user PATH, so the plain name is used there.
fn resolve_on_path(tool: &str) -> Option<PathBuf> {
    if cfg!(windows) {
        return Some(PathBuf::from(tool));
    }
    use crate::NoWindow;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = Command::new(shell)
        .args(["-lc", &format!("command -v {tool}")])
        .no_window()
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(PathBuf::from(path))
    }
}

/// Pipe `content` through `cmd args`, cwd `dir`. Nonzero exit surfaces stderr —
/// for prettier that's a real syntax-error message worth showing the user.
fn pipe_through(cmd: &Path, args: &[&str], dir: &str, content: &str) -> Result<String, String> {
    use crate::NoWindow;
    let mut child = Command::new(cmd)
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_window()
        .spawn()
        .map_err(|e| format!("failed to run {}: {e}", cmd.display()))?;
    // Scope the handle so stdin closes and the formatter sees EOF.
    {
        let mut stdin = child.stdin.take().ok_or("no stdin")?;
        stdin
            .write_all(content.as_bytes())
            .map_err(|e| format!("write to formatter: {e}"))?;
    }
    let out = child
        .wait_with_output()
        .map_err(|e| format!("formatter: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if err.is_empty() {
            format!("formatter exited with {}", out.status)
        } else {
            err
        })
    }
}

/// Which formatter handles `path`, if any. Pure for unit tests.
pub fn formatter_for(path: &str) -> Option<&'static str> {
    let ext = Path::new(path).extension()?.to_str()?.to_lowercase();
    if PRETTIER_EXTS.contains(&ext.as_str()) {
        Some("prettier")
    } else if ext == "rs" {
        Some("rustfmt")
    } else if ext == "go" {
        Some("gofmt")
    } else {
        None
    }
}

pub fn format_content(dir: &str, path: &str, content: &str) -> Result<FormatResult, String> {
    let formatter =
        formatter_for(path).ok_or_else(|| "no formatter for this file type".to_string())?;
    match formatter {
        "prettier" => {
            let bin = local_prettier(Path::new(path))
                .or_else(|| resolve_on_path("prettier"))
                .ok_or("prettier not found (install it in the project or on PATH)")?;
            let formatted = pipe_through(&bin, &["--stdin-filepath", path], dir, content)?;
            Ok(FormatResult {
                formatted,
                formatter: "prettier".into(),
            })
        }
        "rustfmt" => {
            let bin = resolve_on_path("rustfmt").ok_or("rustfmt not found on PATH")?;
            let formatted = pipe_through(&bin, &["--edition", "2021"], dir, content)?;
            Ok(FormatResult {
                formatted,
                formatter: "rustfmt".into(),
            })
        }
        "gofmt" => {
            let bin = resolve_on_path("gofmt").ok_or("gofmt not found on PATH")?;
            let formatted = pipe_through(&bin, &[], dir, content)?;
            Ok(FormatResult {
                formatted,
                formatter: "gofmt".into(),
            })
        }
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formatter_selection_by_extension() {
        assert_eq!(formatter_for("/p/a.tsx"), Some("prettier"));
        assert_eq!(formatter_for("/p/a.MD"), Some("prettier"));
        assert_eq!(formatter_for("/p/lib.rs"), Some("rustfmt"));
        assert_eq!(formatter_for("/p/main.go"), Some("gofmt"));
        assert_eq!(formatter_for("/p/session.pty"), None);
        assert_eq!(formatter_for("/p/Makefile"), None);
    }

    #[test]
    fn parse_json_prettierrc() {
        let c = parse_config_str(r#"{ "printWidth": 100, "singleQuote": true }"#).unwrap();
        assert_eq!(c.print_width, Some(100));
        assert_eq!(c.single_quote, Some(true));
        assert_eq!(c.tab_width, None);
    }

    #[test]
    fn parse_yaml_prettierrc() {
        let c = parse_config_str("printWidth: 120\nuseTabs: true\n").unwrap();
        assert_eq!(c.print_width, Some(120));
        assert_eq!(c.use_tabs, Some(true));
    }

    #[test]
    fn parse_garbage_is_none() {
        assert!(parse_config_str("this: : : not valid {").is_none());
    }

    #[test]
    fn package_json_prettier_object() {
        let c =
            extract_package_prettier(r#"{ "name": "x", "prettier": { "semi": false } }"#).unwrap();
        assert_eq!(c.semi, Some(false));
    }

    #[test]
    fn package_json_prettier_string_ref_is_none() {
        // A string value points to an external config file — v1 skips it.
        assert!(extract_package_prettier(r#"{ "prettier": "./my-config.json" }"#).is_none());
    }

    #[test]
    fn package_json_without_prettier_is_none() {
        assert!(extract_package_prettier(r#"{ "name": "x" }"#).is_none());
    }
}
