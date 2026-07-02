import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { homeDir as getHomeDir } from "@tauri-apps/api/path";
import {
  type ThemeId,
  type ThemePref,
  applyTheme,
  resolveThemeId,
  systemPrefersDark,
  readStoredPref,
  writeStoredPref,
} from "./themes";
import { AGENTS, type AgentId, type AgentInfo, DEFAULT_AGENT, type McpServer } from "./agents";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// ---- Types (mirror the Rust serde structs, rename_all = "camelCase") ----
export type SessionRole = "worker" | "conductor";

export interface Session {
  id: string;
  name: string;
  useWorktree: boolean;
  worktreePath?: string | null;
  branch?: string | null;
  agent: AgentId;
  /** Optional; absent = "worker". The project's orchestrating Conductor is "conductor". */
  role?: SessionRole;
  /** Registered Claude account id; absent = inherit the global default account. */
  accountId?: string | null;
}

/** A registered Claude account (mirrors the Rust serde struct, camelCase). */
export interface Account {
  id: string;
  label: string;
  configDir: string;
}

export type TabKind = "session" | "file";

export interface WsTab {
  kind: TabKind;
  ref: string; // sessionId (session) | absolute file path (file)
}

export interface EditorGroup {
  id: string;
  tabs: WsTab[];
  activeRef: string | null;
}

export interface ProjectLayout {
  groups: EditorGroup[];
  activeGroupId: string | null;
  weights: number[]; // parallel to groups[], normalized to sum ~1
}

export interface Project {
  id: string;
  name: string;
  path: string;
  sessions: Session[];
  layout?: ProjectLayout | null;
}

export type SessionStatus = "idle" | "running" | "needsInput" | "done";
export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  /** Present-continuous label from TodoWrite, shown only while in_progress. */
  activeForm?: string;
}

export interface LiveState {
  status: SessionStatus;
  todos: TodoItem[];
  /** Short "what it's doing now" label while running (from PreToolUse). */
  activity?: string;
  /** True between a PreCompact event and the next activity, for a "compacting" hint. */
  compacting?: boolean;
}

const EMPTY_LIVE: LiveState = { status: "idle", todos: [] };

export interface ContextMenuState {
  x: number;
  y: number;
  kind: "session" | "project";
  projectId: string;
  sessionId?: string;
}

export type TopTab = "files" | "changes" | "todos";
export type BottomTab = "terminal" | "git";

// ---- Claude ambient (status + usage) — mirror Rust serde camelCase ----
export interface StatusComponent { name: string; status: string; }
export interface StatusIncident { name: string; status: string; impact: string; shortlink: string; }
export interface ClaudeStatus {
  indicator: "none" | "minor" | "major" | "critical" | "unknown";
  description: string;
  components: StatusComponent[];
  incidents: StatusIncident[];
  ok: boolean;
}
export interface ModelTokens { model: string; tokens: number; }
export interface LocalUsage {
  date: string;
  tokensByModel: ModelTokens[];
  totalTokens: number;
  sessions: number;
  messages: number;
}
/** resetsAt is an RFC3339 timestamp string (the endpoint's format). */
export interface PlanWindow { label: string; pctUsed: number; resetsAt: string | null; }
export interface ClaudeUsage {
  local: LocalUsage;
  plan: PlanWindow[] | null;
  planSource: "live" | "unavailable" | "disconnected";
}

// ---- Auto-update ----
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes: string;
  date?: string;
}
export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "error";

const SKIPPED_VERSION_KEY = "conduit.skippedVersion";

/** The live Update handle from the updater plugin. Not serializable, so it lives
 *  outside the store; the store holds only the display metadata + phase. */
let pendingUpdate: Update | null = null;

const DEFAULT_AGENT_KEY = "conduit.defaultAgent";
const SETUP_DONE_KEY = "conduit.agentSetupComplete";
const TELEMETRY_OPTOUT_KEY = "conduit.telemetryOptOut";
function readTelemetryOptOut(): boolean {
  // Default: anonymous telemetry ON (opt-out model). Absent key => not opted out.
  return localStorage.getItem(TELEMETRY_OPTOUT_KEY) === "1";
}
function readDefaultAgent(): AgentId {
  const v = localStorage.getItem(DEFAULT_AGENT_KEY);
  return AGENTS.some((a) => a.id === v) ? (v as AgentId) : DEFAULT_AGENT;
}

