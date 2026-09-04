import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { E2E_DATA_DIR } from "../wdio.conf";

/**
 * The GUI half of the CLI launcher's end-to-end coverage: install the shim through the
 * same command Settings calls, run it as a real process, and assert on what the user
 * would actually see.
 *
 * `src-tauri/tests/cli_open.rs` already covers the shim-to-handler chain. What only this
 * can check is the part after the handler: the project row appearing, not being added
 * twice, and `--agent` producing exactly one session.
 */

type ShimStatus = { installed: boolean; path: string | null };

/** The app under test and the shim must agree on a data directory. */
const env = { ...process.env, CONDUIT_DATA_DIR_NAME: E2E_DATA_DIR };

const PROJECT_ROWS = ".project-block .name";
const SESSION_ROWS = ".session-row";

/**
 * Counted in the page rather than through `$$`: wdio's element array is a chainable
 * proxy, not a plain array, so mapping it into `Promise.all` throws. One `execute` is
 * also one round trip instead of one per row.
 */
function countMatching(selector: string, text?: string): Promise<number> {
  return browser.execute(
    (sel: string, want: string | null) =>
      Array.from(document.querySelectorAll(sel)).filter(
        (e) => want === null || (e.textContent ?? "").trim() === want,
      ).length,
    selector,
    text ?? null,
  ) as Promise<number>;
}

const projectRowCount = (name: string) => countMatching(PROJECT_ROWS, name);
const sessionRowCount = () => countMatching(SESSION_ROWS);

describe("the conduit CLI launcher", () => {
  let shim: string;
  let project: string;
  const name = "demo-project";

  before(async () => {
    const status = (await browser.execute(
      // `withGlobalTauri` is enabled only by tauri.wdio.conf.json, never in a release.
      () => (window as any).__TAURI__.core.invoke("install_cli_shim"),
    )) as ShimStatus;
    if (!status?.path) throw new Error("install_cli_shim did not report a path");
    shim = status.path;

    project = join(mkdtempSync(join(tmpdir(), "conduit-e2e-")), name);
    mkdirSync(project, { recursive: true });
  });

  it("adds and selects the project it is pointed at", async () => {
    execFileSync(shim, [project], { env });
    await browser.waitUntil(async () => (await projectRowCount(name)) === 1, {
      timeout: 20_000,
      timeoutMsg: "the project never appeared in the sidebar",
    });
  });

  it("does not add the project twice", async () => {
    execFileSync(shim, [project], { env });
    // Give a duplicate time to appear before concluding it did not.
    await browser.pause(3_000);
    expect(await projectRowCount(name)).toBe(1);
  });

  it("--agent starts exactly one session", async () => {
    const before = await sessionRowCount();
    execFileSync(shim, [project, "--agent", "claude"], { env });
    await browser.waitUntil(async () => (await sessionRowCount()) === before + 1, {
      timeout: 60_000,
      timeoutMsg: "no session appeared",
    });
    await browser.pause(3_000);
    expect(await sessionRowCount()).toBe(before + 1);
  });

  after(async () => {
    await browser
      .execute(() => (window as any).__TAURI__.core.invoke("remove_cli_shim"))
      .catch(() => {});
  });
});
