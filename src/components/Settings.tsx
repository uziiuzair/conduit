import { useEffect, useState } from "react";
import { AgentList } from "./AgentList";
import { McpMatrix } from "./McpMatrix";
import { TelemetryToggle } from "./TelemetryToggle";
import { AboutPanel } from "./AboutPanel";
import { AccountList } from "./AccountList";
import { TrustPanel } from "./TrustPanel";

export type SettingsTab = "agents" | "accounts" | "mcp" | "security" | "privacy" | "about";

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

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div
        className="dialog settings"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <div className="settings-tabs" role="tablist">
            <span
              className={`settings-tab${tab === "agents" ? " on" : ""}`}
              role="tab"
              aria-selected={tab === "agents"}
              tabIndex={tab === "agents" ? 0 : -1}
              onClick={() => setTab("agents")}
              onKeyDown={(e) => e.key === "Enter" && setTab("agents")}
            >
              Agents
            </span>
            <span
              className={`settings-tab${tab === "accounts" ? " on" : ""}`}
              role="tab"
              aria-selected={tab === "accounts"}
              tabIndex={tab === "accounts" ? 0 : -1}
              onClick={() => setTab("accounts")}
              onKeyDown={(e) => e.key === "Enter" && setTab("accounts")}
            >
              Accounts
            </span>
            <span
              className={`settings-tab${tab === "mcp" ? " on" : ""}`}
              role="tab"
              aria-selected={tab === "mcp"}
              tabIndex={tab === "mcp" ? 0 : -1}
              onClick={() => setTab("mcp")}
              onKeyDown={(e) => e.key === "Enter" && setTab("mcp")}
            >
              MCP servers
            </span>
            <span
              className={`settings-tab${tab === "security" ? " on" : ""}`}
              role="tab"
              aria-selected={tab === "security"}
              tabIndex={tab === "security" ? 0 : -1}
              onClick={() => setTab("security")}
              onKeyDown={(e) => e.key === "Enter" && setTab("security")}
            >
              Security
            </span>
            <span
              className={`settings-tab${tab === "privacy" ? " on" : ""}`}
              role="tab"
              aria-selected={tab === "privacy"}
              tabIndex={tab === "privacy" ? 0 : -1}
              onClick={() => setTab("privacy")}
              onKeyDown={(e) => e.key === "Enter" && setTab("privacy")}
            >
              Privacy
            </span>
            <span
              className={`settings-tab${tab === "about" ? " on" : ""}`}
              role="tab"
              aria-selected={tab === "about"}
              tabIndex={tab === "about" ? 0 : -1}
              onClick={() => setTab("about")}
              onKeyDown={(e) => e.key === "Enter" && setTab("about")}
            >
              About
            </span>
          </div>
          <button className="settings-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="settings-body">
          {tab === "agents" && (
            <>
              <p className="settings-intro">
                Conduit runs whichever of these are installed on your PATH. Pick the default for
                new sessions.
              </p>
              <AgentList />
            </>
          )}
          {tab === "accounts" && <AccountList />}
          {tab === "mcp" && <McpMatrix />}
          {tab === "security" && (
            <>
              <p className="settings-intro">
                Multi-agent trust boundaries. Turn on private mode to run sensitive work in a
                local silo that no other agent can read. Off by default; when off, every agent
                behaves normally.
              </p>
              <TrustPanel />
            </>
          )}
          {tab === "privacy" && (
            <>
              <p className="settings-intro">
                Conduit can send <strong>anonymous</strong> usage statistics — app version, OS,
                and a random ID — so we can see how many people use it. No code, prompts, file
                paths, project names, or personal data are ever sent.
              </p>
              <TelemetryToggle />
            </>
          )}
          {tab === "about" && <AboutPanel />}
        </div>
      </div>
    </div>
  );
}