const MCP_KEY = "conduit.mcp";
function readMcpState(): { servers: McpServer[]; enabled: Record<string, AgentId[]> } {
  try {
    const v = localStorage.getItem(MCP_KEY);
    if (v) return JSON.parse(v) as { servers: McpServer[]; enabled: Record<string, AgentId[]> };
  } catch { /* ignore */ }
  return { servers: [], enabled: {} };
}
function persistMcp(servers: McpServer[], enabled: Record<string, AgentId[]>): void {
  try { localStorage.setItem(MCP_KEY, JSON.stringify({ servers, enabled })); } catch { /* quota — non-fatal */ }
}

const PLAN_CONNECTED_KEY = "conduit.planConnected";
export function readPlanConnected(): boolean {
  try { return localStorage.getItem(PLAN_CONNECTED_KEY) === "1"; } catch { return false; }
}
function writePlanConnected(v: boolean): void {
  try { localStorage.setItem(PLAN_CONNECTED_KEY, v ? "1" : "0"); } catch { /* quota — non-fatal */ }
}

// ---- helpers ----
function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return "g-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}

function defaultLayout(project: Project): ProjectLayout {
  const gid = uid();
  const first = project.sessions?.[0];
  const tabs: WsTab[] = first ? [{ kind: "session", ref: first.id }] : [];
  return {
    groups: [{ id: gid, tabs, activeRef: tabs[0]?.ref ?? null }],
    activeGroupId: gid,
    weights: [1],
  };
}

/** Repair a layout against the current project: drop dead session tabs, prune empty
 *  groups (and their weights, index-aligned), fix dangling active ids, normalize weights. */
function validateLayout(layout: ProjectLayout, project: Project | undefined): ProjectLayout {
  const valid = new Set(project?.sessions.map((s) => s.id) ?? []);
  const groups: EditorGroup[] = [];
  const weights: number[] = [];
  layout.groups.forEach((g, i) => {
    const tabs = g.tabs.filter((t) => t.kind === "file" || valid.has(t.ref));
    if (tabs.length === 0) return; // prune empty group + its weight
    const activeRef = tabs.some((t) => t.ref === g.activeRef)
      ? g.activeRef
      : tabs[tabs.length - 1].ref;
    groups.push({ id: g.id, tabs, activeRef });
    weights.push(layout.weights?.[i] ?? 1);
  });
  if (groups.length === 0) {
    const gid = uid();
    return { groups: [{ id: gid, tabs: [], activeRef: null }], activeGroupId: gid, weights: [1] };
  }
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const norm = weights.map((w) => w / sum);
  const activeGroupId = groups.some((g) => g.id === layout.activeGroupId)
    ? layout.activeGroupId
    : groups[0].id;
  return { groups, activeGroupId, weights: norm };
}

// ---- layout reducers (mutate a cloned layout in place) ----
function rOpenTab(l: ProjectLayout, tab: WsTab): ProjectLayout {
  for (const g of l.groups) {
    if (g.tabs.some((t) => t.ref === tab.ref)) {
      g.activeRef = tab.ref;
      l.activeGroupId = g.id;
      return l;
    }
  }
  const g = l.groups.find((x) => x.id === l.activeGroupId) ?? l.groups[0];
  if (g) {
    g.tabs.push(tab);
    g.activeRef = tab.ref;
    l.activeGroupId = g.id;
  } else {
    const ng: EditorGroup = { id: uid(), tabs: [tab], activeRef: tab.ref };
    l.groups.push(ng);
    l.weights.push(1);
    l.activeGroupId = ng.id;
  }
  return l;
}

function rOpenToSide(l: ProjectLayout, tab: WsTab): ProjectLayout {
  for (const g of l.groups) {
    g.tabs = g.tabs.filter((t) => t.ref !== tab.ref);
    if (g.activeRef === tab.ref) g.activeRef = g.tabs[g.tabs.length - 1]?.ref ?? null;
  }
  const ng: EditorGroup = { id: uid(), tabs: [tab], activeRef: tab.ref };
  l.groups.push(ng);
  const avg = l.weights.length ? l.weights.reduce((a, b) => a + b, 0) / l.weights.length : 1;
  l.weights.push(avg);
  l.activeGroupId = ng.id;
  return l;
}

