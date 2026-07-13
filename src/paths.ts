// Join a native root with a git-style (forward-slash) relative path so the result
// string-compares equal to paths the file tree / registry produce natively. On
// Windows the tree's paths use backslashes; a "/"-joined variant of the same file
// would key a DUPLICATE tab and Monaco model.

export function joinPath(dir: string, rel: string): string {
  const winSep = dir.includes("\\");
  const sep = winSep ? "\\" : "/";
  const relNative = winSep ? rel.replace(/\//g, "\\") : rel;
  return (dir.endsWith(sep) ? dir : dir + sep) + relNative;
}

/** The prefix under which `joinPath(dir, …)` results live (for startsWith checks). */
export function dirPrefix(dir: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? dir : dir + sep;
}
