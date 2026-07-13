// Markdown -> sanitized HTML for the editor's preview mode (MarkdownPreview.tsx).
//
// marked does NOT sanitize: raw HTML in the source passes straight through, and the
// webview runs with `csp: null` plus Tauri IPC in scope — so a script smuggled into a
// previewed README would execute with native reach. Rendering therefore goes through
// a strict whitelist sanitizer over the PARSED DOM (not regexes, not renderer
// overrides): only tags marked itself emits survive, attributes are dropped unless
// per-tag allowed, and URL attributes must pass the scheme policy below.
//
// The policy tables and URL checks are pure and unit-tested in node
// (markdown.test.ts); only sanitizeHtml/renderMarkdown need a browser DOM.

import { Marked } from "marked";

/** Per-tag attribute whitelist. A tag's presence makes the tag itself allowed. */
export const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  a: ["href", "title"],
  blockquote: [],
  br: [],
  code: ["class"],
  del: [],
  em: [],
  h1: [],
  h2: [],
  h3: [],
  h4: [],
  h5: [],
  h6: [],
  hr: [],
  img: ["src", "alt", "title"],
  // Task-list checkboxes ("- [x] done"). filterAttrs forces type=checkbox + disabled.
  input: ["type", "checked", "disabled"],
  li: [],
  ol: ["start"],
  p: [],
  pre: [],
  strong: [],
  table: [],
  tbody: [],
  td: ["align"],
  th: ["align"],
  thead: [],
  tr: [],
  ul: [],
};

/** Tags removed WITH their children (active/loading content). Unknown tags outside
 *  this set are merely unwrapped, keeping their text. */
export const DROP: ReadonlySet<string> = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "object",
  "embed",
  "applet",
  "form",
  "svg",
  "math",
  "link",
  "meta",
  "base",
  "video",
  "audio",
  "source",
  "track",
  "template",
  "slot",
  "dialog",
]);

/** Scheme of a URL after stripping the control/whitespace chars browsers ignore
 *  (defeats "java\nscript:"-style smuggling), or null for scheme-less/relative. */
export function schemeOf(url: string): string | null {
  const compact = url.replace(/[\u0000-\u0020]+/g, "");
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  return m ? m[1].toLowerCase() : null;
}

/** Links: http(s) + mailto open externally; scheme-less (relative, #anchor) is inert
 *  because MarkdownPreview preventDefaults every anchor click. Everything else
 *  (javascript:, file:, custom schemes) is stripped. */
export function isSafeLinkHref(href: string): boolean {
  const s = schemeOf(href);
  return s === null || s === "http" || s === "https" || s === "mailto";
}

/** Images: remote http(s) or inline data:image/*. In an <img> context SVG data URLs
 *  cannot run script. No scheme-less pass-through — a relative src would resolve
 *  against the app origin, not the file's directory, so it can never be right. */
export function isSafeImageSrc(src: string): boolean {
  const s = schemeOf(src);
  if (s === "http" || s === "https") return true;
  return s === "data" && /^data:image\//i.test(src.replace(/[\u0000-\u0020]+/g, ""));
}

const URL_ATTRS: Readonly<Record<string, (v: string) => boolean>> = {
  href: isSafeLinkHref,
  src: isSafeImageSrc,
};

function filterAttrs(el: Element): void {
  const tag = el.tagName.toLowerCase();
  const allowed = ALLOWED[tag] ?? [];
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const urlCheck = URL_ATTRS[name];
    if (!allowed.includes(name) || (urlCheck && !urlCheck(attr.value))) {
      el.removeAttribute(attr.name);
    }
  }
  if (tag === "input") {
    // Only GFM task-list checkboxes, always inert.
    el.setAttribute("type", "checkbox");
    el.setAttribute("disabled", "");
  }
}

function sanitizeChildren(parent: Node): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 8 /* comment */) {
      parent.removeChild(child);
      continue;
    }
    if (child.nodeType !== 1 /* element */) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP.has(tag)) {
      parent.removeChild(el);
      continue;
    }
    sanitizeChildren(el);
    if (tag in ALLOWED) {
      filterAttrs(el);
    } else {
      // Unwrap: promote the (already sanitized) children, drop the tag itself.
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
    }
  }
}

/** Browser-only: whitelist-sanitize an HTML fragment. Exported for the renderer. */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  sanitizeChildren(doc.body);
  return doc.body.innerHTML;
}

// Instance (not the `marked` singleton) so no other module can mutate our options.
const md = new Marked({ gfm: true, breaks: false, async: false });

/** Markdown source -> sanitized HTML string, safe for dangerouslySetInnerHTML. */
export function renderMarkdown(source: string): string {
  return sanitizeHtml(md.parse(source) as string);
}
