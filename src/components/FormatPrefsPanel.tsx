import { useStore } from "../store";
import type { PrettierOptions } from "../format/options";

/** Settings → Formatting: global prettier config for the bundled fallback + the two
 *  save toggles. A project's own .prettierrc overrides these global values. */
export function FormatPrefsPanel() {
  const cfg = useStore((s) => s.formatConfig);
  const setCfg = useStore((s) => s.setFormatConfig);
  const trimOnSave = useStore((s) => s.trimOnSave);
  const toggleTrim = useStore((s) => s.toggleTrimOnSave);
  const formatOnSave = useStore((s) => s.formatOnSave);
  const toggleFormat = useStore((s) => s.toggleFormatOnSave);

  const num = (k: keyof PrettierOptions) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCfg({ [k]: Number(e.target.value) } as Partial<PrettierOptions>);
  const bool = (k: keyof PrettierOptions) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setCfg({ [k]: e.target.checked } as Partial<PrettierOptions>);

  return (
    <div className="usage-prefs">
      <p className="settings-intro">
        On save or via Edit → Format Document, Conduit uses the project's own prettier when
        installed (respecting its config). When a project has no prettier, it falls back to a
        bundled formatter using these global rules — a project's <code>.prettierrc</code>{" "}
        still wins.
      </p>

      <div className="usage-prefs-section">
        <div className="usage-prefs-title">On save</div>
        <div className="usage-prefs-checks">
          <label className="account-tag-check">
            <input type="checkbox" checked={formatOnSave} onChange={toggleFormat} />
            Format document on save
          </label>
          <label className="account-tag-check">
            <input type="checkbox" checked={trimOnSave} onChange={toggleTrim} />
            Trim trailing whitespace on save
          </label>
        </div>
      </div>

      <div className="usage-prefs-section">
        <div className="usage-prefs-title">Global prettier rules (fallback)</div>
        <div className="usage-prefs-checks">
          <label className="account-tag-check">
            Print width
            <input
              type="number"
              min={20}
              max={200}
              value={cfg.printWidth}
              onChange={num("printWidth")}
            />
          </label>
          <label className="account-tag-check">
            Tab width
            <input type="number" min={1} max={8} value={cfg.tabWidth} onChange={num("tabWidth")} />
          </label>
          <label className="account-tag-check">
            <input type="checkbox" checked={cfg.useTabs} onChange={bool("useTabs")} />
            Use tabs
          </label>
          <label className="account-tag-check">
            <input type="checkbox" checked={cfg.semi} onChange={bool("semi")} />
            Semicolons
          </label>
          <label className="account-tag-check">
            <input type="checkbox" checked={cfg.singleQuote} onChange={bool("singleQuote")} />
            Single quotes
          </label>
          <label className="account-tag-check">
            <input type="checkbox" checked={cfg.bracketSpacing} onChange={bool("bracketSpacing")} />
            Bracket spacing
          </label>
        </div>
      </div>

      <div className="usage-prefs-section">
        <div className="usage-prefs-title">Trailing commas</div>
        <select
          className="account-select"
          value={cfg.trailingComma}
          onChange={(e) => setCfg({ trailingComma: e.target.value as PrettierOptions["trailingComma"] })}
        >
          <option value="all">All</option>
          <option value="es5">ES5</option>
          <option value="none">None</option>
        </select>
      </div>

      <div className="usage-prefs-section">
        <div className="usage-prefs-title">End of line</div>
        <select
          className="account-select"
          value={cfg.endOfLine}
          onChange={(e) => setCfg({ endOfLine: e.target.value as PrettierOptions["endOfLine"] })}
        >
          <option value="lf">LF</option>
          <option value="crlf">CRLF</option>
          <option value="cr">CR</option>
          <option value="auto">Auto</option>
        </select>
      </div>
    </div>
  );
}
