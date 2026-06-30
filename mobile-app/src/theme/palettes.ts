/**
 * The three Warm color schemes, ported 1:1 from the desktop app's
 * `src/themes.ts` (`THEMES[id].cssVars`). This is the framework-neutral token
 * source for the mobile app — keys are the desktop CSS variables minus the
 * leading "--", plus three derived tokens (`meText`, `onGreen`, `needsBg`) that
 * the chat/list surfaces need.
 *
 * Keep these values in lockstep with `src/themes.ts`. (Design intent: a single
 * shared source both consume — see the spec's §Themes.)
 */

export type ThemeId = "warm-near-black" | "warm-dim" | "warm-light";

export interface Palette {
  label: string;
  appearance: "dark" | "light";
  accent: string;
  sidebarBg: string;
  selectionBg: string;
  panelBg: string;
  textBright: string;
  textMid: string;
  textDim: string;
  border: string;
  green: string;
  red: string;
  amber: string;
  pillNeedsBg: string;
  pillNeedsText: string;
  chipBg: string;
  chipText: string;
  /** text on an --accent fill (user bubble / send button) */
  meText: string;
  /** text on a --green fill (Approve button) */
  onGreen: string;
  /** subtle row tint for a "needs you" agent (amber-washed panel) */
  needsBg: string;
}

export const PALETTES: Record<ThemeId, Palette> = {
  "warm-near-black": {
    label: "Warm Near-Black",
    appearance: "dark",
    accent: "#ce8a6e",
    sidebarBg: "#1b1917",
    selectionBg: "#272523",
    panelBg: "#151110",
    textBright: "#ece8e4",
    textMid: "#968d86",
    textDim: "#5e574f",
    border: "#2a2522",
    green: "#88b07c",
    red: "#c97a72",
    amber: "#c2a063",
    pillNeedsBg: "#2a1c13",
    pillNeedsText: "#e0a580",
    chipBg: "#241a13",
    chipText: "#c99b86",
    meText: "#151110",
    onGreen: "#151110",
    needsBg: "#1e1611",
  },
  "warm-dim": {
    label: "Warm Dim",
    appearance: "dark",
    accent: "#d2906f",
    sidebarBg: "#2a2420",
    selectionBg: "#383029",
    panelBg: "#211d1a",
    textBright: "#ece6df",
    textMid: "#ab9f95",
    textDim: "#75695f",
    border: "#3b332c",
    green: "#8fb37f",
    red: "#ce8079",
    amber: "#c8a667",
    pillNeedsBg: "#3a2818",
    pillNeedsText: "#e7ab83",
    chipBg: "#342618",
    chipText: "#d2a78f",
    meText: "#211d1a",
    onGreen: "#211d1a",
    needsBg: "#2a2019",
  },
  "warm-light": {
    label: "Warm Light",
    appearance: "light",
    accent: "#b5613f",
    sidebarBg: "#efe7da",
    selectionBg: "#e4d8c6",
    panelBg: "#f6f1e9",
    textBright: "#2c2622",
    textMid: "#6f655a",
    textDim: "#9c9286",
    border: "#ddd2c2",
    green: "#5d7c4d",
    red: "#b04a42",
    amber: "#8f6a25",
    pillNeedsBg: "#f0dcc8",
    pillNeedsText: "#9a4f2c",
    chipBg: "#ece0cf",
    chipText: "#8a5a3f",
    meText: "#ffffff",
    onGreen: "#ffffff",
    needsBg: "#f4e8da",
  },
};

export const THEME_ORDER: ThemeId[] = ["warm-near-black", "warm-dim", "warm-light"];
export const DEFAULT_THEME: ThemeId = "warm-near-black";

/** Cycle to the next theme (used by the on-device switcher). */
export function nextTheme(id: ThemeId): ThemeId {
  const i = THEME_ORDER.indexOf(id);
  return THEME_ORDER[(i + 1) % THEME_ORDER.length];
}
