import { meterLevel, meterTitle } from "../contextMeter";
import type { ContextUsage } from "../store";

/**
 * How full a session's context window is, as a hairline along the bottom edge of its tab.
 *
 * Absent usage draws nothing at all rather than an empty track: a session with no transcript
 * yet, or one running a non-Claude agent, has no fill to report, and an empty bar would read
 * as "0% used" — a claim we cannot make.
 */
export function ContextMeter({ usage }: { usage: ContextUsage | undefined }) {
  if (!usage) return null;
  return (
    <span
      className={`tab-ctx ${meterLevel(usage.fraction)}`}
      title={meterTitle(usage)}
      aria-hidden
    >
      {/* Scaled rather than width-sized: the fill animates on the compositor, and a tab
          strip that reflows every time a token count ticks would be a strange thing to
          have built. */}
      <span className="tab-ctx-fill" style={{ transform: `scaleX(${usage.fraction})` }} />
    </span>
  );
}
