import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { E2E_DATA_DIR, e2eDataDir } from "../wdio.conf";

/**
 * A Claude session follows its conversation past a `/clear`, end to end.
 *
 * Hermetic: the session runs under a registered ACCOUNT whose config dir is a temp
 * directory, so every transcript, the prompt history and the spawned `claude` itself live
 * there — never in the developer's real `~/.claude`. That per-session resolution is the
 * same seam the real multi-account feature uses, so nothing here is a test-only path.
 *
 * Covers the three layers of the fix: the one-time recovery notice (including an older
 * fork, which is where a pre-fix restart left the user's work), the live `SessionStart`
 * capture, and — the part the user actually feels — the spawned `claude` resuming the
 * captured conversation rather than the pinned one.
 */

type Session = {
  id: string;
  name: string;
  agentConversationId?: string | null;
};
type Project = { id: string; name: string; sessions: Session[] };

const invoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  browser.execute(
    (c: string, a: Record<string, unknown> | undefined) =>
      (window as any).__TAURI__.core.invoke(c, a),
    cmd,
    args,
  ) as Promise<T>;

async function conversationOf(sessionId: string): Promise<string | null | undefined> {
  const projects = await invoke<Project[]>("load_projects");
  return projects.flatMap((p) => p.sessions).find((s) => s.id === sessionId)?.agentConversationId;
}

const iso = (ms: number) => new Date(ms).toISOString();
const line = (v: unknown) => JSON.stringify(v) + "\n";

/** A transcript that began with a `/clear` at `at`, whose first real prompt is `title`. */
function continuation(at: number, title: string): string {
  return (
    line({
      type: "user",
      isMeta: true,
      message: { content: "Caveat" },
      timestamp: iso(at + 5),
    }) +
    line({
      type: "user",
      message: { content: "<command-name>/clear</command-name>" },
      timestamp: iso(at + 5),
    }) +
    line({
      type: "attachment",
      attachment: { hookName: "SessionStart:clear" },
    }) +
    line({
      type: "user",
      message: { content: title },
      timestamp: iso(at + 10_000),
    })
  );
}

