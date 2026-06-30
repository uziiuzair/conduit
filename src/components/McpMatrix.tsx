import type { CSSProperties } from "react";
import { useState } from "react";
import { useStore } from "../store";
import type { McpServer } from "../agents";
import { agentMeta, type AgentId } from "../agents";
import { AgentGlyph } from "./AgentGlyph";

/**
 * MCP server registry matrix.
 * Rows = registered servers; columns = installed agents (found = true).
 * Each cell is a toggle: off / on (✓) / pending (…) / error (red, title=msg).
 * Arrow keys implement ARIA grid roving tabindex.
 */
export function McpMatrix() {
  const mcpServers   = useStore((s) => s.mcpServers);
  const mcpEnabled   = useStore((s) => s.mcpEnabled);
  const mcpBusy      = useStore((s) => s.mcpBusy);
  const agents       = useStore((s) => s.agents);
  const addMcpServer    = useStore((s) => s.addMcpServer);
  const removeMcpServer = useStore((s) => s.removeMcpServer);
  const setMcpEnabled   = useStore((s) => s.setMcpEnabled);

  // Only show columns for agents that are installed AND support MCP management.
  const cols: AgentId[] = (agents ?? [])
    .filter((a) => a.found && agentMeta(a.id).supportsMcp)
    .map((a) => a.id);

  // Installed agents Conduit can't manage MCP for yet (e.g. OpenCode) — surfaced as a note.
  const mcpUnsupported: string[] = (agents ?? [])
    .filter((a) => a.found && !agentMeta(a.id).supportsMcp)
    .map((a) => agentMeta(a.id).label);

  // Roving tabindex: [rowIdx (1-based data rows), colIdx (0 = name, 1..n = agents, n+1 = remove)]
  const [focusPos, setFocusPos] = useState<[number, number]>([1, 0]);

  // totalCols = name + agent-cols + remove
  const totalCols = cols.length + 2;

  const moveFocus = (ri: number, ci: number) => {
    const nr = Math.max(1, Math.min(ri, mcpServers.length));
    const nc = Math.max(0, Math.min(ci, totalCols - 1));
    setFocusPos([nr, nc]);
    // Imperatively focus after React updates the DOM tabIndex values.
    requestAnimationFrame(() => {
      const grid = document.querySelector<HTMLElement>(".mcp-grid");
      if (!grid) return;
      const rows = grid.querySelectorAll<HTMLElement>('[role="row"]');
      const row  = rows[nr]; // row[0]=header, row[1+]=data
      if (!row) return;
      const cells = row.querySelectorAll<HTMLElement>('[role="gridcell"]');
      const cell  = cells[nc];
      if (!cell) return;
      const tgt = cell.querySelector<HTMLElement>("button") ?? cell;
      tgt.focus();
    });
  };

  const onCellKey = (
    e: React.KeyboardEvent,
    ri: number,
    ci: number,
  ) => {
    const dir: Record<string, [number, number]> = {
      ArrowDown:  [ri + 1, ci],
      ArrowUp:    [ri - 1, ci],
      ArrowRight: [ri, ci + 1],
      ArrowLeft:  [ri, ci - 1],
    };
    if (!(e.key in dir)) return;
    e.preventDefault();
    const [nr, nc] = dir[e.key];
    moveFocus(nr, nc);
  };

  // ---- Add-form state ----
  const [formOpen, setFormOpen] = useState(false);
  const [fname,      setFname]      = useState("");
  const [ftransport, setFtransport] = useState<"stdio" | "http">("stdio");
  const [fcmd,       setFcmd]       = useState("");
  const [fargs,      setFargs]      = useState("");
  const [furl,       setFurl]       = useState("");
  const [fenv,       setFenv]       = useState(""); // KEY=value lines
  const [ferr,       setFerr]       = useState<string | null>(null);

  const resetForm = () => {
    setFname(""); setFtransport("stdio"); setFcmd(""); setFargs("");
    setFurl(""); setFenv(""); setFerr(null);
  };

  const handleSubmit = () => {
    const name = fname.trim();
    if (!name) { setFerr("Name is required"); return; }
    if (ftransport === "stdio" && !fcmd.trim()) { setFerr("Command is required for stdio"); return; }
    if (ftransport === "http"  && !furl.trim()) { setFerr("URL is required for http"); return; }

    const envPairs: [string, string][] = fenv.trim()
      ? fenv.trim().split("\n")
          .map((line): [string, string] => {
            const eq = line.indexOf("=");
            return eq < 0
              ? [line.trim(), ""]
              : [line.slice(0, eq).trim(), line.slice(eq + 1).trim()];
          })
          .filter(([k]) => k.length > 0)
      : [];

    const server: McpServer = {
      name,
      transport: ftransport,
      ...(ftransport === "stdio"
        ? { command: fcmd.trim(), args: fargs.trim() ? fargs.trim().split(/\s+/) : [] }
        : { url: furl.trim() }),
      env: envPairs,
    };

    const err = addMcpServer(server);
    if (err) { setFerr(err); return; }
    resetForm();
    setFormOpen(false);
  };

  const rowStyle: CSSProperties = {
    gridTemplateColumns: `1fr repeat(${cols.length}, 52px) 34px`,
  };

  return (
    <div className="mcp-matrix-wrap">
      {/* Scope disclaimer */}
      <p className="mcp-scope-note">
        Writing user-scope MCP — the agent may still prompt to approve a server on first use.
      </p>
      {mcpUnsupported.length > 0 && (
        <p className="mcp-scope-note">
          MCP management for {mcpUnsupported.join(", ")} is coming soon.
        </p>
      )}

      {/* ARIA grid */}
      <div role="grid" aria-label="MCP server enable matrix" className="mcp-grid">

        {/* Header row */}
        <div role="row" className="mcp-row mcp-header-row" style={rowStyle}>
          <div role="columnheader" className="mcp-cell mcp-name-cell mcp-col-header">
            Server
          </div>
          {cols.map((agId) => (
            <div key={agId} role="columnheader" className="mcp-cell mcp-agent-cell mcp-col-header">
              <AgentGlyph id={agId} size={16} />
              <span className="mcp-col-label">{agentMeta(agId).label.split(" ")[0]}</span>
            </div>
          ))}
          <div role="columnheader" className="mcp-cell mcp-remove-cell mcp-col-header" />
        </div>

        {/* Data rows */}
        {mcpServers.map((server, ri) => (
          <div key={server.name} role="row" className="mcp-row mcp-data-row" style={rowStyle}>

            {/* Name cell */}
            <div
              role="gridcell"
              className="mcp-cell mcp-name-cell"
              tabIndex={focusPos[0] === ri + 1 && focusPos[1] === 0 ? 0 : -1}
              onFocus={() => setFocusPos([ri + 1, 0])}
              onKeyDown={(e) => onCellKey(e, ri + 1, 0)}
            >
              <span className="mcp-server-name">{server.name}</span>
              <span className="mcp-server-desc">
                {server.transport === "stdio" ? server.command : server.url}
              </span>
            </div>

            {/* Agent toggle cells */}
            {cols.map((agId, ci) => {
              const bkey    = `${server.name}:${agId}`;
              const busy    = mcpBusy[bkey];
              const enabled = (mcpEnabled[server.name] ?? []).includes(agId);
              const isPending = busy === "pending";
              const errEntry  = typeof busy === "object" && busy !== null ? busy : null;
              return (
                <div
                  key={agId}
                  role="gridcell"
                  className="mcp-cell mcp-agent-cell"
                  tabIndex={focusPos[0] === ri + 1 && focusPos[1] === ci + 1 ? 0 : -1}
                  title={errEntry ? errEntry.error : undefined}
                  onFocus={() => setFocusPos([ri + 1, ci + 1])}
                  onKeyDown={(e) => onCellKey(e, ri + 1, ci + 1)}
                >
                  <button
                    className={
                      "mcp-toggle" +
                      (enabled ? " on" : "") +
                      (isPending ? " pending" : "") +
                      (errEntry  ? " error"   : "")
                    }
                    disabled={isPending}
                    role="checkbox"
                    aria-checked={enabled}
                    aria-label={`${enabled ? "Disable" : "Enable"} ${server.name} for ${agentMeta(agId).label}`}
                    onClick={() => void setMcpEnabled(server.name, agId, !enabled)}
                  >
                    {isPending ? <span className="mcp-spin">⟳</span> : enabled ? "✓" : ""}
                  </button>
                </div>
              );
            })}

            {/* Remove cell */}
            <div
              role="gridcell"
              className="mcp-cell mcp-remove-cell"
              tabIndex={focusPos[0] === ri + 1 && focusPos[1] === cols.length + 1 ? 0 : -1}
              onFocus={() => setFocusPos([ri + 1, cols.length + 1])}
              onKeyDown={(e) => onCellKey(e, ri + 1, cols.length + 1)}
            >
              <button
                className="mcp-remove-btn"
                aria-label={`Remove ${server.name}`}
                title={`Remove ${server.name}`}
                onClick={() => void removeMcpServer(server.name)}
              >
                ✕
              </button>
            </div>
          </div>
        ))}

        {/* Empty state */}
        {mcpServers.length === 0 && (
          <div role="row" className="mcp-row" style={rowStyle}>
            <div role="gridcell" className="mcp-cell mcp-empty">
              No MCP servers added yet — add one below.
            </div>
          </div>
        )}
      </div>

      {/* Add-server form */}
      {!formOpen ? (
        <button className="mcp-add-btn" onClick={() => setFormOpen(true)}>
          + Add server
        </button>
      ) : (
        <div className="mcp-form">
          <div className="mcp-form-field">
            <label className="mcp-form-label">Name</label>
            <input
              className="dialog-input mcp-form-input"
              value={fname}
              onChange={(e) => { setFname(e.target.value); setFerr(null); }}
              placeholder="context7"
              autoFocus
            />
          </div>
          <div className="mcp-form-field">
            <label className="mcp-form-label">Transport</label>
            <select
              className="dialog-input mcp-form-select"
              value={ftransport}
              onChange={(e) => setFtransport(e.target.value as "stdio" | "http")}
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
            </select>
          </div>
          {ftransport === "stdio" ? (
            <>
              <div className="mcp-form-field">
                <label className="mcp-form-label">Command</label>
                <input
                  className="dialog-input mcp-form-input mcp-mono"
                  value={fcmd}
                  onChange={(e) => { setFcmd(e.target.value); setFerr(null); }}
                  placeholder="npx"
                />
              </div>
              <div className="mcp-form-field">
                <label className="mcp-form-label">Args</label>
                <input
                  className="dialog-input mcp-form-input mcp-mono"
                  value={fargs}
                  onChange={(e) => setFargs(e.target.value)}
                  placeholder="-y @upstash/context7-mcp"
                />
              </div>
            </>
          ) : (
            <div className="mcp-form-field">
              <label className="mcp-form-label">URL</label>
              <input
                className="dialog-input mcp-form-input mcp-mono"
                value={furl}
                onChange={(e) => { setFurl(e.target.value); setFerr(null); }}
                placeholder="https://example.com/mcp"
              />
            </div>
          )}
          <div className="mcp-form-field">
            <label className="mcp-form-label">Env vars</label>
            <textarea
              className="dialog-input mcp-form-textarea"
              value={fenv}
              onChange={(e) => setFenv(e.target.value)}
              placeholder={"KEY=value\nANOTHER=value"}
              rows={2}
            />
          </div>
          {ferr && <div className="mcp-form-error">{ferr}</div>}
          <div className="mcp-form-actions">
            <button onClick={() => { resetForm(); setFormOpen(false); }}>Cancel</button>
            <button className="primary" onClick={handleSubmit}>Add</button>
          </div>
        </div>
      )}
    </div>
  );
}
