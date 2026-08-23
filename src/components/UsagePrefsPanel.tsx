import { useStore, type UsagePrefs } from "../store";

const LAYOUTS: Array<{ id: UsagePrefs["layout"]; label: string; hint: string }> = [
  { id: "selected", label: "Selected session only", hint: "Just the current session's account (default)." },
  { id: "stacked", label: "Stacked (all accounts)", hint: "Every account's meters, one block each." },
  { id: "summary", label: "Collapsed summary", hint: "One line per account; click to expand." },
  { id: "lowAlertOnly", label: "Low alerts only", hint: "Only accounts running low." },
];

/** The two honest readings of a quota. "used" first because it is the default and the one
 *  every agent's own usage view uses; "remaining" is a genuine preference, not a wrong one. */
const METRICS: Array<{ id: UsagePrefs["metric"]; label: string; hint: string }> = [
  {
    id: "used",
    label: "Amount used",
    hint: 'Bars fill as you consume, e.g. "18% used" — matches claude /usage and most quota dashboards.',
  },
  {
    id: "remaining",
    label: "Amount left",
    hint: 'Bars drain as you consume, e.g. "82% left" — a fuel-gauge reading.',
  },
];

const WINDOWS: Array<{ id: keyof UsagePrefs["windows"]; label: string }> = [
  // Worded exactly as the meters label themselves (see `windowLabel`) so the filter and the
  // panel are obviously talking about the same rows.
  { id: "fiveHour", label: "5-hour" },
  { id: "weekly", label: "Weekly" },
  { id: "weeklyOpus", label: "Weekly · Opus — Claude only" },
  { id: "context", label: "Context — agy only" },
];

/** Settings → Usage display: how the bottom-left usage bar renders. Purely cosmetic. */
export function UsagePrefsPanel() {
  const prefs = useStore((s) => s.usagePrefs);
  const setUsagePrefs = useStore((s) => s.setUsagePrefs);

  return (
    <div className="usage-prefs">
      <p className="settings-intro">
        Choose how the usage bar in the bottom-left shows your accounts. These are display
        preferences only.
      </p>

      <div className="usage-prefs-section">
        <div className="usage-prefs-title">Layout</div>
        <div className="agent-list">
          {LAYOUTS.map((l) => (
            <div key={l.id} className={`agent-list-row ${prefs.layout === l.id ? "def" : ""}`}>
              <button
                className="agent-radio"
                role="radio"
                aria-checked={prefs.layout === l.id}
                aria-label={l.label}
                onClick={() => setUsagePrefs({ layout: l.id })}
              />
              <div className="agent-list-main">
                <div className="agent-list-name">{l.label}</div>
                <div className="agent-list-meta">{l.hint}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="usage-prefs-section">
        <div className="usage-prefs-title">Meters show</div>
        <div className="agent-list">
          {METRICS.map((m) => (
            <div key={m.id} className={`agent-list-row ${prefs.metric === m.id ? "def" : ""}`}>
              <button
                className="agent-radio"
                role="radio"
                aria-checked={prefs.metric === m.id}
                aria-label={m.label}
                onClick={() => setUsagePrefs({ metric: m.id })}
              />
              <div className="agent-list-main">
                <div className="agent-list-name">{m.label}</div>
                <div className="agent-list-meta">{m.hint}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="agent-list-meta">
          Applies to the number and the bar together, everywhere — they always read the same
          way. Colour still warns on consumption whichever you pick.
        </div>
      </div>

      <div className="usage-prefs-section">
        <div className="usage-prefs-title">Windows to show</div>
        <div className="usage-prefs-checks">
          {WINDOWS.map((w) => (
            <label key={w.id} className="account-tag-check">
              <input
                type="checkbox"
                checked={prefs.windows[w.id]}
                onChange={(e) =>
                  setUsagePrefs({ windows: { ...prefs.windows, [w.id]: e.target.checked } })
                }
              />
              {w.label}
            </label>
          ))}
        </div>
      </div>

      <div className="usage-prefs-section">
        <div className="usage-prefs-title">Sort accounts by</div>
        <select
          className="account-select"
          value={prefs.sort}
          onChange={(e) => setUsagePrefs({ sort: e.target.value as UsagePrefs["sort"] })}
        >
          <option value="critical">Most critical first</option>
          <option value="label">Name (A–Z)</option>
        </select>
      </div>

      <div className="usage-prefs-section">
        <div className="usage-prefs-title">
          "Low" threshold: {prefs.lowThresholdPct}% remaining
        </div>
        <input
          type="range"
          min={5}
          max={50}
          step={5}
          value={prefs.lowThresholdPct}
          onChange={(e) => setUsagePrefs({ lowThresholdPct: Number(e.target.value) })}
        />
        <div className="agent-list-meta">
          Below this, a meter turns red and the account counts as "running low".
        </div>
      </div>
    </div>
  );
}
