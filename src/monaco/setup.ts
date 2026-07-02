// src/monaco/setup.ts — Phase 0 SPIKE (throwaway harness; kept as Phase 1 notes).
//
// Proves the locked bundling decision from the design (§8): hand-wrap Monaco like
// xterm, import the SLIM editor.api + basic-languages Monarch tokenizers, and wire
// ONLY the local editor.worker via Vite `?worker` (NO CDN, NO language workers, NO
// @monaco-editor/react). Also proves defineTheme + setTheme reflect the Conduit palette.
//
// If the slim editor.api import misbehaves in the PACKAGED build (Task 0.4 offline gate),
// swap the first import for `import * as monaco from "monaco-editor";` (still editor.worker
// only) and record it here as the locked Phase 1 choice.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
// Main-thread Monarch tokenizers for the languages FileViewer covered (ts/rust/python/
// go/yaml/markdown/shell/css/html/...). Side-effect registration — must stay top-level.
//
// ADAPTATION vs the design snippet: monaco-editor 0.55.1 has NO single
// "basic-languages/monaco.contribution" aggregator module (that file does not exist in
// this version's package — verified against node_modules). Each language instead ships
// its own "<lang>/<lang>.contribution.js" that self-registers via _.contribution.js's
// registerLanguage(). So we import each one explicitly, matching languageFor()'s id set.
// Also note: this package.json's "exports" map ("./*": "./*") requires the literal file
// extension in every deep-import specifier — omitting ".js" fails module resolution.
// "json" and "makefile" have no basic-languages Monarch grammar in this version (JSON's
// tokenizer lives only in the full vs/language/json service, which we're deliberately
// not importing); those two language ids render with default/no tokenization — acceptable
// for this Phase 0 spike.
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution.js";
import "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js";
import "monaco-editor/esm/vs/basic-languages/php/php.contribution.js";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution.js";
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js";
import "monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js"; // registers both "c" and "cpp"
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js";
import "monaco-editor/esm/vs/basic-languages/less/less.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js"; // also used for "toml"
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/lua/lua.contribution.js";
import "monaco-editor/esm/vs/basic-languages/dart/dart.contribution.js";
import "monaco-editor/esm/vs/basic-languages/scala/scala.contribution.js";
import "monaco-editor/esm/vs/basic-languages/r/r.contribution.js";
import "monaco-editor/esm/vs/basic-languages/perl/perl.contribution.js";
import "monaco-editor/esm/vs/basic-languages/elixir/elixir.contribution.js";
import "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js";
// Local worker, bundled offline by Vite. `?worker` default export is a Worker constructor
// (typed via vite/client in src/vite-env.d.ts). editor.worker is the ONLY worker we ship.
// Extension is required before the `?worker` query for the same package-exports reason
// as above (Vite's resolver follows the same "exports" map as tsc/node).
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";
import { THEMES, type ThemeId, registerMonacoThemeSetter, currentThemeId } from "../themes";
import { setModelFactory, type RegistryModel } from "./registry";

export { monaco };

/** ThemeId -> the Monaco theme name registered by defineConduitThemes(). */
export function monacoThemeIdFor(id: ThemeId): string {
  return `conduit-${id}`;
}

const hx = (c: string): string => c.replace(/^#/, "");

/**
 * Build the 3 Conduit Monaco themes ONCE from the existing THEMES palette via
 * monaco.editor.defineTheme (base vs-dark for dark appearances, vs for light).
 * Token rules are mapped from the terminal ANSI palette, which mirrors the Prism
 * palette FileViewer used — enough to prove theme parity in the spike.
 */
export function defineConduitThemes(): void {
  (Object.keys(THEMES) as ThemeId[]).forEach((id) => {
    const t = THEMES[id];
    const term = t.terminal;
    const fg = term.foreground ?? "#d0d0d0";
    monaco.editor.defineTheme(monacoThemeIdFor(id), {
      base: t.appearance === "dark" ? "vs-dark" : "vs",
      inherit: true,
      rules: [
        { token: "comment", foreground: hx(term.brightBlack ?? fg), fontStyle: "italic" },
        { token: "keyword", foreground: hx(term.magenta ?? fg) },
        { token: "string", foreground: hx(term.green ?? fg) },
        { token: "number", foreground: hx(term.yellow ?? fg) },
        { token: "type", foreground: hx(term.cyan ?? fg) },
        { token: "type.identifier", foreground: hx(term.cyan ?? fg) },
        { token: "delimiter", foreground: hx(term.white ?? fg) },
        { token: "tag", foreground: hx(term.red ?? fg) },
        { token: "attribute.name", foreground: hx(term.yellow ?? fg) },
        { token: "attribute.value", foreground: hx(term.green ?? fg) },
      ],
      colors: {
        "editor.background": term.background ?? "#000000",
        "editor.foreground": fg,
        "editorLineNumber.foreground": term.brightBlack ?? fg,
        "editorCursor.foreground": term.cursor ?? fg,
        "editor.selectionBackground": term.selectionBackground ?? "#3a3a3a",
      },
    });
  });
}

let booted = false;
/**
 * Idempotent boot init. Wires self.MonacoEnvironment.getWorker to the local
 * editor.worker (Vite `?worker`), builds the Conduit themes, and selects the
 * default theme. basic-languages Monarch is already registered by the top-level
 * side-effect import above. Imports NO ts/json/css/html language services.
 */
export function initMonaco(): void {
  if (booted) return;
  booted = true;
  (self as typeof self & { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
  defineConduitThemes();
  // Inject the real Monaco model factory into the framework-agnostic registry.
  setModelFactory((path, value, languageId) =>
    monaco.editor.createModel(value, languageId, monaco.Uri.file(path)) as unknown as RegistryModel,
  );
  // Let themes.ts recolor Monaco live on theme change (one global setTheme).
  registerMonacoThemeSetter((id) => monaco.editor.setTheme(monacoThemeIdFor(id)));
  // Respect the theme the user actually has applied, not just the default.
  monaco.editor.setTheme(monacoThemeIdFor(currentThemeId()));
}

// File name / extension -> MONACO language id (default "plaintext"). Note this is a
// DIFFERENT id set than FileViewer's retired Prism map: "shell" not "bash", "html"
// not "markup", "plaintext" not "text". Reused for both model language and breadcrumb.
const EXT_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  json: "json", jsonc: "json",
  rs: "rust",
  py: "python", pyi: "python",
  go: "go",
  rb: "ruby",
  php: "php",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  swift: "swift",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp",
  css: "css", scss: "scss", sass: "scss", less: "less",
  html: "html", htm: "html", xml: "xml", svg: "xml", vue: "html", svelte: "html",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  yml: "yaml", yaml: "yaml",
  toml: "ini",
  sql: "sql",
  graphql: "graphql", gql: "graphql",
  lua: "lua",
  dart: "dart",
  scala: "scala",
  r: "r",
  pl: "perl",
  ex: "elixir", exs: "elixir",
};

export function languageFor(path: string): string {
  const name = (path.split("/").pop() || "").toLowerCase();
  if (name.startsWith("dockerfile")) return "dockerfile";
  if (name.startsWith("makefile")) return "makefile";
  if (name === ".gitignore" || name === ".dockerignore" || name === ".env" || name.startsWith(".env."))
    return "shell";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return EXT_LANG[ext] ?? "plaintext";
}
