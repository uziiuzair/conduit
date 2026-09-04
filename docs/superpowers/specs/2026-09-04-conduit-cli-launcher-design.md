# A `conduit` CLI launcher

Date: 2026-09-04
Status: design, to be implemented on `feat/cli-launcher`

## What this is

`conduit .` opens the current directory as a project in the running Conduit, the way
`code .` opens one in VS Code. `conduit . --agent claude` does that and additionally
starts one new session on that agent.

The feature is small because most of its machinery already exists. What follows is
mostly a record of which existing seams it reuses, and of the three or four places
where the obvious implementation would be wrong.

## What the repo already has

Verified against the tree at `3b5b2df`, not assumed:

- **No** `tauri-plugin-single-instance`, **no** `tauri-plugin-deep-link`, **no**
  `tauri-plugin-cli`. Nothing outside `main.rs` reads `argv`. This feature is the
  first external entry point into a running Conduit that is not a hook.
- **A loopback HTTP server already runs**: `hooks::start` (`hooks.rs:70`) binds the
  first free port in `8423..=8443` with `tiny_http`, and it is handed an `AppHandle`,
  so it can both focus a window and `emit` to the frontend.
- **Its port is already published**: `hooks::write_endpoint_file` (`hooks.rs:851`)
  writes `<dataDir>/hook-endpoint.sh` — one `KEY=value` line, rewritten on every boot.
  This is exactly the discovery handshake a `code .`-style shim needs, and it already
  solves the hard part: an app that binds an ephemeral port and can legitimately be
  running twice.
- **Rust-emits-event, frontend-acts is an established pattern**: `App.tsx:479`
  (`bridge-open-session`) and `App.tsx:491` (`fleet-spawn`) are two existing listeners
  that take a payload from a Rust-side server and drive store actions with it.
- **The store actions exist**: `addProject(path)` (`store.ts:2037`),
  `selectProject` (`store.ts:2292`), `addSession(projectId, opts)` (`store.ts:2082`).

So the whole feature is: one new HTTP route, one new Tauri event, one generated shim,
and one Settings action to put that shim on `PATH`.

## Shape

```
conduit . --agent claude
  │
  ├─ resolve path -> absolute, symlinks resolved
  ├─ read <dataDir>/hook-endpoint.sh   -> PORT
  ├─ read <dataDir>/cli-token          -> TOKEN
  ├─ POST /open {path, agent}  X-Conduit-Token: TOKEN
  │     └─ 200 -> exit 0
  └─ nothing listening
        ├─ launch the app bundle
        ├─ poll the endpoint file and probe, ~15s
        └─ POST /open  (the same request, the same handler)

hooks.rs /open
  -> show + unminimize + set_focus
  -> emit "cli-open" { path, agent }
       -> App.tsx: match project by resolved path
            ├─ found     -> selectProject
            └─ not found -> addProject
          if agent -> addSession(projectId, { agent }) -> select it
```

## The command surface, and what it deliberately excludes

```
conduit <path>                 open only
conduit <path> --agent <id>    open, plus ONE new session on that agent
conduit <path> -a <id>         short form
```

`conduit .` opens and nothing more. It does not start a session.

That line matters because "open" already implies spawning for some users: with
`restoreSessionsOnOpen` on (Settings → General), opening a project eagerly spawns
every session it has, through `Terminal.tsx`'s eager effect. If `--agent` meant
"ensure something is running", its observable effect would depend on an unrelated
preference. So `--agent` means *create one new session*, unconditionally, and never
reuses or resumes an existing one. Two invocations create two sessions. That is
predictable, which is worth more here than tidiness.

Not in this version, and why:

- **`conduit list` / `status` / `stop`.** A control CLI over a running app is a
  different feature with a different risk profile; it should get its own design rather
  than accrete onto a launcher.
- **Opening a *file* rather than a directory.** Conduit's unit is a project. A file
  argument has no obvious meaning yet.
- **`--model`, `--effort`, an initial prompt.** Each widens what a forged request can
  do (see below) for a convenience nobody has asked for yet.
- **npm or Homebrew distribution.** Covered under Distribution.

## Security: `/open` is not `/hook`

This is the part that must not be trimmed.

`hooks.rs` documents its own trust model for hook bodies explicitly: *"This body is
UNTRUSTED, unauthenticated, localhost display-data … no security decision keys off it;
it only drives a cosmetic meter, so a spoofed post at worst shows wrong numbers."*

`/open` is the exact opposite. It adds an arbitrary directory as a project and can
start an agent inside it. A spoofed post is not a wrong number; it is an agent process
running against a directory of the attacker's choosing. Any local process — including
a web page in the user's browser reaching `http://127.0.0.1:8423` — is in scope.

