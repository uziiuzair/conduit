//! Local LLM server detection + model listing for the OpenCode local-provider feature.
//! HTTP via `curl` shell-out per the repo convention (no HTTP client dependency, see
//! claude_status.rs); parsing is pure and unit-tested; everything fails open — a probe
//! that errors just reports "not running" and never blocks the UI or a spawn.

use serde::Serialize;

use crate::NoWindow;

/// One detectable local inference server, as reported to the Settings UI.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LocalProviderStatus {
    /// Preset id ("ollama" | "lmstudio" | "vllm" | "llamacpp" | "openwebui").
    pub preset: &'static str,
    pub label: &'static str,
    /// The OpenAI-compatible base URL to prefill when this preset is picked.
    pub base_url: &'static str,
    pub running: bool,
    /// Human hint when running ("v0.30.10", "3 models", ...). Empty otherwise.
    pub detail: String,
    /// Whether this server requires an API key by default (OpenWebUI does).
    pub needs_key: bool,
}

/// A model the local server offers. `context` comes back only from servers that report
/// it (Ollama's /api/tags) and lets the UI autofill the context limit.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub id: String,
    pub context: Option<u64>,
    /// Extra hint for the picker ("30.5B · Q4_K_M"). Empty when unknown.
    pub detail: String,
}

/// GET a URL with a short timeout; optional Bearer auth. None on any failure.
fn curl(url: &str, bearer: Option<&str>, max_time_s: u32) -> Option<String> {
    let mut cmd = std::process::Command::new("curl");
    cmd.args(["-s", "--max-time", &max_time_s.to_string()]);
    if let Some(key) = bearer {
        cmd.args(["-H", &format!("Authorization: Bearer {key}")]);
    }
    cmd.arg(url);
    let out = cmd.no_window().output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

// ---- pure parsers --------------------------------------------------------------

/// Ollama GET /api/version → "v0.30.10".
fn parse_ollama_version(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    Some(format!("v{}", v.get("version")?.as_str()?))
}

/// OpenAI-compatible GET <base>/models → "N models". None when the body is not the
/// expected shape (which is how a random non-LLM service on the same port is rejected).
fn parse_openai_model_count(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let n = v.get("data")?.as_array()?.len();
    Some(format!("{n} model{}", if n == 1 { "" } else { "s" }))
}

/// OpenWebUI GET /api/config → "Open WebUI vX" (the `name` field identifies it).
fn parse_openwebui_config(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let name = v.get("name")?.as_str()?;
    if !name.eq_ignore_ascii_case("open webui") {
        return None;
    }
    match v.get("version").and_then(|x| x.as_str()) {
        Some(ver) => Some(format!("v{ver}")),
        None => Some("running".to_string()),
    }
}

/// Ollama GET /api/tags → models with context length + size/quant hints.
fn parse_ollama_tags(body: &str) -> Vec<LocalModel> {
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let models = match v.get("models").and_then(|m| m.as_array()) {
        Some(m) => m,
        None => return Vec::new(),
    };
    models
        .iter()
        .filter_map(|m| {
            let id = m.get("name")?.as_str()?.to_string();
            let details = m.get("details");
            let context = details
                .and_then(|d| d.get("context_length"))
                .and_then(|c| c.as_u64());
            let detail = details
                .map(|d| {
                    [
                        d.get("parameter_size").and_then(|x| x.as_str()),
                        d.get("quantization_level").and_then(|x| x.as_str()),
                    ]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" · ")
                })
                .unwrap_or_default();
            Some(LocalModel {
                id,
                context,
                detail,
            })
        })
        .collect()
}

/// OpenAI-compatible GET <base>/models → data[].id (vLLM/LM Studio/llama.cpp/OpenWebUI).
fn parse_openai_models(body: &str) -> Vec<LocalModel> {
    let v: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let data = match v.get("data").and_then(|d| d.as_array()) {
        Some(d) => d,
        None => return Vec::new(),
    };
    data.iter()
        .filter_map(|m| {
            Some(LocalModel {
                id: m.get("id")?.as_str()?.to_string(),
                context: m.get("max_model_len").and_then(|c| c.as_u64()), // vLLM reports this
                detail: String::new(),
            })
        })
        .collect()
}

/// Derive the server origin from an OpenAI-compatible base URL by stripping the trailing
/// path segment(s) we know about ("/v1", "/api"). Used to reach Ollama's native /api/*.
fn origin_of(base_url: &str) -> String {
    let b = base_url.trim().trim_end_matches('/');
    for suffix in ["/v1", "/api"] {
        if let Some(stripped) = b.strip_suffix(suffix) {
            return stripped.to_string();
        }
    }
    b.to_string()
}

// ---- commands ------------------------------------------------------------------

/// One detection probe row: (preset, label, base_url, needs_key, probe-fn). The probe
/// returns a human detail string when the server answers and identifies itself.
type ProviderProbe = (
    &'static str,
    &'static str,
    &'static str,
    bool,
    fn() -> Option<String>,
);

