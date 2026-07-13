//! Find-in-files: literal content search shelling out to the best available tool —
//! `rg --json` when installed, `git grep` inside repos, plain `grep -r` otherwise.
//! Read-only. No regex surface: queries are fixed strings (agents and humans paste
//! literal snippets; a regex toggle can come later without changing the shape).

use std::process::Command;

use serde::Serialize;

/// Total hits returned to the UI. The cap is reported (`truncated`) so the palette
/// can say "showing first 500" instead of silently looking exhaustive.
pub const HIT_CAP: usize = 500;
/// Per-line preview bound; rg enforces it natively via --max-columns.
const LINE_CAP: usize = 400;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// Path relative to the searched dir, forward slashes.
    pub path: String,
    /// 1-based line number.
    pub line: u32,
    /// 1-based column of the first match in the line (1 when unknown).
    pub col: u32,
    /// The matched line, trimmed to LINE_CAP chars.
    pub text: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    pub truncated: bool,
    /// Which backend produced the results ("rg" | "git-grep" | "grep").
    pub backend: String,
}

fn run_tool(cmd: &str, args: &[&str], dir: &str) -> Result<std::process::Output, String> {
    use crate::NoWindow;
    Command::new(cmd)
        .args(args)
        .current_dir(dir)
        .no_window()
        .output()
        .map_err(|e| format!("failed to run {cmd}: {e}"))
}

fn cap_line(s: &str) -> String {
    if s.chars().count() <= LINE_CAP {
        s.to_string()
    } else {
        s.chars().take(LINE_CAP).collect()
    }
}

/// Parse `rg --json` output (JSON-lines; we only care about type=="match").
/// Pure for unit tests.
pub fn parse_rg_json(out: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    for line in out.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v["type"] != "match" {
            continue;
        }
        let d = &v["data"];
        let Some(path) = d["path"]["text"].as_str() else {
            continue;
        };
        let Some(line_no) = d["line_number"].as_u64() else {
            continue;
        };
        let text = d["lines"]["text"].as_str().unwrap_or("");
        // Byte offset of the first submatch; a char-imprecise column is fine for
        // a reveal target, and rg reports bytes anyway.
        let col = d["submatches"][0]["start"].as_u64().unwrap_or(0) + 1;
        // rg invoked with an explicit "." prints "./"-prefixed paths; strip it or
        // the frontend joins a path that string-compares unequal to the tree's
        // (duplicate tab/model keys for the same file).
        let path = path.strip_prefix("./").unwrap_or(path);
        hits.push(SearchHit {
            path: path.replace('\\', "/"),
            line: line_no as u32,
            col: col as u32,
            text: cap_line(text.trim_end_matches('\n')),
        });
    }
    hits
}

/// Parse `path:line:text` output (git grep / grep -rn). Windows drive letters can't
/// appear — both tools are run with relative paths from `dir`. Pure for unit tests.
pub fn parse_grep_lines(out: &str, query: &str) -> Vec<SearchHit> {
    let mut hits = Vec::new();
    for line in out.lines() {
        let Some((path, rest)) = line.split_once(':') else {
            continue;
        };
        let Some((line_no, text)) = rest.split_once(':') else {
            continue;
        };
        let Ok(line_no) = line_no.parse::<u32>() else {
            continue;
        };
        let path = path.strip_prefix("./").unwrap_or(path);
        // Neither tool reports a column; locate the literal query ourselves
        // (case-insensitive, matching the tools' -i flag below).
        let col = text
            .to_lowercase()
            .find(&query.to_lowercase())
            .map(|i| i + 1)
            .unwrap_or(1);
        hits.push(SearchHit {
            path: path.replace('\\', "/"),
            line: line_no,
            col: col as u32,
            text: cap_line(text),
        });
    }
    hits
}

