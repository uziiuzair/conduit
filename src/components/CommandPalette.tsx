import { useEffect, useMemo, useRef, useState } from "react";
import { type Command, rankCommands } from "../commands";
import { liveState, useStore } from "../store";
import type { SettingsTab } from "./Settings";

const RESULT_LIMIT = 60;

/** Settings pages worth a direct row — the ones people go to on purpose. */
const SETTINGS_PAGES: Array<[SettingsTab, string]> = [
  ["general", "General"],
  ["accounts", "Accounts"],
  ["agents", "Agents"],
  ["usage", "Usage display"],
  ["formatting", "Formatting"],
  ["mcp", "MCP"],
  ["localmodels", "Local models"],
  ["security", "Security"],
];

/**
 * Every action the palette offers, in the order it shows them when nothing is typed.
 *
 * Built fresh on open rather than memoized across the app's life: the interesting half of
 * this list is sessions and projects, which change constantly, and a palette that offers to
 * switch to a session you closed is worse than one that takes a millisecond to assemble.
 */
function buildCommands(close: () => void): Command[] {
  const st = useStore.getState();
  const out: Command[] = [];
  const act = (id: string, label: string, run: () => void, rest: Partial<Command> = {}) =>
    out.push({ id, label, run: () => { close(); run(); }, ...rest });

  const project = st.projects.find((p) => p.id === st.selectedProjectId) ?? null;

  // --- Sessions in the open project. First, because switching is the common errand.
  if (project) {
    for (const s of project.sessions) {
      const live = liveState(st.live, s.id);
      const badge =
        live.status === "running"
          ? "running"
          : live.status === "needsInput"
            ? "needs input"
            : live.status === "done"
              ? "done"
              : undefined;
      act(
        `session:${s.id}`,
        s.name,
        () => st.selectSession(project.id, s.id),
        {
          section: "Go to session",
          // The branch is searchable because "which session was on the auth branch" is a
          // real way people look for one; the status is a note because nobody hunts for a
          // session by typing "running".
          hint: s.branch ?? undefined,
          note: badge,
        },
      );
    }
  }

  // --- Projects, for jumping between them.
  for (const p of st.projects) {
    if (p.id === st.selectedProjectId) continue;
    act(`project:${p.id}`, p.name, () => st.selectProject(p.id), {
      section: "Open project",
      hint: p.path,
    });
  }

  // --- Session lifecycle.
  if (project) {
    act("new-session", "New session", () => void st.addSession(project.id), {
      section: "Session",
    });
    act(
      "new-session-worktree",
      "New session in a worktree",
      () => void st.addSession(project.id, { useWorktree: true }),
      { section: "Session" },
    );
  }

  // --- View.
  if (project) {
    const mode = st.centerMode[project.id] ?? "terminals";
    act(
      "view-board",
      mode === "board" ? "Hide board" : "Show board",
      () => st.setCenterMode(project.id, mode === "board" ? "terminals" : "board"),
      { section: "View" },
    );
    act(
      "view-canvas",
      mode === "canvas" ? "Hide canvas" : "Show canvas",
      () => st.setCenterMode(project.id, mode === "canvas" ? "terminals" : "canvas"),
      { section: "View" },
    );
    act("view-maximize", "Toggle maximized pane", () => st.toggleMaximizeGroup(project.id), {
      section: "View",
    });
  }
  act("view-sidebar", st.sidebarCollapsed ? "Show sidebar" : "Hide sidebar", () => st.toggleSidebar(), {
    section: "View",
  });
  act("view-right", st.rightCollapsed ? "Show right panel" : "Hide right panel", () => st.toggleRight(), {
    section: "View",
  });
  act("view-zoom-in", "Zoom in", () => st.setFontZoom(st.fontZoom + 1), { section: "View" });
  act("view-zoom-out", "Zoom out", () => st.setFontZoom(st.fontZoom - 1), { section: "View" });
  act("view-zoom-reset", "Reset zoom", () => st.setFontZoom(0), { section: "View" });

  // --- Settings pages.
  for (const [tab, label] of SETTINGS_PAGES) {
    act(
      `settings:${tab}`,
      `Settings: ${label}`,
      () => {
        st.setSettingsTab(tab);
        st.setShowSettings(true);
      },
      { section: "Settings" },
    );
  }

  return out;
}

/**
 * ⌘K Command Palette — fuzzy-filter the app's actions and run one.
 *
 * Opened from the native menu rather than a window keydown handler, because it has to work
 * while a terminal has focus and xterm eats key events before the webview sees them.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Snapshot the actions once per open; see buildCommands.
  const commands = useMemo(() => buildCommands(onClose), [onClose]);
  const results = useMemo(
    () => rankCommands(query, commands, RESULT_LIMIT),
    [query, commands],
  );

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setSel(0), [query]);

  // Keep the selected row in view as the arrow keys walk past the fold.
  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-i="${sel}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const runAt = (i: number) => {
    const c = results[i];
    if (c && !c.disabled) c.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(sel);
    }
  };

  let lastSection: string | undefined;

  return (
    <div className="modal-overlay palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Run a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list" ref={listRef}>
          {results.length === 0 && <div className="palette-empty">No matching command</div>}
          {results.map((c, i) => {
            // Section headings only make sense while the curated order survives; once a
            // query has re-ranked the list, a heading would label a row that no longer
            // belongs under it.
            const heading = !query.trim() && c.section !== lastSection ? c.section : undefined;
            lastSection = c.section;
            return (
              <div key={c.id}>
                {heading && <div className="palette-group">{heading}</div>}
                <div
                  data-i={i}
                  className={`palette-row ${i === sel ? "selected" : ""} ${
                    c.disabled ? "disabled" : ""
                  }`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => runAt(i)}
                >
                  <span className="palette-file">{c.label}</span>
                  {c.hint && <span className="palette-cmd-meta">{c.hint}</span>}
                  {c.note && <span className="palette-cmd-note">{c.note}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