// ---- selectors ----
export function activeGroup(layout: ProjectLayout | undefined): EditorGroup | null {
  if (!layout) return null;
  return layout.groups.find((g) => g.id === layout.activeGroupId) ?? layout.groups[0] ?? null;
}

export function activeSessionIdOf(layout: ProjectLayout | undefined): string | null {
  const g = activeGroup(layout);
  if (!g || !g.activeRef) return null;
  const tab = g.tabs.find((t) => t.ref === g.activeRef);
  return tab?.kind === "session" ? tab.ref : null;
}

export function globalSelectedSessionId(state: {
  selectedProjectId: string | null;
  layouts: Record<string, ProjectLayout>;
}): string | null {
  if (!state.selectedProjectId) return null;
  return activeSessionIdOf(state.layouts[state.selectedProjectId]);
}

// ---- debounced persistence ----
const writeTimers: Record<string, ReturnType<typeof setTimeout>> = {};
function persistLayout(projectId: string, layout: ProjectLayout) {
  if (writeTimers[projectId]) clearTimeout(writeTimers[projectId]);
  writeTimers[projectId] = setTimeout(() => {
    void invoke("set_project_layout", { projectId, layout }).catch(() => {});
  }, 400);
}

interface AppState {
  projects: Project[];
  selectedProjectId: string | null;
  layouts: Record<string, ProjectLayout>;
  live: Record<string, LiveState>;

  menu: ContextMenuState | null;
  editingSessionId: string | null;
  homeDir: string | null;
  topTab: TopTab;
  bottomTab: BottomTab;
  themePref: ThemePref;
  activeThemeId: ThemeId;

  claudeStatus: ClaudeStatus | null;
  claudeUsage: ClaudeUsage | null;
  planConnected: boolean;

  // ---- Auto-update ----
  updateInfo: UpdateInfo | null;
  updatePhase: UpdatePhase;
  updateProgress: number; // 0..1 while downloading
  updateError: string | null;
  /** Check for updates. `manual` = user-initiated (surface "up to date" and ignore skip). */
  checkForUpdates: (opts?: { manual?: boolean }) => Promise<void>;
  /** Download + install the pending update, then relaunch. */
  installUpdate: () => Promise<void>;
  /** "Later" — hide the notice and remember this version so we don't re-nag. */
  dismissUpdate: () => void;

  load: () => Promise<void>;
  agents: AgentInfo[] | null;
  defaultAgent: AgentId;
  agentSetupComplete: boolean;
  setDefaultAgent: (id: AgentId) => void;
  completeAgentSetup: () => void;
  /** Anonymous-telemetry opt-out (true = do not send). Default false (on). */
  telemetryOptOut: boolean;
  setTelemetryOptOut: (v: boolean) => void;
  loadAgents: () => Promise<void>;

  // ---- Claude account registry (Feature 2) ----
  accounts: Account[];
  defaultAccount: string | null;
  loadAccounts: () => Promise<void>;
  discoverAccounts: () => Promise<Account[]>;
  /** Returns an error string (duplicate / missing dir) or null on success. */
  addAccount: (label: string, configDir: string) => Promise<string | null>;
  removeAccount: (id: string) => Promise<void>;
  setDefaultAccount: (id: string | null) => Promise<void>;

