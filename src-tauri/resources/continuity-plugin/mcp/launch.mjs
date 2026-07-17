#!/usr/bin/env node
// Version-aware launcher for the bundled MCP shim (mcp/index.mjs).
//
// node:sqlite (used by the local flavor) ships in Node 22.5+: it needs
// --experimental-sqlite on 22.x–23.x and is unflagged on 24+. Older Nodes
// hard-fail on the flag with "bad option", which would otherwise kill the
// whole plugin with no diagnostics. This launcher turns that into a loud,
// actionable error and adds the flag only when the running Node needs it.
const [major, minor] = process.versions.node.split(".").map(Number)

if (major < 22 || (major === 22 && minor < 5)) {
  console.error(
    `[continuity] Node ${process.versions.node} is too old — Continuity needs Node >= 22.5 ` +
      `(it uses the built-in node:sqlite module). The plugin is inactive. ` +
      `Install Node 22.5+ from https://nodejs.org and restart Claude Code.`,
  )
  process.exit(1)
}

if (major >= 24) {
  // node:sqlite needs no flag here — run the bundle in-process, no respawn.
  await import("./index.mjs")
} else {
  // Node 22.5–23.x: re-exec once with the flag the sqlite builtin requires.
  const { spawn } = await import("node:child_process")
  const { fileURLToPath } = await import("node:url")
  const { dirname, join } = await import("node:path")
  const bundle = join(dirname(fileURLToPath(import.meta.url)), "index.mjs")
  const child = spawn(process.execPath, ["--experimental-sqlite", bundle, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  })
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig))
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal)
    else process.exit(code ?? 0)
  })
}
