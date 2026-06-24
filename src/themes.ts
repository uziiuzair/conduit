import type { Terminal as Xterm, ITheme } from "@xterm/xterm";
import type { CSSProperties } from "react";

export type ThemeId = "warm-near-black" | "warm-dim" | "warm-light";
export type ThemePref = ThemeId | "auto";

export interface Theme {
  id: ThemeId;
  label: string;
  appearance: "dark" | "light";
  /** CSS custom properties written onto :root. Keys include the leading "--". */
  cssVars: Record<string, string>;
  /** xterm.js theme object. */
  terminal: ITheme;
  /** react-syntax-highlighter Prism stylesheet. */
  prism: Record<string, CSSProperties>;
  /** Git-graph lane colors, in order. */
  gitLanes: string[];
}

// ---- Prism builder: palette -> full Prism stylesheet (matches FileViewer's map) ----
interface SynPalette {
  base: string; comment: string; punct: string; prop: string;
  tag: string; num: string; str: string; builtin: string; keyword: string;
}
function makePrism(p: SynPalette): Record<string, CSSProperties> {
  return {
    'code[class*="language-"]': {
      color: p.base, background: "none",
      fontFamily: '"SF Mono", SFMono-Regular, Menlo, monospace',
      fontSize: "12px", lineHeight: "1.5", whiteSpace: "pre", tabSize: 4,
    },
    'pre[class*="language-"]': { color: p.base, background: "none", margin: 0 },
    comment: { color: p.comment, fontStyle: "italic" },
    prolog: { color: p.comment },
    doctype: { color: p.comment },
    cdata: { color: p.comment },
    punctuation: { color: p.punct },
    property: { color: p.prop },
    tag: { color: p.tag },
    boolean: { color: p.num },
    number: { color: p.num },
    constant: { color: p.num },
    symbol: { color: p.num },
    deleted: { color: p.tag },
    selector: { color: p.str },
    "attr-name": { color: p.num },
    string: { color: p.str },
    char: { color: p.str },
    builtin: { color: p.builtin },
    inserted: { color: p.str },
    operator: { color: p.punct },
    entity: { color: p.builtin },
    url: { color: p.builtin },
    variable: { color: p.base },
    atrule: { color: p.keyword },
    "attr-value": { color: p.str },
    keyword: { color: p.keyword },
    function: { color: p.prop },
    "class-name": { color: p.builtin },
    regex: { color: p.num },
    important: { color: p.tag, fontWeight: "bold" },
  };
}