async function postHook(sessionId: string, body: unknown): Promise<void> {
  const endpoint = readFileSync(join(e2eDataDir(), "hook-endpoint.sh"), "utf8");
  const port = /CONDUIT_HOOK_PORT=(\d+)/.exec(endpoint)?.[1];
  if (!port) throw new Error(`no hook port in ${endpoint}`);
  await fetch(`http://127.0.0.1:${port}/hook?session=${sessionId}&event=sessionstart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("a Claude session's conversation", () => {
  const name = "continuity-project";
  let projectDir: string;
  let transcripts: string;
  let session: Session;
  const pinnedAt = Date.now() - 3 * 3_600_000;
  const firstClear = pinnedAt + 600_000;
  const secondClear = pinnedAt + 7_200_000;
  const early = randomUUID(); // the pre-restart work
  const late = randomUUID(); // the pinned conversation, resumed, then cleared again

  before(async () => {
    const root = mkdtempSync(join(tmpdir(), "conduit-e2e-continuity-"));
    projectDir = join(root, name);
    mkdirSync(projectDir, { recursive: true });
    const config = join(root, "claude-config");
    transcripts = join(config, "projects", projectDir.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(transcripts, { recursive: true });

    const project = await invoke<Project>("add_project", { path: projectDir });
    const account = await invoke<{ id: string }>("add_account", {
      label: "E2E",
      configDir: config,
    });
    session = await invoke<Session>("add_session", {
      projectId: project.id,
      name: "Worker",
      useWorktree: false,
      agent: "claude",
      role: null,
      mcpServers: null,
      model: null,
    });
    await invoke("set_session_account", {
      sessionId: session.id,
      accountId: account.id,
    });
    // Hibernated, so the app does not launch it until the spawn test asks.
    await invoke("stop_session", { sessionId: session.id });

    writeFileSync(
      join(transcripts, `${session.id}.jsonl`),
      line({
        type: "user",
        message: { content: "first task" },
        timestamp: iso(pinnedAt),
      }),
    );
    writeFileSync(
      join(transcripts, `${early}.jsonl`),
      continuation(firstClear, "ship the release notes"),
    );
    writeFileSync(join(transcripts, `${late}.jsonl`), continuation(secondClear, "a fresh start"));
    writeFileSync(
      join(config, "history.jsonl"),
      line({
        display: "/clear",
        project: projectDir,
        sessionId: session.id,
        timestamp: firstClear,
      }) +
        line({
          display: "/clear",
          project: projectDir,
          sessionId: session.id,
          timestamp: secondClear,
        }),
    );

    // The notice scans once, when the projects first load.
    await browser.execute(() => location.reload());
  });

  it("is offered back after a restart reopened the pre-clear one", async () => {
    const notice = await $(".convo-repair");
    await notice.waitForExist({ timeout: 20_000 });
    expect(await notice.getText()).toContain("1 session");
    await (await notice.$("button=Review")).click();
    const text = await notice.getText();
    expect(text).toContain("Worker");
    expect(text).toContain("a fresh start"); // the newest branch is the headline
  });

  it("can switch to the older branch that held the lost work", async () => {
    const notice = await $(".convo-repair");
    await (await notice.$("button*=earlier branch")).click();
    const forks = await notice.$(".convo-repair-forks");
    expect(await forks.getText()).toContain("ship the release notes");
    await (await forks.$("button=Switch to this")).click();
    await browser.waitUntil(async () => (await conversationOf(session.id)) === early, {
      timeout: 10_000,
      timeoutMsg: "the session was not switched onto the older branch",
    });
    await notice.waitForExist({ reverse: true, timeout: 5_000 });
  });

  it("follows a /clear reported by the SessionStart hook", async () => {
    const cleared = randomUUID();
    await postHook(session.id, { session_id: cleared, source: "clear" });
    await browser.waitUntil(async () => (await conversationOf(session.id)) === cleared, {
      timeout: 10_000,
      timeoutMsg: "the SessionStart capture never recorded the new conversation",
    });
    writeFileSync(join(transcripts, `${cleared}.jsonl`), line({ type: "user" }));

    // A fresh `startup` while that conversation is still on disk = the resume failed and
    // Claude started over. It is followed, and the user is told.
    const restarted = randomUUID();
    await postHook(session.id, { session_id: restarted, source: "startup" });
    // Checked first: a toast dismisses itself after 4 s. Polled in the page rather than
    // through `$`, so one round trip reads the text the instant it renders.
    await browser.waitUntil(
      async () =>
        (
          (await browser.execute(
            () => document.querySelector(".toast.error")?.textContent ?? "",
          )) as string
        ).includes("couldn't reopen its previous conversation"),
      {
        timeout: 3_500,
        interval: 100,
        timeoutMsg: "no failed-resume toast",
      },
    );
    await browser.waitUntil(async () => (await conversationOf(session.id)) === restarted, {
      timeout: 10_000,
    });
    writeFileSync(join(transcripts, `${restarted}.jsonl`), line({ type: "user" }));
  });

  it("launches claude on the conversation it moved to", async () => {
    const target = await conversationOf(session.id);
    // Opening a hibernated session is what starts it again.
    await browser.execute((want: string) => {
      const row = Array.from(document.querySelectorAll(".project-block .name")).find(
        (e) => (e.textContent ?? "").trim() === want,
      ) as HTMLElement | undefined;
      row?.click();
    }, name);
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => {
          const row = Array.from(document.querySelectorAll(".session-row")).find((e) =>
            (e.textContent ?? "").includes("Worker"),
          ) as HTMLElement | undefined;
          row?.click();
          return !!row;
        })) as boolean,
      { timeout: 10_000, timeoutMsg: "the session row never appeared" },
    );
    await browser.waitUntil(
      () =>
        execFileSync("ps", ["-axww", "-o", "command="], { encoding: "utf8" })
          .split("\n")
          .some((cmd) => cmd.includes("--resume") && cmd.includes(String(target))),
      { timeout: 30_000, timeoutMsg: `no claude process resumed ${target}` },
    );
  });

  after(() => {
    // Sessions run under tmux and outlive the app; this socket is the e2e data dir's own.
    const safe = E2E_DATA_DIR.replace(/[^A-Za-z0-9]/g, "-");
    try {
      execFileSync("tmux", ["-L", `conduit-${safe}`, "kill-server"], {
        stdio: "ignore",
      });
    } catch {
      // No server (tmux missing or persistence off) — nothing to clean.
    }
  });
});
