import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { useStore } from "../store";
import { THEMES } from "../themes";

interface FileContent {
  content: string;
  truncated: boolean;
  binary: boolean;
}

// Beyond this, skip highlighting (Prism gets slow on huge files) → plain text.
const MAX_HIGHLIGHT_LINES = 5000;

// File extension / name → Prism language id.
const EXT_LANG: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
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
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup", svelte: "markup",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  yml: "yaml", yaml: "yaml",
  toml: "toml",
  sql: "sql",
  graphql: "graphql", gql: "graphql",
  lua: "lua",
  dart: "dart",
  rb_: "ruby",
  scala: "scala",
  r: "r",
  pl: "perl",
  ex: "elixir", exs: "elixir",
};

function languageFor(path: string): string | undefined {
  const name = (path.split("/").pop() || "").toLowerCase();
  if (name.startsWith("dockerfile")) return "docker";
  if (name.startsWith("makefile")) return "makefile";
  if (name === ".gitignore" || name === ".dockerignore" || name === ".env" || name.startsWith(".env."))
    return "bash";
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return EXT_LANG[ext];
}

export function FileViewer({
  path,
  visible,
  style,
}: {
  path: string;
  visible: boolean;
  style?: React.CSSProperties;
}) {
  const [data, setData] = useState<FileContent | null>(null);
  const prismTheme = THEMES[useStore((s) => s.activeThemeId)].prism;

  useEffect(() => {
    let alive = true;
    setData(null);
    void invoke<FileContent>("read_file", { path })
      .then((d) => alive && setData(d))
      .catch(
        () =>
          alive &&
          setData({ content: "(failed to read file)", truncated: false, binary: false }),
      );
    return () => {
      alive = false;
    };
  }, [path]);

  const lineCount = data ? data.content.split("\n").length : 0;
  const tooBig = lineCount > MAX_HIGHLIGHT_LINES;
  const lang = languageFor(path);

  return (
    <div className={`file-viewer ${visible ? "visible" : "hidden"}`} style={style}>
      {data?.truncated && (
        <div className="fv-note">Showing the first 1 MB of a larger file.</div>
      )}
      {data === null ? (
        <p className="placeholder" style={{ padding: 14 }}>
          Loading…
        </p>
      ) : data.binary || tooBig || !lang ? (
        <SyntaxHighlighter
          language={lang && !tooBig ? lang : "text"}
          style={prismTheme}
          showLineNumbers={!data.binary}
          customStyle={fvCustomStyle}
          lineNumberStyle={fvLineNumberStyle}
          codeTagProps={{ style: { fontFamily: "inherit" } }}
        >
          {data.content}
        </SyntaxHighlighter>
      ) : (
        <SyntaxHighlighter
          language={lang}
          style={prismTheme}
          showLineNumbers
          customStyle={fvCustomStyle}
          lineNumberStyle={fvLineNumberStyle}
          codeTagProps={{ style: { fontFamily: "inherit" } }}
        >
          {data.content}
        </SyntaxHighlighter>
      )}
    </div>
  );
}

const fvCustomStyle: React.CSSProperties = {
  margin: 0,
  padding: "8px 0",
  background: "transparent",
  fontSize: "12px",
  overflow: "visible",
};

const fvLineNumberStyle: React.CSSProperties = {
  minWidth: "3.2em",
  paddingRight: "1em",
  color: "var(--text-dim)",
  userSelect: "none",
};
