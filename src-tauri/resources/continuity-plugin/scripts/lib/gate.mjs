import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"

// Plain-ESM mirror of packages/mcp/src/gate.ts so the hooks run with zero build
// step and zero dependencies. Empty allowlist → activate in any git repo. If you
// change the normalization or hashing here, change it there too.

function git(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return null
  }
}

export function normalizeRemote(url) {
  let s = (url ?? "").trim()
  if (!s) return null
  s = s.replace(/\.git$/i, "")
  const m = s.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i)
  if (m) return `${m[1]}/${m[2]}`.toLowerCase()
  const scp = s.match(/^[^@]+@([^:/]+):(.+)$/)
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase()
  return null
}

export function parseAllowlist(raw) {
  if (!raw || !raw.trim()) return []
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\.git$/i, ""))
    .filter(Boolean)
}

export function resolveRepoContext(dir, allowlistRaw) {
  const toplevel = git(dir, ["rev-parse", "--show-toplevel"])
  if (!toplevel) return null
  const origin = git(toplevel, ["config", "--get", "remote.origin.url"])
  const normalized = normalizeRemote(origin)

  const allowlist = parseAllowlist(allowlistRaw)
  if (allowlist.length > 0) {
    if (!normalized || !allowlist.includes(normalized)) return null
  }

  const slash = normalized ? normalized.indexOf("/") : -1
  // Mirror of gate.ts: CONTINUITY_SESSION_ID salts the hash so several sessions
  // in one checkout get distinct identities. The hooks MUST derive the same
  // cwdHash as the shim or they read a different state file and every gate
  // silently fails open.
  const sessionSalt = process.env.CONTINUITY_SESSION_ID
  const hashInput = sessionSalt ? `${toplevel} ${sessionSalt}` : toplevel
  return {
    toplevel,
    repoFullName: normalized && slash >= 0 ? normalized.slice(slash + 1) : null,
    cwdHash: createHash("sha256").update(hashInput).digest("hex").slice(0, 16),
  }
}
