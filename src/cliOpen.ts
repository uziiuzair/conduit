/**
 * Matching a CLI-supplied directory against the open projects.
 *
 * Pure and standalone because `store.ts` cannot be imported under the node-env vitest —
 * it touches `localStorage` at module scope. Same reason `startup.ts` exists.
 *
 * `Store::add_project` does NOT dedupe by path, so without this every `conduit .` on an
 * already-open project would add a second copy of it.
 */

/** Windows paths are case-insensitive and may use either separator. */
const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/;

function normalize(path: string): string {
  let p = path.trim();
  if (!p) return "";
  if (WINDOWS_PATH.test(p)) p = p.replace(/\\/g, "/").toLowerCase();
  // Strip trailing separators, but never reduce a root to the empty string.
  while (p.length > 1 && (p.endsWith("/") || p.endsWith("\\"))) p = p.slice(0, -1);
  return p;
}

export function matchProjectByPath(
  projects: { id: string; path: string }[],
  path: string,
): string | null {
  const want = normalize(path);
  if (!want || want === "/") return null;
  return projects.find((p) => normalize(p.path) === want)?.id ?? null;
}