/// Literal search under `dir`. Backend preference: rg > git grep (repo) > grep.
pub fn search(dir: &str, query: &str) -> Result<SearchResult, String> {
    if query.trim().len() < 2 {
        return Ok(SearchResult {
            hits: Vec::new(),
            truncated: false,
            backend: "none".into(),
        });
    }

    // rg: smart-case, fixed strings, hidden files but never .git, bounded output.
    // --max-count bounds per-file floods; HIT_CAP below bounds the total.
    if let Ok(out) = run_tool(
        "rg",
        &[
            "--json",
            "--smart-case",
            "--fixed-strings",
            "--max-count",
            "50",
            "--max-columns",
            &LINE_CAP.to_string(),
            "--hidden",
            "--glob",
            "!.git",
            "--",
            query,
            ".",
        ],
        dir,
    ) {
        // rg exits 1 for "no matches" (not an error) and 2 for real errors.
        if out.status.code() == Some(0) || out.status.code() == Some(1) {
            let mut hits = parse_rg_json(&String::from_utf8_lossy(&out.stdout));
            let truncated = hits.len() > HIT_CAP;
            hits.truncate(HIT_CAP);
            return Ok(SearchResult {
                hits,
                truncated,
                backend: "rg".into(),
            });
        }
    }

    // git grep inside a repo: gitignore-aware like rg, -I skips binaries.
    let in_repo = run_tool("git", &["rev-parse", "--is-inside-work-tree"], dir)
        .map(|o| o.status.success())
        .unwrap_or(false);
    if in_repo {
        let out = run_tool("git", &["grep", "-InF", "-i", "-e", query], dir)?;
        // Same exit convention as rg: 1 = no matches.
        if !out.status.success() && out.status.code() != Some(1) {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        let mut hits = parse_grep_lines(&String::from_utf8_lossy(&out.stdout), query);
        let truncated = hits.len() > HIT_CAP;
        hits.truncate(HIT_CAP);
        return Ok(SearchResult {
            hits,
            truncated,
            backend: "git-grep".into(),
        });
    }

    let out = run_tool("grep", &["-rInF", "-i", "-e", query, "."], dir)?;
    if !out.status.success() && out.status.code() != Some(1) {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let mut hits = parse_grep_lines(&String::from_utf8_lossy(&out.stdout), query);
    let truncated = hits.len() > HIT_CAP;
    hits.truncate(HIT_CAP);
    Ok(SearchResult {
        hits,
        truncated,
        backend: "grep".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rg_json_extracts_path_line_col_text() {
        let out = concat!(
            r#"{"type":"begin","data":{"path":{"text":"src/a.ts"}}}"#,
            "\n",
            r#"{"type":"match","data":{"path":{"text":"./src/a.ts"},"lines":{"text":"const store = 1;\n"},"line_number":7,"absolute_offset":10,"submatches":[{"match":{"text":"store"},"start":6,"end":11}]}}"#,
            "\n",
            r#"{"type":"end","data":{"path":{"text":"src/a.ts"}}}"#,
            "\n",
            r#"{"type":"summary","data":{}}"#,
            "\n",
        );
        assert_eq!(
            parse_rg_json(out),
            vec![SearchHit {
                path: "src/a.ts".into(),
                line: 7,
                col: 7,
                text: "const store = 1;".into(),
            }]
        );
    }

    #[test]
    fn rg_json_skips_malformed_and_non_match_lines() {
        let out = "not json at all\n{\"type\":\"match\",\"data\":{}}\n";
        assert!(parse_rg_json(out).is_empty());
    }

    #[test]
    fn grep_lines_parse_and_locate_column_case_insensitively() {
        let out = "./src/a.ts:3:  const Store = init();\nsrc/b.rs:12:store()\nnoline\n";
        let hits = parse_grep_lines(out, "store");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "src/a.ts");
        assert_eq!(hits[0].line, 3);
        assert_eq!(hits[0].col, 9); // "Store" at 1-based col 9, matched case-insensitively
        assert_eq!(hits[1].path, "src/b.rs");
        assert_eq!(hits[1].col, 1);
    }

    #[test]
    fn grep_lines_tolerate_colons_in_content() {
        let hits = parse_grep_lines("a.ts:5:const url = \"http://x\";\n", "url");
        assert_eq!(hits[0].line, 5);
        assert_eq!(hits[0].text, "const url = \"http://x\";");
    }

    #[test]
    fn short_queries_return_empty_without_running_tools() {
        let r = search("/nonexistent-dir-abc", "a").unwrap();
        assert!(r.hits.is_empty() && !r.truncated);
    }
}
