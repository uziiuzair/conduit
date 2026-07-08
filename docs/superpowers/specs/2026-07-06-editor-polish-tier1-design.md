# Editor Polish Tier 1 — Design

**Date:** 2026-07-06 · **Status:** implemented alongside this spec (single small PR)

A VS Code feature-gap audit of the 0.5.0 editor produced a "Tier 1" list: the
editor features that should be cheap because they live inside the `monaco-editor`
dependency we already ship. Implementing it surfaced a finding that corrects §8 of
`2026-07-02-monaco-editor-design.md`, recorded here first because every other
decision follows from it.

## 1. Finding: the "slim" Monaco entry was never slim

The Monaco design locked "slim `editor.api.js` + basic-languages Monarch only, no
feature contribs." That intent **does not hold in monaco-editor 0.55.1**:

- `basic-languages/_.contribution.js` — statically imported by every
  `<lang>.contribution.js` we list in `src/monaco/setup.ts` — itself statically
  imports the **entire edcore contrib set** (find, folding, comment, multicursor,
  suggest, quick-access/F1, context menu, …; see the import list at the top of that
  file in `node_modules`).
- Consequence: all of those contribs have been in the production bundle **and
  registered at app startup** since 0.5.0 shipped. ⌘F/find, ⌘/, ⌘D, ⌥↑/↓, folding,
  the editor context menu, and even the F1 command palette already worked.
- Verified by building `main` and this branch and comparing bundles: the action-id
  string literals (`actions.find`, `editor.action.commentLine`, `editor.unfoldAll`,
  …) are present in both; the size delta of this change is ≈ +0.7 kB raw / +0.2 kB
  gzip on a 4,372 kB / 1,144 kB bundle. Bundling the bare `editor.api.js` entry in
  isolation confirms the contribs come from the `_.contribution.js` side-door, not
  from the API entry.

This looks like an upstream packaging accident (it defeats monaco's own
feature-selection story), so it may be fixed in any future monaco release — at
which point every feature Conduit's menus and muscle memory rely on would vanish
silently on a version bump.

## 2. Decision: pin the contribs Conduit depends on

`setup.ts` now explicitly imports the 16 contribs Conduit's UX depends on (find,
folding, comment, multicursor, linesOperations, wordOperations, bracketMatching,
wordHighlighter, smartSelect, links, unicodeHighlighter, contextmenu, stickyScroll,
clipboard, hover, readOnlyMessage). Today these are runtime no-ops (already loaded
via the side-door) and cost ~0 bytes; their purpose is forward-compatibility. We
deliberately do **not** import `edcore.main.js`: when the side-door closes we want
to keep this hand-picked set, not re-inherit suggest/codelens/rename/quick-access
by default.

## 3. Actual behavior changes in this PR

| Change | Where | Note |
| --- | --- | --- |
| Bracket-pair guides (`guides.bracketPairs: "active"`) | `CodeEditorPane.tsx` create options | colorization itself was already on (core default) |
| Themed bracket colors (`editorBracketHighlight.foreground1..3`, guide actives, unexpected) | `defineConduitThemes` | cycled from the terminal ANSI palette like the token rules |
| Whitespace shown in selection only | same options | was `"none"`; `"selection"` has zero ambient noise |
| ⌘-click links open the system browser | `initMonaco` → `registerLinkOpener` | links contrib was active but fell back to `window.open`, which the Tauri webview doesn't route anywhere; routes through the existing http(s)-only `open_external` command (scheme check case-insensitive) |
| "Find and Replace" menu item | `menu.rs` + App.tsx `menu` handler | accelerator ⌥⌘F on macOS only — on Windows Ctrl+Alt+F is AltGr+F in Win32 accelerator matching and would swallow characters typed into terminals; no-ops on read-only editors (the action's implementation bails on `EditorOption.readOnly`) |

`stickyScroll: { enabled: true }` is set explicitly but is **not** a behavior change:
monaco 0.55.1 already defaults sticky scroll on, and its `outlineModel` source falls
back to the indentation model when no symbol providers are registered
(`stickyScrollModelProvider.js` fall-through). The option is a pin like the contrib
imports — it survives an upstream default flip.

## 4. Non-goals (unchanged from the audit)

Language services/LSP, format-on-save (separately spec'd as a deferred item),
minimap, autosave, and any new dependency. `cargo fmt --check` currently fails on
16 pre-existing diffs on `main` (local rustfmt 1.8.0 vs whatever formatted the
repo); this PR does not reformat unrelated files.

## 5. Follow-up worth its own spec

Since the side-door ships the full contrib set anyway (suggest popups, F1 palette,
⌃G goto-line are all live today), a future decision is whether to (a) embrace that
surface and expose it (palette/goto-line menu items), or (b) chase a truly slim
bundle by importing tokenizers via `<lang>.js` directly. Either direction should be
a deliberate spec, not a side effect of a monaco bump.
