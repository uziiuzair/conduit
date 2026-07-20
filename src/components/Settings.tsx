import { useEffect, useState } from "react";
import { AgentList } from "./AgentList";
import { McpMatrix } from "./McpMatrix";
import { TelemetryToggle } from "./TelemetryToggle";
import { AboutPanel } from "./AboutPanel";
import { AccountList } from "./AccountList";
import { UsagePrefsPanel } from "./UsagePrefsPanel";
import { GeneralSettings } from "./GeneralSettings";
import { TrustPanel } from "./TrustPanel";
import { OpenCodePanel } from "./OpenCodePanel";
import { PluginsPanel } from "./PluginsPanel";

// Exported for the native menu integration (menu → open Settings at a specific tab).
export type SettingsTab =
  | "general"
  | "agents"
  | "accounts"
  | "usage"
  | "mcp"
  | "localmodels"
  | "security"
  | "privacy"
  | "plugins"
  | "about";

/** Grouped sidebar navigation — scales past the point where flat tabs got unwieldy. */
const NAV: Array<{ group: string; items: Array<{ id: SettingsTab; label: string }> }> = [
  { group: "", items: [{ id: "general", label: "General" }] },
  {
    group: "Coding agents",
    items: [
      { id: "agents", label: "Agents" },
      { id: "localmodels", label: "Local models" },
      { id: "mcp", label: "MCP servers" },
    ],
  },
  {
    group: "Accounts",
    items: [
      { id: "accounts", label: "Agent accounts" },
      { id: "usage", label: "Usage display" },
    ],
  },
  {
    group: "Privacy & security",
    items: [
      { id: "security", label: "Security" },
      { id: "privacy", label: "Privacy" },
    ],
  },
  { group: "Extensions", items: [{ id: "plugins", label: "Plugins" }] },
  { group: "", items: [{ id: "about", label: "About" }] },
];

export function Settings({
  onClose,
  initialTab,
}: {
  onClose: () => void;
  initialTab?: SettingsTab;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? "agents");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const title = NAV.flatMap((g) => g.items).find((i) => i.id === tab)?.label ?? "Settings";

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog settings"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-frame">
          {/* Plain nav buttons (not tablist roles): every item is in the Tab order and
              activates with Enter/Space, without promising arrow-key semantics. */}
          <nav className="settings-nav" aria-label="Settings sections">
            {NAV.map((g) => (
              <div key={g.group || "misc"} className="settings-nav-section">
                {g.group && <div className="settings-nav-group">{g.group}</div>}
                {g.items.map((item) => (
                  <button
                    key={item.id}
                    className={`settings-nav-item${tab === item.id ? " on" : ""}`}
                    aria-current={tab === item.id ? "page" : undefined}
                    onClick={() => setTab(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="settings-content">
            <div className="settings-content-head">
              <span className="settings-content-title">{title}</span>
              <button className="settings-close" onClick={onClose} aria-label="Close">
                ✕
              </button>
            </div>
            <div className="settings-body">
              {tab === "general" && (
                <>
                  <p className="settings-intro">Startup and session behavior.</p>
                  <GeneralSettings />
                </>
              )}
              {tab === "agents" && (
                <>
                  <p className="settings-intro">
                    Conduit runs whichever of these are installed on your PATH. Pick the default
                    for new sessions.
                  </p>
                  <AgentList />
                </>
              )}
              {tab === "accounts" && <AccountList />}
              {tab === "usage" && <UsagePrefsPanel />}
              {tab === "mcp" && <McpMatrix />}
              {tab === "localmodels" && (
                <>
                  <p className="settings-intro">
                    Run OpenCode sessions on your own GPU — Ollama, LM Studio, vLLM, llama.cpp,
                    OpenWebUI, or any OpenAI-compatible endpoint. Conduit detects and configures
                    it for you.
                  </p>
                  <OpenCodePanel />
                </>
              )}
              {tab === "security" && (
                <>
                  <p className="settings-intro">
                    Multi-agent trust boundaries. Turn on private mode to run sensitive work in a
                    local silo that no other agent can read. Off by default; when off, every
                    agent behaves normally.
                  </p>
                  <TrustPanel />
                </>
              )}
              {tab === "privacy" && (
                <>
                  <p className="settings-intro">
                    Conduit can send <strong>anonymous</strong> usage statistics — app version,
                    OS, and a random ID — so we can see how many people use it. No code, prompts,
                    file paths, project names, or personal data are ever sent.
                  </p>
                  <TelemetryToggle />
                </>
              )}
              {tab === "plugins" && (
                <>
                  <p className="settings-intro">Community extensions.</p>
                  <PluginsPanel />
                </>
              )}
              {tab === "about" && <AboutPanel />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
