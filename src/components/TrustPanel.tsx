import { useState } from "react";
import { useStore, type SensitivityHit } from "../store";

/**
 * Feature 4 — trust-boundary controls. The master "private / secure mode" switch, plus a
 * local, offline secret scanner that assists (but never replaces) the manual "mark sensitive"
 * decision. When private mode is off the whole regime is inert and every agent — including
 * OpenCode — behaves like a normal session.
 */
export function TrustPanel() {
  const privateMode = useStore((s) => s.privateMode);
  const setPrivateMode = useStore((s) => s.setPrivateMode);
  const scanSensitivity = useStore((s) => s.scanSensitivity);

  const [text, setText] = useState("");
  const [hits, setHits] = useState<SensitivityHit[] | null>(null);

  const runScan = async () => setHits(await scanSensitivity(text));

  return (
    <div className="trust-panel">
      <label className="telemetry-toggle">
        <input
          type="checkbox"
          checked={privateMode}
          onChange={(e) => void setPrivateMode(e.target.checked)}
        />
        <span>Enable private / secure mode</span>
      </label>

      <p className="trust-note">
        With private mode on, a session you mark <strong>sensitive</strong> runs in a silo: no
        other agent can read its output (the Conductor&rsquo;s <code>fleet_peek</code> is denied
        by design), and its terminal is never streamed to a paired phone. You read the siloed
        session directly; only findings you explicitly share ever leave the silo.
      </p>
      <p className="trust-note trust-warn">
        A siloed agent only guarantees &ldquo;no cloud egress&rdquo; if it runs on a{" "}
        <strong>local model</strong> (e.g. OpenCode&nbsp;+&nbsp;Ollama). Conduit withholds cloud
        MCP from siloed sessions and keeps their output local, but you must point the agent at a
        local model yourself.
      </p>

      <div className="trust-scan">
        <div className="section-label">Check text for secrets (local, offline)</div>
        <p className="trust-note">
          Paste a config snippet, log, or prompt below. The scan runs entirely in-process and is
          never sent to any agent; use it to decide whether to route work to a siloed session.
        </p>
        <textarea
          className="trust-scan-input"
          placeholder="Paste text to scan for API keys, tokens, private keys, credentials…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          spellCheck={false}
        />
        <div className="trust-scan-actions">
          <button onClick={() => void runScan()} disabled={!text.trim()}>
            Scan
          </button>
          {hits !== null &&
            (hits.length === 0 ? (
              <span className="trust-scan-clean">No obvious secrets found.</span>
            ) : (
              <span className="trust-scan-hit">
                {hits.length} potential secret{hits.length > 1 ? "s" : ""} found — consider a
                siloed session.
              </span>
            ))}
        </div>
        {hits && hits.length > 0 && (
          <ul className="trust-scan-list">
            {hits.map((h) => (
              <li key={h.kind}>
                <code>{h.kind}</code> — {h.hint}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