  // ---- MCP server registry ----
  mcpServers: McpServer[];
  mcpEnabled: Record<string, AgentId[]>;
  /** Transient per-cell status (key = `${serverName}:${agentId}`), not persisted. */
  mcpBusy: Record<string, "pending" | { error: string } | undefined>;
  /** Returns an error string (e.g. duplicate name) or null on success. */
  addMcpServer: (s: McpServer) => string | null;
  /** Removes from all enabled agents (best-effort) then drops from registry. */
  removeMcpServer: (name: string) => Promise<void>;
  /** Invokes mcp_apply; sets pending/error per-cell, reverts on failure. */
  setMcpEnabled: (name: string, agent: AgentId, on: boolean) => Promise<void>;
  addProject: (path: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  addSession: (projectId: string, opts?: { name?: string; useWorktree?: boolean; agent?: AgentId; role?: SessionRole }) => Promise<void>;
  renameSession: (projectId: string, sessionId: string, name: string) => Promise<void>;
  removeSession: (projectId: string, sessionId: string) => Promise<void>;

  /** A session created by the backend (Conductor fleet_spawn): merge it in + open it. */
  mergeSpawnedSession: (projectId: string, session: Session, task?: string) => void;
  /** Pending first prompts for backend-spawned sessions, keyed by session id. */
  pendingPrompts: Record<string, string>;
  /** Read + clear a session's pending first prompt (consumed once, at PTY spawn). */
  takePendingPrompt: (sessionId: string) => string | undefined;

  selectProject: (projectId: string) => void;
  selectSession: (projectId: string, sessionId: string) => void;

  openTab: (projectId: string, tab: WsTab) => void;
  openToSide: (projectId: string, tab: WsTab) => void;
  closeTab: (projectId: string, groupId: string, ref: string) => void;
  setActiveTab: (projectId: string, groupId: string, ref: string) => void;
  setActiveGroup: (projectId: string, groupId: string) => void;
  moveTabToGroup: (
    projectId: string,
    fromGroupId: string,
    ref: string,
    toGroupId: string,
  ) => void;
  setGroupWeights: (projectId: string, weights: number[]) => void;
  openFile: (projectId: string, path: string) => void;

  setTopTab: (t: TopTab) => void;
  setBottomTab: (t: BottomTab) => void;
  openMenu: (menu: ContextMenuState) => void;
  closeMenu: () => void;
  startRename: (sessionId: string) => void;
  cancelRename: () => void;
  setStatus: (id: string, status: SessionStatus) => void;
  setTodos: (id: string, todos: TodoItem[]) => void;
  setActivity: (id: string, activity: string | undefined) => void;
  setCompacting: (id: string, compacting: boolean) => void;
  setThemePref: (pref: ThemePref) => void;
  applySystemDark: (dark: boolean) => void;

  refreshClaudeStatus: () => Promise<void>;
  refreshClaudeUsage: () => Promise<void>;
  connectPlanUsage: () => Promise<boolean>;
}

export const useStore = create<AppState>((set, get) => {
  const _initMcp = readMcpState();

  // Apply a reducer to a project's layout, validate, persist (debounced), commit.
  const applyLayout = (projectId: string, fn: (l: ProjectLayout) => ProjectLayout) => {
    set((s) => {
      const cur = s.layouts[projectId];
      if (!cur) return {};
      const project = s.projects.find((p) => p.id === projectId);
      const next = validateLayout(fn(clone(cur)), project);
      persistLayout(projectId, next);
      return { layouts: { ...s.layouts, [projectId]: next } };
    });
  };

  // Clear a session's "needs you" once you attend to it.
  const clearNeeds = (sessionId: string) => {
    set((s) => {
      const cur = s.live[sessionId];
      if (cur?.status === "needsInput") {
        return { live: { ...s.live, [sessionId]: { ...cur, status: "idle" } } };
      }
      return {};
    });
  };

  return {
    projects: [],
    selectedProjectId: null,
    layouts: {},
    live: {},
    pendingPrompts: {},
    claudeStatus: null,
    claudeUsage: null,
    planConnected: readPlanConnected(),
    updateInfo: null,
    updatePhase: "idle",
    updateProgress: 0,
    updateError: null,
    menu: null,
    editingSessionId: null,
    homeDir: null,
    agents: null,
    defaultAgent: readDefaultAgent(),
    accounts: [],
    defaultAccount: null,
    agentSetupComplete: localStorage.getItem(SETUP_DONE_KEY) === "1",
    telemetryOptOut: readTelemetryOptOut(),

    mcpServers: _initMcp.servers,
    mcpEnabled: _initMcp.enabled,
    mcpBusy: {},
    topTab: "files",
    bottomTab: "terminal",
    themePref: readStoredPref(),
    activeThemeId: resolveThemeId(readStoredPref(), systemPrefersDark()),

    load: async () => {
      const [projects, home, accounts, defaultAccount] = await Promise.all([
        invoke<Project[]>("load_projects"),
        getHomeDir().catch(() => null),
        invoke<Account[]>("list_accounts").catch(() => [] as Account[]),
        invoke<string | null>("get_default_account").catch(() => null),
      ]);
      const layouts: Record<string, ProjectLayout> = {};
      for (const p of projects) {
        layouts[p.id] = validateLayout(p.layout ?? defaultLayout(p), p);
      }
      set({
        projects,
        homeDir: home,
        layouts,
        selectedProjectId: projects[0]?.id ?? null,
        accounts,
        defaultAccount,
      });
    },

    setDefaultAgent: (id) => {
      localStorage.setItem(DEFAULT_AGENT_KEY, id);
      set({ defaultAgent: id });
    },

    loadAccounts: async () => {
      const [accounts, defaultAccount] = await Promise.all([
        invoke<Account[]>("list_accounts").catch(() => [] as Account[]),
        invoke<string | null>("get_default_account").catch(() => null),
      ]);
      set({ accounts, defaultAccount });
    },
    discoverAccounts: async () => {
      try {
        return await invoke<Account[]>("discover_accounts");
      } catch {
        return [];
      }
    },
    addAccount: async (label, configDir) => {
      try {
        await invoke<Account>("add_account", { label, configDir });
      } catch (e) {
        return String(e);
      }
      await get().loadAccounts();
      return null;
    },
    removeAccount: async (id) => {
      await invoke("remove_account", { accountId: id }).catch(() => {});
      await get().loadAccounts();
    },
    setDefaultAccount: async (id) => {
      await invoke("set_default_account", { accountId: id }).catch(() => {});
      set({ defaultAccount: id });
    },
    completeAgentSetup: () => {
      localStorage.setItem(SETUP_DONE_KEY, "1");
      set({ agentSetupComplete: true });
    },
    setTelemetryOptOut: (v) => {
      localStorage.setItem(TELEMETRY_OPTOUT_KEY, v ? "1" : "0");
      set({ telemetryOptOut: v });
    },

    // Detect installed agent binaries ONCE at startup and cache the result, so the
    // New Session dialog never pays the (slow, login-shell) PATH scan on open.
    loadAgents: async () => {
      try {
        set({ agents: await invoke<AgentInfo[]>("detect_agents") });
      } catch {
        set({ agents: [] });
      }
    },

    addMcpServer: (s) => {
      if (get().mcpServers.some((x) => x.name === s.name)) {
        return `"${s.name}" already exists`;
      }
      const mcpServers = [...get().mcpServers, s];
      persistMcp(mcpServers, get().mcpEnabled);
      set({ mcpServers });
      return null;
    },

    removeMcpServer: async (name) => {
      const enabled = [...(get().mcpEnabled[name] ?? [])];
      // best-effort: remove from every agent it was applied to
      await Promise.allSettled(enabled.map((a) => get().setMcpEnabled(name, a, false)));
      set((s) => {
        const mcpServers = s.mcpServers.filter((x) => x.name !== name);
        const mcpEnabled = { ...s.mcpEnabled };
        delete mcpEnabled[name];
        const mcpBusy = { ...s.mcpBusy };
        for (const k of Object.keys(mcpBusy)) {
          if (k.startsWith(name + ":")) delete mcpBusy[k];
        }
        persistMcp(mcpServers, mcpEnabled);
        return { mcpServers, mcpEnabled, mcpBusy };
      });
    },

    setMcpEnabled: async (name, agent, on) => {
      const server = get().mcpServers.find((s) => s.name === name);
      if (!server) return;
      const key = `${name}:${agent}`;
      set((s) => ({ mcpBusy: { ...s.mcpBusy, [key]: "pending" } }));
      try {
        await invoke("mcp_apply", { agent, action: on ? "add" : "remove", server });
        set((s) => {
          const cur = new Set(s.mcpEnabled[name] ?? []);
          on ? cur.add(agent) : cur.delete(agent);
          const mcpEnabled = { ...s.mcpEnabled, [name]: [...cur] };
          persistMcp(s.mcpServers, mcpEnabled);
          return { mcpEnabled, mcpBusy: { ...s.mcpBusy, [key]: undefined } };
        });
      } catch (e) {
        set((s) => ({ mcpBusy: { ...s.mcpBusy, [key]: { error: String(e) } } }));
      }
    },

    addProject: async (path) => {
      const project = await invoke<Project>("add_project", { path });
      set((s) => ({
        projects: [...s.projects, project],
        layouts: { ...s.layouts, [project.id]: defaultLayout(project) },
        selectedProjectId: project.id,
      }));
    },

    removeProject: async (id) => {
      await invoke("remove_project", { id });
      set((s) => {
        const layouts = { ...s.layouts };
        delete layouts[id];
        const projects = s.projects.filter((p) => p.id !== id);
        const selectedProjectId =
          s.selectedProjectId === id ? projects[0]?.id ?? null : s.selectedProjectId;
        return { projects, layouts, selectedProjectId };
      });
    },

    addSession: async (projectId, opts) => {
      const project = get().projects.find((p) => p.id === projectId);
      const name = opts?.name?.trim() || `Session ${(project?.sessions.length ?? 0) + 1}`;
      const useWorktree = opts?.useWorktree ?? false;
      const agent = opts?.agent ?? DEFAULT_AGENT;
      const role = opts?.role ?? "worker";
      const session = await invoke<Session | null>("add_session", { projectId, name, useWorktree, agent, role });
      if (!session) return;
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === projectId ? { ...p, sessions: [...p.sessions, session] } : p,
        ),
        selectedProjectId: projectId,
      }));
      applyLayout(projectId, (l) => rOpenTab(l, { kind: "session", ref: session.id }));
    },

    mergeSpawnedSession: (projectId, session, task) => {
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === projectId && !p.sessions.some((x) => x.id === session.id)
            ? { ...p, sessions: [...p.sessions, session] }
            : p,
        ),
        pendingPrompts: task
          ? { ...s.pendingPrompts, [session.id]: task }
          : s.pendingPrompts,
      }));
      applyLayout(projectId, (l) => rOpenTab(l, { kind: "session", ref: session.id }));
    },

    takePendingPrompt: (sessionId) => {
      const v = get().pendingPrompts[sessionId];
      if (v !== undefined) {
        set((s) => {
          const m = { ...s.pendingPrompts };
          delete m[sessionId];
          return { pendingPrompts: m };
        });
      }
      return v;
    },

    renameSession: async (projectId, sessionId, name) => {
      const clean = name.trim();
      if (!clean) {
        set({ editingSessionId: null });
        return;
      }
      await invoke("rename_session", { projectId, sessionId, name: clean });
      set((s) => ({
        editingSessionId: null,
        projects: s.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                sessions: p.sessions.map((x) =>
                  x.id === sessionId ? { ...x, name: clean } : x,
                ),
              }
            : p,
        ),
      }));
    },

    removeSession: async (projectId, sessionId) => {
      await invoke("remove_session", { projectId, sessionId });
      set((s) => {
        const live = { ...s.live };
        delete live[sessionId];
        const projects = s.projects.map((p) =>
          p.id === projectId
            ? { ...p, sessions: p.sessions.filter((x) => x.id !== sessionId) }
            : p,
        );
        let layouts = s.layouts;
        const cur = s.layouts[projectId];
        if (cur) {
          const next = validateLayout(cur, projects.find((p) => p.id === projectId));
          persistLayout(projectId, next);
          layouts = { ...s.layouts, [projectId]: next };
        }
        return { projects, live, layouts };
      });
    },

    selectProject: (projectId) => set({ selectedProjectId: projectId }),

    selectSession: (projectId, sessionId) => {
      set({ selectedProjectId: projectId });
      applyLayout(projectId, (l) => rOpenTab(l, { kind: "session", ref: sessionId }));
      clearNeeds(sessionId);
    },

    openTab: (projectId, tab) => applyLayout(projectId, (l) => rOpenTab(l, tab)),
    openToSide: (projectId, tab) => {
      set({ selectedProjectId: projectId });
      applyLayout(projectId, (l) => rOpenToSide(l, tab));
      if (tab.kind === "session") clearNeeds(tab.ref);
    },
    openFile: (projectId, path) =>
      applyLayout(projectId, (l) => rOpenTab(l, { kind: "file", ref: path })),

    closeTab: (projectId, groupId, ref) =>
      applyLayout(projectId, (l) => {
        const g = l.groups.find((x) => x.id === groupId);
        if (g) {
          g.tabs = g.tabs.filter((t) => t.ref !== ref);
          if (g.activeRef === ref) g.activeRef = g.tabs[g.tabs.length - 1]?.ref ?? null;
        }
        return l;
      }),

    setActiveTab: (projectId, groupId, ref) => {
      let isSession = false;
      applyLayout(projectId, (l) => {
        const g = l.groups.find((x) => x.id === groupId);
        const tab = g?.tabs.find((t) => t.ref === ref);
        if (g && tab) {
          g.activeRef = ref;
          l.activeGroupId = groupId;
          isSession = tab.kind === "session";
        }
        return l;
      });
      if (isSession) clearNeeds(ref);
    },

    setActiveGroup: (projectId, groupId) =>
      applyLayout(projectId, (l) => {
        l.activeGroupId = groupId;
        return l;
      }),

    moveTabToGroup: (projectId, fromGroupId, ref, toGroupId) =>
      applyLayout(projectId, (l) => {
        if (fromGroupId === toGroupId) return l;
        const from = l.groups.find((g) => g.id === fromGroupId);
        const to = l.groups.find((g) => g.id === toGroupId);
        if (!from || !to) return l;
        const tab = from.tabs.find((t) => t.ref === ref);
        if (!tab) return l;
        from.tabs = from.tabs.filter((t) => t.ref !== ref);
        if (from.activeRef === ref) from.activeRef = from.tabs[from.tabs.length - 1]?.ref ?? null;
        if (!to.tabs.some((t) => t.ref === ref)) to.tabs.push(tab);
        to.activeRef = ref;
        l.activeGroupId = toGroupId;
        return l;
      }),

    setGroupWeights: (projectId, weights) =>
      applyLayout(projectId, (l) => {
        l.weights = weights;
        return l;
      }),

    setTopTab: (t) => set({ topTab: t }),
    setBottomTab: (t) => set({ bottomTab: t }),
    openMenu: (menu) => set({ menu }),
    closeMenu: () => set({ menu: null }),
    startRename: (sessionId) => set({ editingSessionId: sessionId, menu: null }),
    cancelRename: () => set({ editingSessionId: null }),

    setStatus: (id, status) =>
      set((s) => ({
        live: { ...s.live, [id]: { ...(s.live[id] ?? EMPTY_LIVE), status } },
      })),
    setTodos: (id, todos) =>
      set((s) => ({
        live: { ...s.live, [id]: { ...(s.live[id] ?? EMPTY_LIVE), todos } },
      })),
    setActivity: (id, activity) =>
      set((s) => ({
        live: { ...s.live, [id]: { ...(s.live[id] ?? EMPTY_LIVE), activity } },
      })),
    setCompacting: (id, compacting) =>
      set((s) => ({
        live: { ...s.live, [id]: { ...(s.live[id] ?? EMPTY_LIVE), compacting } },
      })),

    setThemePref: (pref) => {
      writeStoredPref(pref);
      const id = resolveThemeId(pref, systemPrefersDark());
      applyTheme(id);
      set({ themePref: pref, activeThemeId: id });
    },

    refreshClaudeStatus: async () => {
      try {
        const s = await invoke<ClaudeStatus>("fetch_claude_status");
        set({ claudeStatus: s });
      } catch { /* fail-open: keep last-known */ }
    },

    refreshClaudeUsage: async () => {
      try {
        const u = await invoke<ClaudeUsage>("fetch_claude_usage");
        set({ claudeUsage: u });
      } catch { /* fail-open: keep last-known */ }
    },

    checkForUpdates: async (opts) => {
      const manual = opts?.manual ?? false;
      set({ updatePhase: "checking", updateError: null });
      try {
        const update = await check();
        if (!update) {
          pendingUpdate = null;
          set({ updateInfo: null, updatePhase: "idle" });
          return;
        }
        // Respect a prior "Later" unless this is a manual check.
        const skipped = localStorage.getItem(SKIPPED_VERSION_KEY);
        const shouldNotify = manual
          ? true
          : await invoke<boolean>("update_should_notify", {
              remoteVersion: update.version,
              skippedVersion: skipped,
            });
        if (!shouldNotify) {
          pendingUpdate = update;
          set({ updateInfo: null, updatePhase: "idle" });
          return;
        }
        pendingUpdate = update;
        set({
          updateInfo: {
            version: update.version,
            currentVersion: update.currentVersion,
            notes: update.body ?? "",
            date: update.date ?? undefined,
          },
          updatePhase: "available",
        });
      } catch (e) {
        // Network/offline/no-manifest: fail quiet on background checks; the manual
        // path surfaces the error so the About panel can show it.
        pendingUpdate = null;
        set({ updatePhase: "error", updateError: String(e) });
      }
    },

    installUpdate: async () => {
      if (!pendingUpdate) return;
      set({ updatePhase: "downloading", updateProgress: 0, updateError: null });
      try {
        let downloaded = 0;
        let total = 0;
        await pendingUpdate.downloadAndInstall((ev) => {
          switch (ev.event) {
            case "Started":
              total = ev.data.contentLength ?? 0;
              break;
            case "Progress":
              downloaded += ev.data.chunkLength;
              set({ updateProgress: total > 0 ? downloaded / total : 0 });
              break;
            case "Finished":
              set({ updateProgress: 1 });
              break;
          }
        });
        // Installed to disk; restart into the new version. This tears down PTYs —
        // the notice copy warns about that before the user clicks Install.
        await relaunch();
      } catch (e) {
        set({ updatePhase: "error", updateError: String(e) });
      }
    },

    dismissUpdate: () => {
      const v = get().updateInfo?.version;
      if (v) localStorage.setItem(SKIPPED_VERSION_KEY, v);
      set({ updateInfo: null, updatePhase: "idle" });
    },

    connectPlanUsage: async () => {
      try {
        const ok = await invoke<boolean>("connect_claude_plan_usage");
        writePlanConnected(ok);
        set({ planConnected: ok });
        if (ok) await get().refreshClaudeUsage();
        return ok;
      } catch {
        writePlanConnected(false);
        set({ planConnected: false });
        return false;
      }
    },

    applySystemDark: (dark) => {
      if (get().themePref !== "auto") return;
      const id = resolveThemeId("auto", dark);
      applyTheme(id);
      set({ activeThemeId: id });
    },
  };
});

