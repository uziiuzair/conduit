import { useEffect, useState } from "react";
import { AgentList } from "./AgentList";
import { McpMatrix } from "./McpMatrix";
import { TelemetryToggle } from "./TelemetryToggle";

type SettingsTab = "agents" | "mcp" | "privacy";

export function Settings({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>("agents");

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
              className={`settings-tab${tab === "privacy" ? " on" : ""}`}
              role="tab"
              aria-selected={tab === "privacy"}
              tabIndex={tab === "privacy" ? 0 : -1}
              onClick={() => setTab("privacy")}
              onKeyDown={(e) => e.key === "Enter" && setTab("privacy")}
            >
              Privacy
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
          {tab === "mcp" && <McpMatrix />}
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
        </div>
      </div>
    </div>
  );
}
