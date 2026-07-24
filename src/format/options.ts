// src/format/options.ts — pure formatting-option logic. NO monaco / Tauri / prettier
// imports so vitest exercises it in a node env (mirrors src/trim.ts). The store maps
// these onto invoke() calls and undo-preserving model edits.

/** The eight prettier options Conduit's bundled fallback and global config expose.
 *  Keys are prettier's own camelCase names, so they pass straight into standalone. */
export interface PrettierOptions {
  printWidth: number;
  tabWidth: number;
  useTabs: boolean;
  semi: boolean;
  singleQuote: boolean;
  trailingComma: "none" | "es5" | "all";
  bracketSpacing: boolean;
  endOfLine: "lf" | "crlf" | "cr" | "auto";
}

/** Conduit's out-of-the-box global config (= prettier 3 defaults). */
export const DEFAULT_FORMAT_CONFIG: PrettierOptions = {
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  bracketSpacing: true,
  endOfLine: "lf",
};

export interface ParserSpec {
  /** prettier parser id */
  parser: string;
  /** plugin loader keys (see src/format/fallback.ts PLUGIN_LOADERS) */
  plugins: string[];
}

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Map a path to the prettier parser + plugin set the bundled fallback needs. Mirrors
 *  format.rs PRETTIER_EXTS. Returns null for anything prettier's standalone can't handle. */
export function parserSpecFor(path: string): ParserSpec | null {
  switch (extOf(path)) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return { parser: "babel", plugins: ["babel", "estree"] };
    case "ts":
    case "tsx":
      return { parser: "typescript", plugins: ["typescript", "estree"] };
    case "json":
    case "jsonc":
      return { parser: "json", plugins: ["babel", "estree"] };
    case "css":
      return { parser: "css", plugins: ["postcss"] };
    case "scss":
      return { parser: "scss", plugins: ["postcss"] };
    case "less":
      return { parser: "less", plugins: ["postcss"] };
    case "html":
      return { parser: "html", plugins: ["html"] };
    case "vue":
      return { parser: "vue", plugins: ["html"] };
    case "md":
    case "markdown":
      return { parser: "markdown", plugins: ["markdown"] };
    case "yaml":
    case "yml":
      return { parser: "yaml", plugins: ["yaml"] };
    default:
      return null;
  }
}

/** True when SOME formatter applies (prettier fallback OR shell-out rustfmt/gofmt).
 *  Mirrors format.rs formatter_for — gates the toolbar button and format-on-save. */
export function hasFormatter(path: string): boolean {
  if (parserSpecFor(path)) return true;
  const e = extOf(path);
  return e === "rs" || e === "go";
}

/** Precedence merge: project config (from .prettierrc) overrides the global config;
 *  fields the project omits fall back to global. Global always has all eight fields. */
export function mergeFormatOptions(
  project: Partial<PrettierOptions> | null,
  global: PrettierOptions,
): PrettierOptions {
  return { ...global, ...(project ?? {}) };
}
