// src/format/fallback.ts — the last-resort renderer formatter. Everything here is loaded
// via dynamic import() so prettier + its parsers stay OUT of the initial bundle; the cost
// (a few MB of JS heap, mostly the TypeScript parser) is paid only the first time a
// config-less project is formatted, then module-cached.

import { parserSpecFor, type PrettierOptions } from "./options";

const PLUGIN_LOADERS: Record<string, () => Promise<unknown>> = {
  babel: () => import("prettier/plugins/babel"),
  estree: () => import("prettier/plugins/estree"),
  typescript: () => import("prettier/plugins/typescript"),
  postcss: () => import("prettier/plugins/postcss"),
  html: () => import("prettier/plugins/html"),
  markdown: () => import("prettier/plugins/markdown"),
  yaml: () => import("prettier/plugins/yaml"),
};

/** Format `content` with bundled prettier-standalone. Throws when the file type has no
 *  bundled parser (caller surfaces the message as a toast). */
export async function formatWithFallback(
  path: string,
  content: string,
  options: PrettierOptions,
): Promise<string> {
  const spec = parserSpecFor(path);
  if (!spec) throw new Error("no bundled formatter for this file type");
  const prettier = await import("prettier/standalone");
  const plugins = await Promise.all(spec.plugins.map((k) => PLUGIN_LOADERS[k]()));
  return prettier.format(content, {
    parser: spec.parser,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    plugins: plugins as any,
    ...options,
  });
}
