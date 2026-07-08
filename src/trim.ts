// src/trim.ts — pure "Clean Whitespace on Save" computations. NO monaco / Tauri
// imports so vitest can exercise them in a node env; store.ts maps the results onto
// undo-preserving model edits (pushEditOperations).

/** One trailing-whitespace deletion, 1-based like Monaco ranges:
 *  delete [fromColumn, endColumn) on `lineNumber`. */
export interface TrimEdit {
  lineNumber: number;
  fromColumn: number;
  endColumn: number;
}

export interface WhitespaceCleanup {
  trims: TrimEdit[];
  /** Append one EOL at the end of the document (computed on the POST-trim text, so a
   *  whitespace-only last line never gains a stray blank line). */
  appendFinalNewline: boolean;
}

/** Compute cleanup edits from `model.getLinesContent()` (a doc ending in a newline
 *  yields a final empty line, so "last line non-empty" == "missing final newline").
 *  `trimTrailing: false` is the markdown case — trailing double-space is a hard
 *  line break there, but the final newline still applies. */
export function cleanupEdits(lines: string[], opts: { trimTrailing: boolean }): WhitespaceCleanup {
  const trims: TrimEdit[] = [];
  if (opts.trimTrailing) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const kept = line.replace(/[ \t]+$/, "").length;
      if (kept !== line.length) {
        trims.push({ lineNumber: i + 1, fromColumn: kept + 1, endColumn: line.length + 1 });
      }
    }
  }
  let last = lines[lines.length - 1] ?? "";
  if (opts.trimTrailing) last = last.replace(/[ \t]+$/, "");
  return { trims, appendFinalNewline: lines.length > 0 && last.length > 0 };
}
