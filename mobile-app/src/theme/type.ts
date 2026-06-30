/**
 * Type scale aligned to Apple's Human Interface Guidelines text styles (points).
 * React Native font sizes are density-independent and map ~1:1 to iOS points.
 * Floor is 11pt (HIG Caption 2); body/headline is 17pt.
 */
export const TYPE = {
  largeTitle: 32,
  title: 28,
  title3: 20,
  headline: 17,
  body: 17,
  callout: 16,
  subhead: 15,
  footnote: 13,
  caption: 12,
  micro: 11,
} as const;

/** Minimum comfortable touch target per Apple HIG (points). */
export const MIN_TOUCH = 44;

/** System monospace face for code/paths. */
export const MONO = "Menlo";
