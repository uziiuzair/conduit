// Pure helpers for the New Project / Clone Repository dialog. No store, no Tauri —
// importable under the node-env vitest (same reason startup.ts and cliOpen.ts exist).

/**
 * Derive the default folder name from a clone URL: the last path segment, minus a
 * `.git` suffix. Handles https URLs, scp-like `git@host:user/repo.git`, and plain
 * filesystem paths. Returns "" when no segment can be found — the caller leaves the
 * field empty rather than guessing.
 */
export function cloneNameFromUrl(url: string): string {
  let s = url.trim();
  if (!s) return "";
  // scp-like syntax has no scheme; everything after the last ":" is the path.
  const scheme = s.indexOf("://");
  if (scheme === -1) {
    const colon = s.lastIndexOf(":");
    if (colon !== -1) s = s.slice(colon + 1);
  }
  s = s.replace(/\/+$/, "");
  const seg = s.slice(Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\")) + 1);
  const name = seg.endsWith(".git") ? seg.slice(0, -4) : seg;
  // A bare host ("https://github.com/") leaves the hostname as the segment; a name
  // containing a dot-suffix like that is still legitimate ("repo.js"), but an empty
  // path after the scheme is not. Detect it: nothing after the host means the
  // remaining string still contains the scheme's host only.
  if (scheme !== -1) {
    const afterScheme = url.trim().slice(scheme + 3).replace(/\/+$/, "");
    if (!afterScheme.includes("/")) return "";
  }
  return name;
}

/**
 * Validate a project folder name. Returns an error message, or null when valid.
 * Separators are rejected unconditionally — both slashes, on every platform — so the
 * macOS and Windows CI legs run the same rules (mirrors the Rust-side validator).
 */
export function validateProjectName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Project name is required";
  if (n === "." || n === "..") return "Not a valid folder name";
  if (n.includes("/") || n.includes("\\")) return "Name cannot contain path separators";
  return null;
}