Three layers, all required:

1. **A token.** `<dataDir>/cli-token`, 32 random bytes hex, file mode `0600`, written
   beside `write_endpoint_file` on every boot and held in the same `HookState`.
   `/open` requires an `X-Conduit-Token` header matching the live value. Anything else
   gets `403` with an empty body — no oracle about which half was wrong.
2. **Reject any request carrying `Origin`.** A browser cannot suppress that header on
   a cross-origin request; a shell client never sends it. This costs one line and
   closes the entire class of "a visited web page pokes the local port".
3. **The custom header forces a preflight.** `X-Conduit-Token` is not a CORS-safelisted
   request header, so a browser must send an `OPTIONS` preflight first. The server never
   answers preflight, so browser-driven CSRF cannot even reach the handler. This is
   redundant with (1) and (2) on purpose: each layer fails differently.

The token is regenerated per boot rather than persisted, so a token read out of a
backup or an old shell's scrollback is worthless. The shim reads it fresh on every
invocation, so this costs nothing.

`/open` is handled before `parse_query`, like the existing `/approve` route, and never
touches the hook event path.

## The shim is generated, not bundled

The shim ships inside the app and is installed from Settings — but its text is a Rust
`const`, and the install action *writes* it. It is not a file in `bundle.resources`
that gets symlinked.

Two concrete reasons:

- Tauri's resource bundler does not reliably preserve the executable bit, so a
  symlinked resource can land non-executable and the failure is confusing.
- Windows needs a `.cmd` with different content anyway. Generating gives one code path
  that already knows which text and which mode to write per platform.

This also mirrors what `hooks.rs` already does for its hook commands and its spawn
scripts, so it is the house pattern rather than a new one. And it keeps the property
that motivated bundling in the first place: the shim can never drift from the app
version, because the installed app is what wrote it.

### Install target

`install_cli_shim` tries, in order:

1. `/usr/local/bin/conduit` — if the directory exists and is writable.
2. `~/.local/bin/conduit` — otherwise, returning a message telling the user to add
   that directory to `PATH`.

`/usr/local/bin` does not exist on a clean macOS; assuming it does is a common way for
this feature to fail on exactly the machines least able to debug it.

Settings → General shows the current state (installed at `<path>`, or not installed)
and offers install and remove. Remove deletes only a file whose contents Conduit
recognises as its own shim, so it can never delete an unrelated `conduit` binary a
user put there.

## Which install does the shim talk to?

The shim resolves its data directory exactly the way `store::data_dir` does
(`store.rs:549`): `${CONDUIT_DATA_DIR_NAME:-ConduitTauri}` under the platform data
directory (`~/Library/Application Support` on macOS, `%APPDATA%` on Windows,
`$XDG_DATA_HOME`/`~/.local/share` on Linux). One rule, already documented, no new
concept:

```
$ conduit .
   -> …/ConduitTauri/hook-endpoint.sh          the installed app

$ CONDUIT_DATA_DIR_NAME=ConduitTauri-dev conduit .
   -> …/ConduitTauri-dev/hook-endpoint.sh      the dev build
```

**One asymmetry, deliberate:** when `CONDUIT_DATA_DIR_NAME` is set and nothing answers,
the shim prints an error and exits non-zero rather than cold-launching. A dev build is
started by `pnpm tauri dev` from a terminal; there is no bundle to launch. Falling back
to opening the installed app there would produce precisely the state-clobbering
CLAUDE.md warns about — two builds, one `state.json`.

## Cold start

When no server answers, the shim launches the app bundle and then polls the endpoint
file and probes the port until the hook server answers, with a timeout of about 15
seconds, and then sends *the same request the warm path sends*.

The alternative — passing the path on the command line and parsing `argv` at startup —
was rejected for a specific reason. `initialProjectSelection` (`src/startup.ts`) is
deliberately the single place that decides which project a cold launch lands on, and
the design note on it records that a fallback there was the exact bug it was written to
eliminate. An `argv` path would make a second thing decide that same question, and
would need its own Windows arm. Retrying the POST leaves `startup.ts` untouched and
gives the app exactly one entry point: the HTTP handler.

## App side

`hooks.rs` handles `/open` and then, on the `AppHandle` it already holds, calls `show`,
`unminimize` and `set_focus` before emitting. All three are needed: on macOS an app
whose window was closed is still running, and emitting to a hidden window would
"succeed" while the user saw nothing happen.

`App.tsx` gains one listener beside the existing five. Project matching is by
**resolved real path** against `project.path`, so invoking `conduit .` from a symlinked
checkout does not add a duplicate project. That comparison is pure and lives in a
module `App.tsx` imports, so it can be tested (`store.ts` cannot be imported under the
node-env vitest — it touches `localStorage` at module scope, which is why `startup.ts`
exists).

