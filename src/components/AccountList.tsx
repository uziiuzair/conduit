import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore, type Account } from "../store";

/** Turn a picked path into a short label ("...\.claude-personal\.claude" -> "Personal"). */
function labelFromPath(picked: string): string {
  const clean = picked.replace(/[\\/]+$/, "");
  const parts = clean.split(/[\\/]/);
  let base = parts[parts.length - 1] || "Account";
  if (base === ".claude") base = parts[parts.length - 2] || "Account";
  base = base.replace(/^\./, "").replace(/^claude-?/, "") || "Account";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Settings > Accounts: pick which Claude account new sessions use, add/remove accounts,
 *  and auto-detect the ones on disk. */
export function AccountList() {
  const accounts = useStore((s) => s.accounts);
  const defaultAccount = useStore((s) => s.defaultAccount);
  const loadAccounts = useStore((s) => s.loadAccounts);
  const discoverAccounts = useStore((s) => s.discoverAccounts);
  const addAccount = useStore((s) => s.addAccount);
  const removeAccount = useStore((s) => s.removeAccount);
  const setDefaultAccount = useStore((s) => s.setDefaultAccount);

  const [candidates, setCandidates] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const registeredDirs = new Set(accounts.map((a) => a.configDir));
  const freshCandidates = candidates.filter((c) => !registeredDirs.has(c.configDir));

  const add = async (label: string, configDir: string) => {
    const err = await addAccount(label, configDir);
    setError(err);
  };

  const detect = async () => {
    setError(null);
    setCandidates(await discoverAccounts());
  };

  const pickAndAdd = async () => {
    setError(null);
    const picked = await open({
      directory: true,
      title: "Select a Claude .claude config folder",
    });
    if (typeof picked === "string") await add(labelFromPath(picked), picked);
  };

  return (
    <div className="account-list">
      <p className="settings-intro">
        Choose which Claude account new sessions run under. Pick a default below, or add
        another account's <strong>.claude</strong> folder. Sessions use the selected account
        without disturbing your normal <strong>claude</strong>.
      </p>

      <div className="agent-list">
        <div className={`agent-list-row ${defaultAccount === null ? "def" : ""}`}>
          <button
            className="agent-radio"
            role="radio"
            aria-checked={defaultAccount === null}
            aria-label="Use the default claude config"
            onClick={() => void setDefaultAccount(null)}
          />
          <div className="agent-list-main">
            <div className="agent-list-name">Default</div>
            <div className="agent-list-meta">Whatever your normal claude uses (~/.claude)</div>
          </div>
          {defaultAccount === null && <span className="agent-tag">default</span>}
        </div>

        {accounts.map((a) => (
          <div key={a.id} className={`agent-list-row ${defaultAccount === a.id ? "def" : ""}`}>
            <button
              className="agent-radio"
              role="radio"
              aria-checked={defaultAccount === a.id}
              aria-label={`Set ${a.label} as default`}
              onClick={() => void setDefaultAccount(a.id)}
            />
            <div className="agent-list-main">
              <div className="agent-list-name">{a.label}</div>
              <div className="agent-list-meta">{a.configDir}</div>
            </div>
            {defaultAccount === a.id && <span className="agent-tag">default</span>}
            <button
              className="account-remove"
              aria-label={`Remove ${a.label}`}
              onClick={() => void removeAccount(a.id)}
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      {error && <div className="account-error">{error}</div>}

      <div className="account-actions">
        <button className="agent-rescan" onClick={() => void detect()}>
          Detect accounts
        </button>
        <button className="agent-rescan" onClick={() => void pickAndAdd()}>
          Add by path
        </button>
      </div>

      {freshCandidates.length > 0 && (
        <div className="account-candidates">
          <div className="account-candidates-title">Detected (not yet added)</div>
          <div className="agent-list">
            {freshCandidates.map((c) => (
              <div key={c.configDir} className="agent-list-row">
                <div className="agent-list-main">
                  <div className="agent-list-name">{c.label}</div>
                  <div className="agent-list-meta">{c.configDir}</div>
                </div>
                <button className="agent-rescan" onClick={() => void add(c.label, c.configDir)}>
                  Add
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
