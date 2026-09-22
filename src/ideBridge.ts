// Pure helpers for the Conduit-as-IDE bridge (2026-09-23 spec): the editor-context
// shape pushed down to Rust, and the pending-diff queue the DiffReviewOverlay renders.
// Importable WITHOUT store.ts on purpose — the node-env vitest can't touch a module
// that reads localStorage at import time (same rule as usageRows.ts).

/** Selection in claude's own `selection_changed` shape — built here once so the Rust
 * side forwards it verbatim and never remaps fields. Lines/characters are 0-based
 * (Monaco is 1-based; the caller converts). */
export type IdeSelection = {
  text: string;
  filePath: string;
  fileUrl: string;
  selection: {
    start: { line: number; character: number };
    end: { line: number; character: number };
    isEmpty: boolean;
  };
};

export type IdeEditorContext = {
  activeFile: string | null;
  selection: IdeSelection | null;
  openFiles: { path: string; label: string; languageId: string; active: boolean }[];
  diagnostics: unknown[];
};

export function buildEditorContext(args: {
  openPaths: { path: string; language: string; active: boolean }[];
  selection: IdeSelection | null;
  markers: unknown[];
}): IdeEditorContext {
  const openFiles = args.openPaths.map((f) => ({
    path: f.path,
    label: f.path.split("/").pop() ?? f.path,
    languageId: f.language,
    active: f.active,
  }));
  return {
    activeFile: openFiles.find((f) => f.active)?.path ?? null,
    selection: args.selection,
    openFiles,
    diagnostics: args.markers,
  };
}

/** One parked openDiff, exactly the `ide-open-diff` event payload. */
export type PendingDiff = {
  sessionId: string;
  diffId: string;
  oldFilePath: string;
  newFilePath: string;
  newFileContents: string;
  tabName: string;
};

/** FIFO per session: the first entry for a session is the visible one; later
 * requests queue behind it. All pure — the store owns the array. */
export function pushDiff(q: PendingDiff[], d: PendingDiff): PendingDiff[] {
  if (q.some((x) => x.sessionId === d.sessionId && x.diffId === d.diffId)) return q;
  return [...q, d];
}

export function popDiff(q: PendingDiff[], sessionId: string, diffId: string): PendingDiff[] {
  return q.filter((x) => !(x.sessionId === sessionId && x.diffId === diffId));
}

/** `close_tab` (tabName) / `closeAllDiffTabs` (null) from claude: the review is moot —
 * the user answered in the terminal, or claude moved on. Drop without a verdict. */
export function closeDiffs(
  q: PendingDiff[],
  sessionId: string,
  tabName: string | null,
): PendingDiff[] {
  return q.filter(
    (x) => x.sessionId !== sessionId || (tabName !== null && x.tabName !== tabName),
  );
}

export function visibleDiff(q: PendingDiff[], sessionId: string): PendingDiff | null {
  return q.find((x) => x.sessionId === sessionId) ?? null;
}
