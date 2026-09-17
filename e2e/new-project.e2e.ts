import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The New Project / Clone Repository dialog, driven end to end: open it the way the
 * File menu does, fill it through the DOM, and assert on what the user gets — a
 * sidebar row and a real directory on disk.
 *
 * The native menu itself cannot be clicked from the webview, but its click is just an
 * emit of the "menu" event with the item id (menu.rs relays every custom item that
 * way), so emitting the same event exercises everything after the click. The clone is
 * hermetic: it clones a local fixture repo by path, no network.
 */

/** Set a React-controlled input: wdio's clearValue sets .value directly, which React's
 *  synthetic onChange never sees, so drive the native setter + input event instead. */
function setReactInput(selector: string, value: string): Promise<void> {
  return browser.execute(
    (sel: string, v: string) => {
      const el = document.querySelector(sel) as HTMLInputElement;
      const set = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(el),
        "value",
      )!.set!;
      set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    selector,
    value,
  ) as Promise<void>;
}

function openDialog(menuId: "new-project" | "clone-repo"): Promise<void> {
  return browser.execute(
    (id: string) => (window as any).__TAURI__.event.emit("menu", id),
    menuId,
  ) as Promise<void>;
}

function projectRowCount(name: string): Promise<number> {
  return browser.execute(
    (want: string) =>
      Array.from(document.querySelectorAll(".project-block .name")).filter(
        (e) => (e.textContent ?? "").trim() === want,
      ).length,
    name,
  ) as Promise<number>;
}

describe("the New Project dialog", () => {
  it("is reachable from the command palette", async () => {
    // Cmd+K is a native accelerator, but its click is the same relayed "menu" event.
    await browser.execute(() => (window as any).__TAURI__.event.emit("menu", "command-palette"));
    await $(".palette").waitForExist({ timeout: 5_000 });
    const labels = (await browser.execute(() =>
      Array.from(document.querySelectorAll(".palette-row .palette-file")).map(
        (e) => (e.textContent ?? "").trim(),
      ),
    )) as string[];
    expect(labels).toContain("New project…");
    expect(labels).toContain("Clone repository…");
    await browser.keys("Escape");
  });

  it("creates a git-initialized project folder and adds it", async () => {
    const parent = mkdtempSync(join(tmpdir(), "conduit-e2e-new-"));
    await openDialog("new-project");
    await $(".np-dialog").waitForExist({ timeout: 5_000 });

    await setReactInput(".np-name", "created-e2e");
    await setReactInput(".np-location", parent);
    await $(".np-submit").click();

    await browser.waitUntil(async () => (await projectRowCount("created-e2e")) === 1, {
      timeout: 15_000,
      timeoutMsg: "the created project never appeared in the sidebar",
    });
    const dir = join(parent, "created-e2e");
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, ".git"))).toBe(true);
  });

  it("clones a repository and adds the clone", async () => {
    // Hermetic fixture: a local repo with one commit, cloned by filesystem path.
    const src = mkdtempSync(join(tmpdir(), "conduit-e2e-src-"));
    execFileSync("git", ["init", "-q"], { cwd: src });
    execFileSync(
      "git",
      ["-c", "user.email=e2e@e2e", "-c", "user.name=e2e", "commit", "--allow-empty", "-q", "-m", "x"],
      { cwd: src },
    );
    const parent = mkdtempSync(join(tmpdir(), "conduit-e2e-clone-"));

    await openDialog("clone-repo");
    await $(".np-dialog").waitForExist({ timeout: 5_000 });

    await setReactInput(".np-url", src);
    await setReactInput(".np-name", "cloned-e2e");
    await setReactInput(".np-location", parent);
    await $(".np-submit").click();

    await browser.waitUntil(async () => (await projectRowCount("cloned-e2e")) === 1, {
      timeout: 30_000,
      timeoutMsg: "the cloned project never appeared in the sidebar",
    });
    expect(existsSync(join(parent, "cloned-e2e", ".git"))).toBe(true);
  });

  it("shows the git error inline when a clone fails", async () => {
    const parent = mkdtempSync(join(tmpdir(), "conduit-e2e-fail-"));
    await openDialog("clone-repo");
    await $(".np-dialog").waitForExist({ timeout: 5_000 });

    await setReactInput(".np-url", join(parent, "no-such-repo"));
    await setReactInput(".np-name", "never-lands");
    await setReactInput(".np-location", parent);
    await $(".np-submit").click();

    await $(".np-error").waitForExist({ timeout: 15_000 });
    // The dialog stays open on failure; close it so later specs start clean.
    await browser.keys("Escape");
    expect(await projectRowCount("never-lands")).toBe(0);
  });
});
