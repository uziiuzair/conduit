import { useState } from "react";
import { useStore } from "../store";
import { AgentList } from "./AgentList";
import { McpMatrix } from "./McpMatrix";

export function Onboarding() {
  const completeAgentSetup = useStore((s) => s.completeAgentSetup);
  const agents = useStore((s) => s.agents);
  const [step, setStep] = useState(0);
  const anyReady = !agents || agents.some((a) => a.found);
  const steps = ["Welcome", "Agents", "MCP", "Done"];

  return (
    <div className="dialog-overlay">
      <div className="dialog wizard" role="dialog" aria-modal="true">
        <div className="wizard-steps">
          {steps.map((s, i) => (
            <span
              key={s}
              className={`wizard-step ${i === step ? "cur" : ""} ${i < step ? "done" : ""}`}
            >
              {s}
            </span>
          ))}
          <button
            className="settings-close"
            onClick={completeAgentSetup}
            aria-label="Skip setup"
          >
            Skip ✕
          </button>
        </div>
        <div className="settings-body">
          {step === 0 && (
            <div className="wizard-welcome">
              <h3>Run multiple agents in Conduit</h3>
              <p className="settings-intro">
                Conduit can drive Claude Code, Codex, and Gemini side by side. Let's see what's
                installed, pick a default, and optionally wire up MCP servers.
              </p>
            </div>
          )}
          {step === 1 && (
            <>
              <p className="settings-intro">
                Conduit scanned your PATH. Choose a default agent — you can still switch per
                session.
              </p>
              <AgentList allowNoDefault />
              {!anyReady && (
                <div className="dialog-note">
                  No agents detected — install one (Claude/Codex/Gemini) and Re-scan.
                </div>
              )}
            </>
          )}
          {step === 2 && (
            <>
              <McpMatrix />
              <button
                className="mcp-skip-link"
                onClick={() => setStep(3)}
              >
                Skip — add MCP servers later in Settings ▸
              </button>
            </>
          )}
          {step === 3 && (
            <div className="wizard-welcome">
              <h3>You're set</h3>
              <p className="settings-intro">
                Open a project and hit New session — your default is pre-selected. Change agents
                and MCP servers anytime in ⚙ Settings.
              </p>
            </div>
          )}
        </div>
        <div className="dialog-actions">
          {step > 0 && <button onClick={() => setStep((s) => s - 1)}>Back</button>}
          {step < 3
            ? <button className="primary" onClick={() => setStep((s) => s + 1)}>Continue ▸</button>
            : <button className="primary" onClick={completeAgentSetup}>Done</button>}
        </div>
      </div>
    </div>
  );
}