// ---- selectors / helpers ----
export function liveState(live: Record<string, LiveState>, id: string): LiveState {
  return live[id] ?? EMPTY_LIVE;
}

export function findSession(
  projects: Project[],
  id: string,
): { project: Project; session: Session } | null {
  for (const project of projects) {
    const session = project.sessions.find((s) => s.id === id);
    if (session) return { project, session };
  }
  return null;
}

export function workingDirOf(project: Project, session: Session): string {
  return session.worktreePath ?? project.path;
}

/** Replace the home-directory prefix with `~` for display. */
export function prettyPath(path: string, home: string | null): string {
  if (!home) return path;
  const h = home.replace(/\/+$/, "");
  if (path === h) return "~";
  if (path.startsWith(h + "/")) return "~" + path.slice(h.length);
  return path;
}

/** Last path component of a path. */
export function baseName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

/** Open a directory in VS Code (Rust handles the launch + fallbacks). */
export async function openInVscode(dir: string): Promise<void> {
  try {
    await invoke("open_in_vscode", { dir });
  } catch (e) {
    void invoke("notify_user", { title: "Conduit", body: String(e) }).catch(() => {});
  }
}

/** True if `dir` is inside a git work tree (used to gate the worktree toggle). */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await invoke<string | null>("git_branch", { dir })) != null;
  } catch {
    return false;
  }
}

/** True if a worktree has uncommitted/untracked changes (so removal needs force).
 *  On error we assume dirty, matching the backend's safe "unknown → dirty" default —
 *  so the user gets the data-loss warning rather than a falsely reassuring one. */
export async function worktreeIsDirty(worktreePath: string): Promise<boolean> {
  try {
    return await invoke<boolean>("worktree_is_dirty", { worktreePath });
  } catch {
    return true;
  }
}

/** Remove a session's worktree via git. `force` discards a dirty tree. */
export async function worktreeRemove(
  repoPath: string,
  worktreePath: string,
  force: boolean,
): Promise<void> {
  await invoke("worktree_remove", { repoPath, worktreePath, force });
}
