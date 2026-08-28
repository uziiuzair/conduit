// Which rasterizer an xterm pane draws with, and the fallback ladder underneath it.
//
// Tiers, in VS Code's order: WebGL (one GPU draw call per viewport, glyphs from a texture
// atlas) → canvas (per-glyph CPU blits) → xterm's built-in DOM renderer. WebGL is the
// default; canvas stays selectable in Settings → Terminal because WebGL costs one live GPU
// context per pane and WebKit caps how many can exist at once — past that cap a fleet of
// panes starts losing contexts.
//
// The store records INTENT ("webgl"); this module records REALITY (`handle.active`), which
// can sit a tier lower when a context is refused or lost. A lost context must never leave a
// blank pane, so that pane drops to canvas in place — without touching the preference, since
// the cause is the cap and not the user's choice.

// The concrete addons live in terminalRendererAddons.ts and arrive by injection: they ship
// as UMD bundles that touch `self` on import, so a static import here would drag a browser
// global into every consumer — including this module's own unit test.

import type { ITerminalAddon } from "@xterm/xterm";

/** What a pane can be asked for. The DOM renderer is a fallback, never a choice. */
export type TerminalRenderer = "webgl" | "canvas";

/** What a pane actually ended up drawing with. */
export type ActiveRenderer = TerminalRenderer | "dom";

/** WebGL's addon adds context-loss notification on top of the plain addon contract. */
export type RendererAddon = ITerminalAddon & { onContextLoss?: (handler: () => void) => void };

export type AddonFactories = {
  webgl: () => RendererAddon;
  canvas: () => RendererAddon;
};

/** The slice of xterm's Terminal this module needs — keeps the logic testable off-DOM. */
export type RendererTarget = { loadAddon: (addon: RendererAddon) => void };

export type RendererHandle = {
  /** The tier currently painting this pane. Mutates if a context is lost. */
  active: ActiveRenderer;
  /** Detaches the renderer addon. Safe to call after the terminal itself is disposed. */
  dispose: () => void;
};

/**
 * Loads `wanted` onto `term`, degrading a tier at a time if it throws.
 *
 * `factories` is injected so the ladder can be exercised without a GPU or a DOM.
 * `onChange` fires whenever reality moves — never at attach time; only a later context loss
 * reports in.
 */
export function attachRenderer(
  term: RendererTarget,
  wanted: TerminalRenderer,
  factories: AddonFactories,
  onChange?: (active: ActiveRenderer) => void,
): RendererHandle {
  let addon: RendererAddon | null = null;
  const handle: RendererHandle = { active: "dom", dispose: () => {} };

  const loadCanvas = () => {
    try {
      const canvas = factories.canvas();
      term.loadAddon(canvas);
      addon = canvas;
      handle.active = "canvas";
    } catch {
      // Nothing left to load: xterm's DOM renderer is already running underneath.
      addon = null;
      handle.active = "dom";
    }
  };

  if (wanted === "webgl") {
    try {
      const webgl = factories.webgl();
      webgl.onContextLoss?.(() => {
        try {
          webgl.dispose();
        } catch {
          /* already gone with the context */
        }
        loadCanvas();
        onChange?.(handle.active);
      });
      term.loadAddon(webgl);
      addon = webgl;
      handle.active = "webgl";
    } catch {
      loadCanvas();
    }
  } else {
    loadCanvas();
  }

  handle.dispose = () => {
    try {
      addon?.dispose();
    } catch {
      // Two ways this throws, both survivable: a second dispose on an addon xterm already
      // tore down, and @xterm/addon-webgl 0.19's restore-the-DOM-renderer step, which reads
      // `_core._store` — an internal that does not exist on @xterm/xterm 5.5. See disposePane.
    }
    addon = null;
    handle.active = "dom";
  };

  return handle;
}

/**
 * Tear a pane down in the ONE order that is safe: renderer addon first, xterm second.
 *
 * `Terminal.dispose()` is NOT addon-safe. xterm's public Terminal registers its core before
 * its addon manager and disposes registrations in that order, so the addons are disposed
 * AFTER the core they reach back into — and whatever they throw comes out of the caller.
 * @xterm/addon-webgl 0.19 throws there every time (its guard reads `_core._store`, which
 * @xterm/xterm 5.5 does not have), which lands the exception in React's unmount commit and
 * blanks the app behind the ErrorBoundary the moment a session's terminal unmounts.
 *
 * Disposing the addon through `handle` first keeps the throw inside `attachRenderer`'s catch
 * and leaves xterm's addon manager with nothing to do: it marks the entry disposed before
 * calling in, so the pass inside `Terminal.dispose()` becomes a no-op.
 */
export function disposePane(handle: RendererHandle | null, term: { dispose: () => void }): void {
  handle?.dispose();
  term.dispose();
}
