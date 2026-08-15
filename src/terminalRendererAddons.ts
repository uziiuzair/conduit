// The real xterm renderer addons, kept apart from the tier logic in terminalRenderer.ts.
//
// Both ship as UMD bundles that reference `self` while they load, so importing them is only
// safe inside the webview. Isolating them here lets the fallback ladder be unit-tested in
// Node against fakes, and keeps the browser-only dependency at one visible edge.

import { CanvasAddon } from "@xterm/addon-canvas";
import { WebglAddon } from "@xterm/addon-webgl";
import type { AddonFactories, RendererAddon } from "./terminalRenderer";

export const REAL_ADDONS: AddonFactories = {
  webgl: () => new WebglAddon(),
  canvas: () => new CanvasAddon() as RendererAddon,
};