With an `agent`, the listener calls the existing `addSession(projectId, { agent })` and
then selects the new session. No new spawn path.

## Windows

`conduit.cmd`, written to `%LOCALAPPDATA%\Conduit\bin`, with that directory appended to
the user `PATH`. It uses the built-in `curl.exe`. Cold launch runs the installed
executable directly.

Nothing here puts a prompt or a spaced path on a command line, so the `cmd.exe`
re-parsing hazard documented for `pty.rs` does not apply — but the shim is a generated
`.cmd` file, which is the same shape as the fix for that hazard, and should stay that
way if arguments are ever added.

The Windows CI leg is the only thing that will ever compile or exercise this arm.

## Testing

**True end-to-end of the CLI half, automated.** `src-tauri/tests/cli_open.rs` builds a
temp data dir, calls the real endpoint-file and token writers, writes the real
generated shim to disk, and **executes it as a process** (`sh` on Unix, `cmd.exe` on
Windows) against a real `tiny_http` server running the real `/open` handler. It asserts
on what the handler received.

This is possible only if the handler does not take an `AppHandle`. So `/open` lives in
its own module with a **sink**: a channel in tests, the Tauri `emit` in production. The
route registration in `hooks.rs` stays a thin call. That factoring is the point — it is
what makes the shim testable against the actual handler rather than against a mock of
it.

Covered: path resolution, `CONDUIT_DATA_DIR_NAME` targeting, endpoint discovery, the
token header, `Origin` rejection, the body-less 403, exit codes, and the cold-start
retry loop (start the server *late* and assert the shim waits rather than failing).
Both CI legs run it, so the `.cmd` arm is genuinely exercised.

**Manual pass, documented.** What the above cannot see cheaply, checked before release:

1. With Conduit closed, `conduit ~/some/project` launches it and lands on that project.
2. With Conduit open but its window closed (macOS), `conduit .` brings the window back
   and focuses it.
3. `conduit .` on an already-open project selects it and adds no duplicate.
4. `conduit . --agent claude` produces exactly one new session, focused.
5. `curl -X POST http://127.0.0.1:<port>/open` with no token returns 403 and does
   nothing.

**Full GUI end-to-end, automated.** The manual list above is the fallback for a machine
without the harness, not the plan of record. Conduit gains a WebdriverIO harness that
drives the real built app and asserts what the user would see: the project row appears
in the sidebar, the window takes focus, `--agent` adds exactly one session.

- `@wdio/tauri-service` (devDependency) with the **embedded** provider, which is the
  default on all three platforms and is what makes macOS possible at all — there is no
  WKWebView driver, so the WebDriver server runs inside the app.
- `tauri-plugin-wdio-webdriver` as a Rust dependency, plus `"wdio-webdriver:default"`
  in `src-tauri/capabilities/default.json`.
- Specs in `e2e/`, run with `pnpm test:e2e`, pointed at a locally built binary via
  `tauri:options.application`.

**The plugin must never be in a shipped binary, and `#[cfg(debug_assertions)]` is not
sufficient here.** The vendor's setup guide registers the plugin under
`debug_assertions`, which is off in `--release` — but the harness needs a *bundled* app
to launch, and bundling goes through a release profile. Taking the vendor's line
literally would leave the plugin either absent from the binary under test or present in
one built the same way as a shipped one. So the gate is an explicit, off-by-default
cargo feature:

```toml
[features]
wdio = ["dep:tauri-plugin-wdio-webdriver"]
```

```rust
#[cfg(feature = "wdio")]
let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
```

An E2E build passes `--features wdio`; `release.yml` never does — its build args are
`--target universal-apple-darwin` and `--bundles msi`, with no feature flags — so the
shipped artifact cannot contain it. A test asserts the release workflow carries no
`--features` argument, because "we simply won't pass the flag" is a convention, and a
convention protecting a remote-control surface should be a check.

**Where each layer runs.** Tier A is a plain `cargo test`, so `ci.yml`'s existing Rust
matrix picks it up on both macOS and Windows with no workflow change, and
`cargo clippy --all-targets` lints it. The GUI layer needs a full app build per run,
which is minutes on the macOS universal target, so it gets its own `e2e.yml` on
`workflow_dispatch` plus pushes to `main` rather than running on every PR. The gate that
must never regress is the cheap one; the expensive one is a scheduled backstop.

## Release

Ships as **0.35.0** — a new user-facing capability, so MINOR — with a matching
`CHANGELOG.md` entry, and the three version files kept in lockstep per CLAUDE.md.
