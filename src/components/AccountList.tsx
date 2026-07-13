import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore, type Account } from "../store";
import { agentMeta, type AgentId } from "../agents";

/** Agents that support multi-account today (Claude + agy). The rest is deferred, so they
 *  are intentionally not offered here — see the multi-account design doc. */
const MANAGED_AGENTS: AgentId[] = ["claude", "antigravity"];

/** Turn a picked path into a short label ("...\.claude-personal\.claude" -> "Personal"). */
function labelFromPath(picked: string): string {
  const clean = picked.replace(/[\\/]+$/, "");
  const parts = clean.split(/[\\/]/);
  let base = parts[parts.length - 1] || "Account";
  if (base === ".claude") base = parts[parts.length - 2] || "Account";
  base = base.replace(/^\./, "").replace(/^claude-?/, "") || "Account";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Settings > Accounts: register agent accounts, tag which agents each is signed in for,
 *  and choose the default account per agent (globally and per project). Off by default —
 *  with no accounts registered, every session inherits your normal agent config. */
export function AccountList() {
  const accounts = useStore((s) => s.accounts);
  const defaultAccounts = useStore((s) => s.defaultAccounts);
  const projects = useStore((s) => s.projects);
  const loadAccounts = useStore((s) => s.loadAccounts);
  const discoverAccounts = useStore((s) => s.discoverAccounts);
  const addAccount = useStore((s) => s.addAccount);
  const removeAccount = useStore((s) => s.removeAccount);
  const setDefaultAccount = useStore((s) => s.setDefaultAccount);
  const setProjectDefaultAccount = useStore((s) => s.setProjectDefaultAccount);
  const setAccountAgents = useStore((s) => s.setAccountAgents);

  const [candidates, setCandidates] = useState<Account[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  const registeredDirs = new Set(accounts.map((a) => a.configDir));
  const freshCandidates = candidates.filter((c) => !registeredDirs.has(c.configDir));
  const eligible = (agent: AgentId) => accounts.filter((a) => a.agents.includes(agent));

  const add = async (label: string, configDir: string) => {
    setError(await addAccount(label, configDir));
  };
  const detect = async () => {
    setError(null);
    setCandidates(await discoverAccounts());
  };
  const pickAndAdd = async () => {
    setError(null);
    const picked = await open({ directory: true, title: "Select an account config folder" });
    if (typeof picked === "string") await add(labelFromPath(picked), picked);
  };

  const toggleAgentTag = (a: Account, agent: AgentId, on: boolean) => {
    const next = on ? [...a.agents, agent] : a.agents.filter((x) => x !== agent);
    void setAccountAgents(a.id, next);
  };

  return (
    <div className="account-list">
      <p className="settings-intro">
        Register additional agent accounts so sessions can run under different logins — for
        example two Claude accounts to spread token usage. Tag which agents each account is
        signed in for, then pick a default per agent (globally and per project). Leave this
        empty and every session uses your normal config.
      </p>

      {/* ---- Registry: one row per account, with editable agent tags ---- */}
      <div className="agent-list">
        {accounts.length === 0 && (
          <div className="agent-list-row">
            <div className="agent-list-main">
              <div className="agent-list-meta">
                No extra accounts yet. Detect or add one below.
              </div>
            </div>
          </div>
        )}
        {accounts.map((a) => (
          <div key={a.id} className="agent-list-row">
            <div className="agent-list-main">
              <div className="agent-list-name">{a.label}</div>
              <div className="agent-list-meta">{a.configDir}</div>
              <div className="account-tags">
                {MANAGED_AGENTS.map((agent) => (
                  <label key={agent} className="account-tag-check">
                    <input
                      type="checkbox"
                      checked={a.agents.includes(agent)}
                      onChange={(e) => toggleAgentTag(a, agent, e.target.checked)}
                    />
                    {agentMeta(agent).label}
                  </label>
                ))}
              </div>
            </div>
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

      {/* ---- Global default per agent ---- */}
      {accounts.length > 0 && (
        <div className="account-defaults">
          <div className="account-defaults-title">Default account per agent</div>
          {MANAGED_AGENTS.map((agent) => {
            const opts = eligible(agent);
            if (opts.length === 0) return null;
            return (
              <label key={agent} className="account-default-row">
                <span className="account-default-label">{agentMeta(agent).label}</span>
                <select
                  className="account-select"
                  value={defaultAccounts[agent] ?? ""}
                  onChange={(e) =>
                    void setDefaultAccount(agent, e.target.value || null)
                  }
                >
                  <option value="">Default (your normal config)</option>
                  {opts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      )}

      {/* ---- Per-project defaults (beat the global default) ---- */}
      {accounts.length > 0 && projects.length > 0 && (
        <div className="account-defaults">
          <div className="account-defaults-title">Per-project defaults</div>
          <p className="account-defaults-hint">
            Override the global default for one project. Blank = use the global default.
          </p>
          {projects.map((p) => {
            const rows = MANAGED_AGENTS.map((agent) => {
              const opts = eligible(agent);
              if (opts.length === 0) return null;
              return (
                <label key={agent} className="account-default-row">
                  <span className="account-default-label">{agentMeta(agent).label}</span>
                  <select
                    className="account-select"
                    value={p.defaultAccounts?.[agent] ?? ""}
                    onChange={(e) =>
                      void setProjectDefaultAccount(p.id, agent, e.target.value || null)
                    }
                  >
                    <option value="">Use global default</option>
                    {opts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                </label>
              );
            }).filter(Boolean);
            if (rows.length === 0) return null;
            return (
              <div key={p.id} className="account-project-block">
                <div className="account-project-name">{p.name}</div>
                {rows}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