export const THEMES: Record<ThemeId, Theme> = {
  "warm-near-black": {
    id: "warm-near-black",
    label: "Warm Near-Black",
    appearance: "dark",
    cssVars: {
      "--accent": "#ce8a6e",
      "--sidebar-bg": "#1b1917",
      "--selection-bg": "#272523",
      "--panel-bg": "#151110",
      "--text-bright": "#ece8e4",
      "--text-mid": "#968d86",
      "--text-dim": "#5e574f",
      "--border": "#2a2522",
      "--green": "#88b07c",
      "--red": "#c97a72",
      "--amber": "#c2a063",
      "--pill-needs-bg": "#2a1c13",
      "--pill-needs-text": "#e0a580",
      "--chip-bg": "#241a13",
      "--chip-text": "#c99b86",
      "--term-bg": "#151110",
      "--term-fg": "#d2ccc4",
      "--hover": "rgba(255,255,255,0.03)",
      "--tag-chip-bg": "#20271a",
      "--tag-chip-text": "#88b07c",
    },
    terminal: {
      background: "#151110", foreground: "#d2ccc4", cursor: "#ce8a6e",
      cursorAccent: "#151110", selectionBackground: "#33302c",
      black: "#15161e", red: "#c97a72", green: "#88b07c", yellow: "#c2a063",
      blue: "#ce8a6e", magenta: "#b98ba6", cyan: "#7fa6a0", white: "#a9a199",
      brightBlack: "#4a4540", brightRed: "#c97a72", brightGreen: "#88b07c",
      brightYellow: "#c2a063", brightBlue: "#ce8a6e", brightMagenta: "#b98ba6",
      brightCyan: "#7fa6a0", brightWhite: "#d2ccc4",
    },
    prism: makePrism({
      base: "#d2ccc4", comment: "#5e574f", punct: "#968d86", prop: "#ce8a6e",
      tag: "#c97a72", num: "#c2a063", str: "#88b07c", builtin: "#7fa6a0", keyword: "#b98ba6",
    }),
    gitLanes: ["#ce8a6e", "#88b07c", "#c2a063", "#b98ba6", "#7fa6a0", "#c97a72", "#9c8bd0", "#d2ccc4"],
  },

  "warm-dim": {
    id: "warm-dim",
    label: "Warm Dim",
    appearance: "dark",
    cssVars: {
      "--accent": "#d2906f",
      "--sidebar-bg": "#2a2420",
      "--selection-bg": "#383029",
      "--panel-bg": "#211d1a",
      "--text-bright": "#ece6df",
      "--text-mid": "#ab9f95",
      "--text-dim": "#75695f",
      "--border": "#3b332c",
      "--green": "#8fb37f",
      "--red": "#ce8079",
      "--amber": "#c8a667",
      "--pill-needs-bg": "#3a2818",
      "--pill-needs-text": "#e7ab83",
      "--chip-bg": "#342618",
      "--chip-text": "#d2a78f",
      "--term-bg": "#211d1a",
      "--term-fg": "#d8d2ca",
      "--hover": "rgba(255,255,255,0.03)",
      "--tag-chip-bg": "#28321d",
      "--tag-chip-text": "#8fb37f",
    },
    terminal: {
      background: "#211d1a", foreground: "#d8d2ca", cursor: "#d2906f",
      cursorAccent: "#211d1a", selectionBackground: "#3f372f",
      black: "#2a2420", red: "#ce8079", green: "#8fb37f", yellow: "#c8a667",
      blue: "#d2906f", magenta: "#c093ad", cyan: "#86ada6", white: "#ab9f95",
      brightBlack: "#5b5249", brightRed: "#ce8079", brightGreen: "#8fb37f",
      brightYellow: "#c8a667", brightBlue: "#d2906f", brightMagenta: "#c093ad",
      brightCyan: "#86ada6", brightWhite: "#ece6df",
    },
    prism: makePrism({
      base: "#d8d2ca", comment: "#75695f", punct: "#ab9f95", prop: "#d2906f",
      tag: "#ce8079", num: "#c8a667", str: "#8fb37f", builtin: "#86ada6", keyword: "#c093ad",
    }),
    gitLanes: ["#d2906f", "#8fb37f", "#c8a667", "#c093ad", "#86ada6", "#ce8079", "#a796d8", "#d8d2ca"],
  },

  "warm-light": {
    id: "warm-light",
    label: "Warm Light",
    appearance: "light",
    cssVars: {
      "--accent": "#b5613f",
      "--sidebar-bg": "#efe7da",
      "--selection-bg": "#e4d8c6",
      "--panel-bg": "#f6f1e9",
      "--text-bright": "#2c2622",
      "--text-mid": "#6f655a",
      "--text-dim": "#9c9286",
      "--border": "#ddd2c2",
      "--green": "#5d7c4d",
      "--red": "#b04a42",
      "--amber": "#8f6a25",
      "--pill-needs-bg": "#f0dcc8",
      "--pill-needs-text": "#9a4f2c",
      "--chip-bg": "#ece0cf",
      "--chip-text": "#8a5a3f",
      "--term-bg": "#f6f1e9",
      "--term-fg": "#41382f",
      "--hover": "rgba(0,0,0,0.04)",
      "--tag-chip-bg": "#dfe7d2",
      "--tag-chip-text": "#4f6a3f",
    },
    terminal: {
      background: "#f6f1e9", foreground: "#41382f", cursor: "#b5613f",
      cursorAccent: "#f6f1e9", selectionBackground: "#e0d2bd",
      black: "#41382f", red: "#b04a42", green: "#5d7c4d", yellow: "#8f6a25",
      blue: "#b5613f", magenta: "#8c5878", cyan: "#3f7a72", white: "#6f655a",
      brightBlack: "#9c9286", brightRed: "#b04a42", brightGreen: "#5d7c4d",
      brightYellow: "#8f6a25", brightBlue: "#b5613f", brightMagenta: "#8c5878",
      brightCyan: "#3f7a72", brightWhite: "#2c2622",
    },
    prism: makePrism({
      base: "#41382f", comment: "#9c9286", punct: "#6f655a", prop: "#b5613f",
      tag: "#b04a42", num: "#8f6a25", str: "#5d7c4d", builtin: "#3f7a72", keyword: "#8c5878",
    }),
    gitLanes: ["#b5613f", "#5d7c4d", "#8f6a25", "#8c5878", "#3f7a72", "#b04a42", "#6a55b0", "#2c2622"],
  },
};

export const DEFAULT_THEME_ID: ThemeId = "warm-near-black";
const STORAGE_KEY = "conduit.theme";
const VALID_PREFS: ThemePref[] = ["warm-near-black", "warm-dim", "warm-light", "auto"];

// ---- system appearance (synchronous via matchMedia → enables no-flash boot) ----
export function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Calls `cb` whenever the OS light/dark appearance changes. Returns an unsubscribe fn. */
export function watchSystemTheme(cb: (dark: boolean) => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = (e: MediaQueryListEvent) => cb(e.matches);
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

export function resolveThemeId(pref: ThemePref, systemDark: boolean): ThemeId {
  if (pref === "auto") return systemDark ? "warm-near-black" : "warm-light";
  return pref;
}

// ---- persistence ----
export function readStoredPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY) as ThemePref | null;
    return v && VALID_PREFS.includes(v) ? v : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export function writeStoredPref(pref: ThemePref): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* private mode / quota — non-fatal */
  }
}

// ---- live terminal registry ----
const liveTerminals = new Set<Xterm>();
let currentId: ThemeId = DEFAULT_THEME_ID;

/** Register a terminal so applyTheme can recolor it live. Returns an unregister fn. */
export function registerTerminal(term: Xterm): () => void {
  liveTerminals.add(term);
  term.options.theme = THEMES[currentId].terminal;
  return () => {
    liveTerminals.delete(term);
  };
}

export function currentTerminalTheme(): ITheme {
  return THEMES[currentId].terminal;
}

// ---- the one mutation that recolors the whole app ----
export function applyTheme(id: ThemeId): void {
  const theme = THEMES[id];
  currentId = id;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(theme.cssVars)) {
    root.style.setProperty(name, value);
  }
  root.dataset.theme = id;
  for (const term of liveTerminals) {
    term.options.theme = theme.terminal;
    term.refresh(0, term.rows - 1);
  }
}