/// Probe the well-known local inference servers concurrently (≤2s each). Purely
/// informational for the Settings UI — detection never gates a spawn.
#[tauri::command]
pub async fn detect_local_providers() -> Vec<LocalProviderStatus> {
    tauri::async_runtime::spawn_blocking(|| {
        let probes: [ProviderProbe; 5] = [
            (
                "ollama",
                "Ollama",
                "http://localhost:11434/v1",
                false,
                || parse_ollama_version(&curl("http://localhost:11434/api/version", None, 2)?),
            ),
            (
                "lmstudio",
                "LM Studio",
                "http://localhost:1234/v1",
                false,
                || parse_openai_model_count(&curl("http://localhost:1234/v1/models", None, 2)?),
            ),
            ("vllm", "vLLM", "http://localhost:8000/v1", false, || {
                parse_openai_model_count(&curl("http://localhost:8000/v1/models", None, 2)?)
            }),
            (
                "llamacpp",
                "llama.cpp",
                "http://localhost:8080/v1",
                false,
                || parse_openai_model_count(&curl("http://localhost:8080/v1/models", None, 2)?),
            ),
            (
                "openwebui",
                "OpenWebUI",
                "http://localhost:3000/api",
                true,
                || parse_openwebui_config(&curl("http://localhost:3000/api/config", None, 2)?),
            ),
        ];
        std::thread::scope(|scope| {
            let handles: Vec<_> = probes
                .iter()
                .map(|(preset, label, base_url, needs_key, probe)| {
                    scope.spawn(move || {
                        let detail = probe();
                        LocalProviderStatus {
                            preset,
                            label,
                            base_url,
                            running: detail.is_some(),
                            detail: detail.unwrap_or_default(),
                            needs_key: *needs_key,
                        }
                    })
                })
                .collect();
            handles
                .into_iter()
                .filter_map(|h| h.join().ok())
                .collect::<Vec<_>>()
        })
    })
    .await
    .unwrap_or_default()
}

/// List the models a local server offers, for the Settings model picker. Ollama is asked
/// natively (/api/tags — carries context lengths); everything else via <base>/models with
/// Bearer auth from the in-memory key holder (the key never round-trips to the frontend).
#[tauri::command]
pub async fn list_local_models(
    base_url: String,
    preset: String,
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Result<Vec<LocalModel>, String> {
    let api_key = store.opencode_key();
    tauri::async_runtime::spawn_blocking(move || {
        let base = base_url.trim().trim_end_matches('/').to_string();
        if !base.starts_with("http://") && !base.starts_with("https://") {
            return Err("base URL must start with http:// or https://".to_string());
        }
        let models = if preset == "ollama" {
            let url = format!("{}/api/tags", origin_of(&base));
            parse_ollama_tags(&curl(&url, None, 5).ok_or("server not reachable")?)
        } else {
            let url = format!("{base}/models");
            parse_openai_models(&curl(&url, api_key.as_deref(), 5).ok_or("server not reachable")?)
        };
        if models.is_empty() {
            return Err(
                "no models reported — is the server running (and the API key valid)?".to_string(),
            );
        }
        Ok(models)
    })
    .await
    .map_err(|e| format!("probe task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ollama_tags_with_context_and_details() {
        // Shape captured live from Ollama 0.30.10 /api/tags.
        let body = r#"{"models":[
            {"name":"qwen3:30b-a3b","model":"qwen3:30b-a3b",
             "details":{"parameter_size":"30.5B","quantization_level":"Q4_K_M","context_length":262144}},
            {"name":"bare-model"}]}"#;
        let models = parse_ollama_tags(body);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "qwen3:30b-a3b");
        assert_eq!(models[0].context, Some(262144));
        assert_eq!(models[0].detail, "30.5B · Q4_K_M");
        assert_eq!(models[1].id, "bare-model");
        assert_eq!(models[1].context, None);
        assert!(parse_ollama_tags("Not Found").is_empty());
        assert!(parse_ollama_tags(r#"{"ok":true}"#).is_empty());
    }

    #[test]
    fn parses_openai_models_list() {
        let body = r#"{"object":"list","data":[
            {"id":"qwen/qwen3-32b","object":"model","max_model_len":32768},
            {"id":"gemma-3n"}]}"#;
        let models = parse_openai_models(body);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "qwen/qwen3-32b");
        assert_eq!(models[0].context, Some(32768));
        assert_eq!(models[1].context, None);
        // A non-LLM service answering on the port is rejected, not misparsed.
        assert!(parse_openai_models("Not Found").is_empty());
        assert!(parse_openai_models(r#"{"detail":"Unauthorized"}"#).is_empty());
    }

    #[test]
    fn detection_parsers_identify_servers() {
        assert_eq!(
            parse_ollama_version(r#"{"version":"0.30.10"}"#).as_deref(),
            Some("v0.30.10")
        );
        assert!(parse_ollama_version("nope").is_none());
        assert_eq!(
            parse_openai_model_count(r#"{"data":[{"id":"a"},{"id":"b"}]}"#).as_deref(),
            Some("2 models")
        );
        assert_eq!(
            parse_openai_model_count(r#"{"data":[{"id":"a"}]}"#).as_deref(),
            Some("1 model")
        );
        // Open WebUI /api/config identifies by name; other JSON on the port is rejected.
        assert_eq!(
            parse_openwebui_config(r#"{"status":true,"name":"Open WebUI","version":"0.9.2"}"#)
                .as_deref(),
            Some("v0.9.2")
        );
        assert!(parse_openwebui_config(r#"{"name":"grafana"}"#).is_none());
    }

    #[test]
    fn origin_strips_known_api_suffixes() {
        assert_eq!(
            origin_of("http://localhost:11434/v1"),
            "http://localhost:11434"
        );
        assert_eq!(
            origin_of("http://localhost:11434/v1/"),
            "http://localhost:11434"
        );
        assert_eq!(origin_of("http://gpu:3000/api"), "http://gpu:3000");
        assert_eq!(origin_of("http://gpu:9999"), "http://gpu:9999");
    }
}
