import { realpathSync } from "node:fs"
import { isAbsolute, relative } from "node:path"

// Resolve symlinks so both sides compare in canonical form — e.g. on macOS,
// git reports the toplevel as /private/tmp/... while the hook may receive the
// file path through the /tmp symlink. Falls back to the raw path if it
// doesn't resolve (deleted file, permissions).
function canonical(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

// Convert a file path to one relative to the git toplevel, so file_activity rows
// are comparable across machines with different checkout locations.
export function repoRelative(toplevel, filePath) {
  if (!filePath) return null
  if (isAbsolute(filePath)) {
    const rel = relative(canonical(toplevel), canonical(filePath))
    return rel.startsWith("..") ? filePath : rel
  }
  return filePath
}
