# Markdown Preview — Design

**Date:** 2026-07-07 · **Status:** implemented alongside this spec (single small PR,
stacked on the Tier-1 editor-polish PR)

A "Preview" toggle in the editor breadcrumb that renders the active markdown buffer
as formatted HTML, live-updating as you type. VS Code parity target: the read-side of
its markdown preview (⇧⌘V), not the side-by-side scroll-synced column.

## 1. Shape

- `src/markdown.ts` — `marked` (new runtime dep: zero-dependency, ~45 kB raw /
  ~14 kB gzip on the bundle) parses GFM; a whitelist sanitizer over the **parsed DOM**
  produces the HTML that reaches `dangerouslySetInnerHTML`.
- `src/components/MarkdownPreview.tsx` — overlay that subscribes to the shared
  registry model (`onDidChangeContent`, 150 ms debounce) so the preview tracks the
  LIVE buffer, not the disk file, and works on read-only/truncated buffers too.
- `CodeEditorPane.tsx` — pane-scoped `previewOn` state; breadcrumb toggle button
  (shown only while the active model's language is `markdown`, so a manual retag in
  the language selector shows/hides the affordance); ⇧⌘V in the editor opens the
  preview, ⇧⌘V inside the preview returns to source; ⌘S still saves from either.

The preview is an absolutely-positioned overlay **on top of the still-mounted editor
host** (z-index 4, under the disk-conflict banners at 5). Nothing about the editor's
create-once / model-swap lifecycle changes. Because the covered editor stays mounted,
the preview takes focus whenever it is shown and the pane's programmatic
`editor.focus()` calls are gated by `previewCovers()` — otherwise keystrokes would
edit the buffer invisibly underneath.

## 2. Security: the sanitizer is the boundary

Previewed files are untrusted repo content, the webview ships `csp: null`, and Tauri
IPC is in scope — a script smuggled through a README would execute with native reach.
`marked` deliberately does not sanitize. Defenses, in order:

1. **DOM whitelist sanitizer** (`sanitizeHtml`): parse with `DOMParser`, then walk —
   drop script/style/iframe/object/svg/… with their contents, unwrap unknown tags
   keeping text, strip every attribute not in the per-tag allow-list (which kills all
   `on*` handlers), force task-list inputs to `type=checkbox disabled`.
2. **URL scheme policy** (`schemeOf` strips the control chars browsers ignore, so
   `java\nscript:` doesn't smuggle): links keep `http(s)`/`mailto`/scheme-less;
   images keep `http(s)`/`data:image/*`. Everything else is stripped at sanitize
   time.
3. **Click routing**: the preview `preventDefault`s every anchor click (and
   aux-click) — the webview never navigates; `http(s)` goes to the system browser
   via the existing `open_external` command, which re-validates on the Rust side.

Pinned by `src/markdown.test.ts` (25→ new cases: scheme smuggling, onerror stripping,
iframe/script drop, checkbox forcing). Tests run under a **dev-only** `happy-dom`
environment for this file; the vitest default stays `node`.

## 3. Known limits (accepted)

- **Relative image paths don't render** (alt text shows): a relative `src` would
  resolve against the app origin, never the file's directory. Doing this properly
  needs Tauri's asset protocol + scope decisions — its own spec if wanted.
- **Remote `http(s)` images do load** when the file references them (same trade-off
  VS Code makes by default).
- No scroll sync, no side-by-side split, no syntax highlighting inside fenced code
  blocks (monaco's `colorize` could do the latter later for free).
- `mailto:` links survive sanitization but currently no-op on click
  (`open_external` is http(s)-only by design).
