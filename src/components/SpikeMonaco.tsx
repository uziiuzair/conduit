// src/components/SpikeMonaco.tsx — THROWAWAY (Phase 0 spike). Deleted in the revert task.
// Mounts ONE Monaco editor as a full-panel overlay with a toolbar to switch language
// (proves Monarch parity for FileViewer's languages) and theme (proves defineTheme/setTheme).
import { useEffect, useRef } from "react";
import { monaco, initMonaco, monacoThemeIdFor, languageFor } from "../monaco/setup";
import { useStore } from "../store";
import type { ThemeId } from "../themes";

interface Sample {
  label: string;
  path: string;
  content: string;
}

const SAMPLES: Sample[] = [
  {
    label: "TS",
    path: "sample.ts",
    content:
      'interface User { id: number; name: string }\n' +
      'const greet = (u: User): string => `hi ${u.name}`; // comment\n' +
      'export const answer = 42;\n',
  },
  {
    label: "Rust",
    path: "sample.rs",
    content:
      '// atomic write demo\nuse std::fs;\nfn main() {\n' +
      '    let msg = "hello";\n    let n: u64 = 24 * 1024 * 1024;\n' +
      '    println!("{msg} {n}");\n}\n',
  },
  {
    label: "Python",
    path: "sample.py",
    content: 'def add(a: int, b: int) -> int:\n    """sum"""\n    return a + b  # comment\n\nprint(add(1, 2))\n',
  },
  {
    label: "Go",
    path: "sample.go",
    content: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tconst n = 42 // comment\n\tfmt.Println("hi", n)\n}\n',
  },
  {
    label: "JSON",
    path: "sample.json",
    content: '{\n  "name": "conduit",\n  "version": "0.4.0",\n  "nested": { "ok": true, "n": 3 }\n}\n',
  },
  {
    label: "YAML",
    path: "sample.yaml",
    content: '# config\nname: conduit\nlist:\n  - one\n  - two\nnested:\n  enabled: true\n',
  },
  {
    label: "Markdown",
    path: "sample.md",
    content: '# Title\n\nSome **bold** and `code` and a [link](https://example.com).\n\n- item one\n- item two\n',
  },
  {
    label: "Shell",
    path: "sample.sh",
    content: '#!/usr/bin/env bash\nset -euo pipefail\nname="world" # comment\necho "hello $name"\n',
  },
  {
    label: "CSS",
    path: "sample.css",
    content: '.term-stack {\n  position: absolute; /* comment */\n  inset: 0;\n  color: #ce8a6e;\n}\n',
  },
  {
    label: "HTML",
    path: "sample.html",
    content: '<!doctype html>\n<html>\n  <body class="app">\n    <h1>Conduit</h1>\n  </body>\n</html>\n',
  },
];

export function SpikeMonaco() {
  const hostRef = useRef<HTMLDivElement>(null);
  const edRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const activeThemeId = useStore((s) => s.activeThemeId);

  // Create the editor exactly once (mirrors Terminal.tsx create-once).
  useEffect(() => {
    initMonaco();
    const host = hostRef.current;
    if (!host) return;
    const first = SAMPLES[0];
    const ed = monaco.editor.create(host, {
      model: monaco.editor.createModel(first.content, languageFor(first.path)),
      automaticLayout: true,
      minimap: { enabled: true },
      fontFamily: '"SF Mono", SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      scrollBeyondLastLine: false,
    });
    monaco.editor.setTheme(monacoThemeIdFor(useStore.getState().activeThemeId));
    edRef.current = ed;
    return () => {
      ed.getModel()?.dispose();
      ed.dispose();
      edRef.current = null;
    };
  }, []);

  // Follow the app theme too (proves setTheme reflects a live Conduit theme change).
  useEffect(() => {
    if (edRef.current) monaco.editor.setTheme(monacoThemeIdFor(activeThemeId));
  }, [activeThemeId]);

  const pick = (s: Sample) => {
    const ed = edRef.current;
    if (!ed) return;
    const old = ed.getModel();
    ed.setModel(monaco.editor.createModel(s.content, languageFor(s.path)));
    old?.dispose();
  };

  const setTheme = (id: ThemeId) => monaco.editor.setTheme(monacoThemeIdFor(id));

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        background: "var(--panel-bg)",
      }}
    >
      <div style={{ display: "flex", gap: 6, padding: 6, flexWrap: "wrap", borderBottom: "1px solid var(--border)" }}>
        <span style={{ color: "var(--text-dim)", fontSize: 11, alignSelf: "center" }}>SPIKE:</span>
        {SAMPLES.map((s) => (
          <button key={s.path} className="header-btn" onClick={() => pick(s)}>
            {s.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {(["warm-near-black", "warm-dim", "warm-light"] as ThemeId[]).map((id) => (
          <button key={id} className="header-btn" onClick={() => setTheme(id)}>
            {id}
          </button>
        ))}
      </div>
      <div ref={hostRef} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}
