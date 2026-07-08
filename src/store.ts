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
import { ask } from "@tauri-apps/plugin-dialog";
import * as registry from "./monaco/registry";
import { moveTab as reduceMoveTab, splitTab as reduceSplitTab } from "./layout";
import type { SettingsTab } from "./components/Settings";

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
  // ---- Trust boundaries (Feature 4; only enforced under private mode) ----
  clearance?: Clearance;
  /** Asymmetric silo: this session may read others but no other agent may read it. */
  silo?: boolean;
  /** Must run against a local model and receive no cloud MCP (siloed sensitive-data agent). */
  localOnly?: boolean;
  channels?: string[];
  modelTier?: string | null;
  seedMemory?: string | null;
  effort?: string | null;
}

/** A registered Claude account (mirrors the Rust serde struct, camelCase). */
export interface Account {
  id: string;
  label: string;
  configDir: string;
}

// ---- Trust boundaries (Feature 4) — mirror the Rust serde structs (camelCase) ----
export type Clearance = "public" | "internal" | "confidential";

export interface TrustSettings {
  privateMode: boolean;
}

/** A trust update applied to one session (the "mark sensitive" action / policy editor). */
export interface SessionTrust {
  clearance: Clearance;
  silo: boolean;
  localOnly: boolean;
  channels: string[];
  modelTier?: string | null;
  seedMemory?: string | null;
  effort?: string | null;
}

/** A local sensitivity-scanner hit (offline; assists the manual "mark sensitive" decision). */
export interface SensitivityHit {
  kind: string;
  hint: string;
}

// ---- OpenCode local provider — mirror the Rust serde structs (camelCase) ----

/** Non-secret local-provider settings. The endpoint API key is never part of this (or of
 * any persisted state) — it is held in backend memory and reaches OpenCode via child env. */
export interface OpenCodeSettings {
  enabled: boolean;
  /** "ollama" | "lmstudio" | "vllm" | "llamacpp" | "openwebui" | "custom" ("" = unset). */
  preset: string;
  /** Full OpenAI-compatible base URL (e.g. http://127.0.0.1:11434/v1). */
  baseUrl: string;
  /** Model id exactly as the server reports it. */
  model: string;
  contextLimit?: number | null;
  outputLimit?: number | null;
  /** Allowlist the injected provider so OpenCode can't fall back to cloud providers. */
  pinLocal: boolean;
}

/** One probed local inference server (detect_local_providers). */
export interface LocalProviderStatus {
  preset: string;
  label: string;
  baseUrl: string;
  running: boolean;
  detail: string;
  needsKey: boolean;
}

/** A model the local server offers (list_local_models). */
export interface LocalModel {
  id: string;
  /** Context window when the server reports it (Ollama does) — used to autofill limits. */
  context?: number | null;
  detail: string;
  /** Tool-calling support (Ollama reports it; null/undefined = unknown). */
  tools?: boolean | null;
}

/** Verdict of the live tool-calling probe (probe_tool_call). */
export interface ToolProbeResult {
  native: boolean;
  detail: string;
}

export type TabKind = "session" | "file";

export interface WsTab {
  kind: TabKind;
  ref: string; // sessionId (session) | absolute file path (file)
}

/** Mirror of fsops::FileContent (serde camelCase). read_file resolves (never rejects);
 *  inspect error/binary/readOnly before creating an editable model. */
export interface FileContent {
  content: string;
  truncated: boolean;
  binary: boolean;
  readOnly: boolean;
  size: number;
  mtimeMs: number;
  error: string | null;
}

/** Mirror of fsops::FileStat — returned by write_file (and Phase 2 stat_file). */
export interface FileStat {
  mtimeMs: number;
  size: number;
  exists: boolean;
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

// Sidebar / right-panel collapse state (native menu: View > Toggle Sidebar / Toggle
// Right Panel). Small persisted UI prefs, same pattern as telemetryOptOut above.
// Default: both expanded (false).
const SIDEBAR_COLLAPSED_KEY = "conduit.sidebarCollapsed";
const RIGHT_COLLAPSED_KEY = "conduit.rightCollapsed";
function readSidebarCollapsed(): boolean {
  try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1"; } catch { return false; }
}
function writeSidebarCollapsed(v: boolean): void {
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, v ? "1" : "0"); } catch { /* quota — non-fatal */ }
}
function readRightCollapsed(): boolean {
  try { return localStorage.getItem(RIGHT_COLLAPSED_KEY) === "1"; } catch { return false; }
}
function writeRightCollapsed(v: boolean): void {
  try { localStorage.setItem(RIGHT_COLLAPSED_KEY, v ? "1" : "0"); } catch { /* quota — non-fatal */ }
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

  // ---- panel collapse + Settings dialog (native menu-driven, App-level) ----
  /** Persisted. When true, the sidebar (and its resizer) is hidden. */
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  /** Persisted. When true, the right panel is hidden (kept mounted — it holds a
   *  keep-alive shell terminal; never conditionally unmount it). */
  rightCollapsed: boolean;
  toggleRight: () => void;
  /** Non-persisted ephemeral UI: Settings dialog, hosted at the App root so it still
   *  opens when the sidebar is collapsed. */
  showSettings: boolean;
  setShowSettings: (v: boolean) => void;
  settingsTab: SettingsTab;
  setSettingsTab: (t: SettingsTab) => void;

  load: () => Promise<void>;
  agents: AgentInfo[] | null;
  defaultAgent: AgentId;
  agentSetupComplete: boolean;
  setDefaultAgent: (id: AgentId) => void;
  /** Run an agent's official installer, then re-detect. Returns an error string or null. */
  installAgent: (id: AgentId) => Promise<string | null>;
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

  // ---- Trust boundaries (Feature 4) ----
  /** Master switch for the trust-boundary regime. When false the whole thing is inert. */
  privateMode: boolean;
  loadTrustSettings: () => Promise<void>;
  setPrivateMode: (on: boolean) => Promise<void>;
  /** Mark/adjust a session's trust (clearance / silo / local-only / channels / tier / seed). */
  setSessionTrust: (sessionId: string, trust: SessionTrust) => Promise<void>;
  /** Local, offline secret/PII scan of arbitrary text (assist for "mark sensitive"). */
  scanSensitivity: (text: string) => Promise<SensitivityHit[]>;

  // ---- OpenCode local provider ----
  opencode: OpenCodeSettings;
  /** Whether an endpoint API key is held (in backend memory) for this app run. */
  opencodeKeySet: boolean;
  loadOpenCodeSettings: () => Promise<void>;
  setOpenCodeSettings: (settings: OpenCodeSettings) => Promise<void>;
  /** Non-empty = hold/replace the key for this run; empty = clear it. Never persisted. */
  setOpenCodeKey: (key: string) => Promise<void>;
  detectLocalProviders: () => Promise<LocalProviderStatus[]>;
  /** Models the server at baseUrl offers; a string is the error message. */
  listLocalModels: (baseUrl: string, preset: string) => Promise<LocalModel[] | string>;
  /** Live-test native tool calling on the served model; a string is the error message. */
  probeToolCall: (baseUrl: string, model: string) => Promise<ToolProbeResult | string>;

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
  moveTab: (
    projectId: string,
    fromGroupId: string,
    ref: string,
    toGroupId: string,
    toIndex: number,
  ) => void;
  splitTab: (projectId: string, ref: string, targetGroupId: string, side: "left" | "right") => void;
  setGroupWeights: (projectId: string, weights: number[]) => void;
  openFile: (projectId: string, path: string, reveal?: { line: number; col?: number }) => void;

  // ---- Phase 3: file-tree CRUD (all non-persisted) ----
  /** dirPath -> bump counter; a FileTree entry re-lists when its counter changes. */
  dirVersion: Record<string, number>;
  /** Increment the counter for one directory so only that folder re-lists. */
  bumpDir: (dirPath: string) => void;
  /** Rename/move on disk; blocks a dirty open buffer; reconciles a clean open tab. */
  renamePath: (projectId: string, from: string, to: string) => Promise<void>;
  /** Permanent delete on disk; blocks a dirty open buffer; closes a clean open tab. */
  deletePath: (projectId: string, path: string) => Promise<void>;

  // ---- editor buffer state (Monaco) — NON-PERSISTED ----
  /** absPath -> dirty; reactive mirror of registry.dirtyOf (delete key when false). */
  dirty: Record<string, boolean>;
  /** absPath -> external change (populated in Phase 2 by useFileWatch). */
  conflict: Record<string, { mtimeMs: number; size: number } | "deleted">;
  setDirty: (path: string, dirty: boolean) => void;
  clearConflict: (path: string) => void;
  setConflict: (path: string, c: { mtimeMs: number; size: number } | "deleted") => void;
  saveFile: (path: string) => Promise<void>;
  requestCloseTab: (projectId: string, groupId: string, ref: string) => Promise<void>;
  /** One-shot editor reveal target set by a terminal path Cmd+Click; consumed by CodeEditorPane. */
  pendingReveal: { path: string; line: number; col: number } | null;
  clearPendingReveal: () => void;

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
    dirVersion: {},
    pendingPrompts: {},
    dirty: {},
    conflict: {},
    pendingReveal: null,
    claudeStatus: null,
    claudeUsage: null,
    planConnected: readPlanConnected(),
    sidebarCollapsed: readSidebarCollapsed(),
    rightCollapsed: readRightCollapsed(),
    showSettings: false,
    settingsTab: "agents",
    menu: null,
    editingSessionId: null,
    homeDir: null,
    agents: null,
    defaultAgent: readDefaultAgent(),
    accounts: [],
    defaultAccount: null,
    privateMode: false,
    opencode: {
      enabled: false,
      preset: "",
      baseUrl: "",
      model: "",
      contextLimit: null,
      outputLimit: null,
      pinLocal: false,
    },
    opencodeKeySet: false,
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
      const [projects, home, accounts, defaultAccount, trust, opencode] = await Promise.all([
        invoke<Project[]>("load_projects"),
        getHomeDir().catch(() => null),
        invoke<Account[]>("list_accounts").catch(() => [] as Account[]),
        invoke<string | null>("get_default_account").catch(() => null),
        invoke<TrustSettings>("get_trust_settings").catch(
          () => ({ privateMode: false }) as TrustSettings,
        ),
        invoke<OpenCodeSettings>("get_opencode_settings").catch(() => get().opencode),
      ]);
      const layouts: Record<string, ProjectLayout> = {};
      for (const p of projects) {
        layouts[p.id] = validateLayout(p.layout ?? defaultLayout(p), p);
      }
      // Balance close/removeProject release: acquire a model ref for every restored file tab.
      for (const p of projects) {
        for (const g of layouts[p.id].groups) {
          for (const t of g.tabs) {
            if (t.kind === "file") registry.acquire(t.ref);
          }
        }
      }
      set({
        projects,
        homeDir: home,
        layouts,
        selectedProjectId: projects[0]?.id ?? null,
        accounts,
        defaultAccount,
        privateMode: trust.privateMode,
        opencode,
      });
    },

    setDefaultAgent: (id) => {
      localStorage.setItem(DEFAULT_AGENT_KEY, id);
      set({ defaultAgent: id });
    },

    installAgent: async (id) => {
      try {
        await invoke<string>("install_agent", { agent: id });
      } catch (e) {
        return String(e);
      }
      // Re-detect so a freshly-installed agent flips to "ready".
      await get().loadAgents();
      return null;
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

    // ---- Trust boundaries (Feature 4) ----
    loadTrustSettings: async () => {
      try {
        const t = await invoke<TrustSettings>("get_trust_settings");
        set({ privateMode: t.privateMode });
      } catch { /* keep current */ }
    },
    setPrivateMode: async (on) => {
      await invoke("set_trust_settings", { settings: { privateMode: on } }).catch(() => {});
      set({ privateMode: on });
    },
    setSessionTrust: async (sessionId, trust) => {
      await invoke("set_session_trust", { sessionId, trust }).catch(() => {});
      set((s) => ({
        projects: s.projects.map((p) => ({
          ...p,
          sessions: p.sessions.map((x) =>
            x.id === sessionId
              ? {
                  ...x,
                  clearance: trust.clearance,
                  silo: trust.silo,
                  localOnly: trust.localOnly,
                  channels: trust.channels,
                  modelTier: trust.modelTier ?? undefined,
                  seedMemory: trust.seedMemory ?? undefined,
                }
              : x,
          ),
        })),
      }));
    },
    scanSensitivity: async (text) => {
      try {
        return await invoke<SensitivityHit[]>("scan_sensitivity", { text });
      } catch {
        return [];
      }
    },

    // ---- OpenCode local provider ----
    loadOpenCodeSettings: async () => {
      try {
        const [opencode, opencodeKeySet] = await Promise.all([
          invoke<OpenCodeSettings>("get_opencode_settings"),
          invoke<boolean>("opencode_key_set"),
        ]);
        set({ opencode, opencodeKeySet });
      } catch { /* keep current */ }
    },
    setOpenCodeSettings: async (settings) => {
      await invoke("set_opencode_settings", { settings }).catch(() => {});
      set({ opencode: settings });
    },
    setOpenCodeKey: async (key) => {
      if (key.trim()) {
        await invoke("set_opencode_key", { key }).catch(() => {});
        set({ opencodeKeySet: true });
      } else {
        await invoke("clear_opencode_key").catch(() => {});
        set({ opencodeKeySet: false });
      }
    },
    detectLocalProviders: async () => {
      try {
        return await invoke<LocalProviderStatus[]>("detect_local_providers");
      } catch {
        return [];
      }
    },
    listLocalModels: async (baseUrl, preset) => {
      try {
        return await invoke<LocalModel[]>("list_local_models", { baseUrl, preset });
      } catch (e) {
        return String(e);
      }
    },
    probeToolCall: async (baseUrl, model) => {
      try {
        return await invoke<ToolProbeResult>("probe_tool_call", { baseUrl, model });
      } catch (e) {
        return String(e);
      }
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
      const s = get();
      const layout = s.layouts[id];
      const fileTabs = layout
        ? layout.groups.flatMap((g) => g.tabs.filter((t) => t.kind === "file").map((t) => t.ref))
        : [];
      if (fileTabs.some((ref) => s.dirty[ref])) {
        const ok = await ask("This project has unsaved file changes. Remove it and discard them?", {
          title: "Conduit",
          kind: "warning",
        });
        if (!ok) return;
      }
      await invoke("remove_project", { id });
      for (const ref of fileTabs) {
        s.setDirty(ref, false);
        registry.release(ref);
        registry.disposeIfUnreferenced(ref);
      }
      set((st) => {
        const layouts = { ...st.layouts };
        delete layouts[id];
        const projects = st.projects.filter((p) => p.id !== id);
        const selectedProjectId =
          st.selectedProjectId === id ? projects[0]?.id ?? null : st.selectedProjectId;
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
    openFile: (projectId, path, reveal) => {
      const l = get().layouts[projectId];
      // Only a genuinely new tab bumps the ref (rOpenTab just re-activates an existing one).
      const already = !!l && l.groups.some((g) => g.tabs.some((t) => t.ref === path));
      applyLayout(projectId, (l2) => rOpenTab(l2, { kind: "file", ref: path }));
      if (!already) registry.acquire(path);
      // One-shot reveal target: CodeEditorPane scrolls to it once the model is set.
      if (reveal) set({ pendingReveal: { path, line: reveal.line, col: reveal.col ?? 1 } });
    },

    bumpDir: (dirPath) =>
      set((s) => ({
        dirVersion: { ...s.dirVersion, [dirPath]: (s.dirVersion[dirPath] ?? 0) + 1 },
      })),

    renamePath: async (projectId, from, to) => {
      // Block: a dirty open buffer must be saved or discarded first.
      if (get().dirty[from]) {
        void invoke("notify_user", {
          title: "Conduit",
          body: "Save or discard changes before renaming this file.",
        }).catch(() => {});
        return;
      }
      try {
        await invoke("rename_path", { from, to });
      } catch (e) {
        void invoke("notify_user", { title: "Conduit", body: String(e) }).catch(() => {});
        return;
      }
      // If `from` is a (clean) open file tab: close old + release its model, open new.
      const layout = get().layouts[projectId];
      const g = layout?.groups.find((gr) =>
        gr.tabs.some((t) => t.kind === "file" && t.ref === from),
      );
      if (g) {
        get().closeTab(projectId, g.id, from);
        registry.release(from);
        registry.disposeIfUnreferenced(from);
        get().openFile(projectId, to);
      }
      // Re-list only the affected folder(s).
      get().bumpDir(parentDir(from));
      const toParent = parentDir(to);
      if (toParent !== parentDir(from)) get().bumpDir(toParent);
    },

    deletePath: async (projectId, path) => {
      // Block: a dirty open buffer must be saved or discarded first.
      if (get().dirty[path]) {
        void invoke("notify_user", {
          title: "Conduit",
          body: "Save or discard changes before deleting this file.",
        }).catch(() => {});
        return;
      }
      try {
        await invoke("delete_path", { path });
      } catch (e) {
        void invoke("notify_user", { title: "Conduit", body: String(e) }).catch(() => {});
        return;
      }
      // Close a clean open tab for the deleted file + release its model.
      const layout = get().layouts[projectId];
      const g = layout?.groups.find((gr) =>
        gr.tabs.some((t) => t.kind === "file" && t.ref === path),
      );
      if (g) {
        get().closeTab(projectId, g.id, path);
        registry.release(path);
        registry.disposeIfUnreferenced(path);
      }
      get().bumpDir(parentDir(path));
    },

    setDirty: (path, dirty) =>
      set((s) => {
        const next = { ...s.dirty };
        if (dirty) next[path] = true;
        else delete next[path];
        return { dirty: next };
      }),

    clearConflict: (path) =>
      set((s) => {
        if (!(path in s.conflict)) return {};
        const next = { ...s.conflict };
        delete next[path];
        return { conflict: next };
      }),

    setConflict: (path, c) =>
      set((s) => ({ conflict: { ...s.conflict, [path]: c } })),

    clearPendingReveal: () => set((s) => (s.pendingReveal ? { pendingReveal: null } : {})),

    saveFile: async (path) => {
      const entry = registry.model(path);
      // Hard guard: no model, read-only buffer, or unrevealed => never write.
      if (!entry || entry.readOnly || !entry.model) return;
      const value = entry.model.getValue();
      registry.saving.add(path);
      try {
        const stat = await invoke<FileStat>("write_file", { path, content: value });
        registry.setSaved(path, { mtimeMs: stat.mtimeMs, size: stat.size });
        get().setDirty(path, false);
        get().clearConflict(path);
      } catch (e) {
        void invoke("notify_user", { title: "Conduit", body: `Save failed: ${String(e)}` }).catch(
          () => {},
        );
      } finally {
        registry.saving.delete(path);
      }
    },

    requestCloseTab: async (projectId, groupId, ref) => {
      const s = get();
      const group = s.layouts[projectId]?.groups.find((g) => g.id === groupId);
      const tab = group?.tabs.find((t) => t.ref === ref);
      const isFile = tab?.kind === "file";
      if (isFile && s.dirty[ref]) {
        const ok = await ask(`Discard unsaved changes to ${baseName(ref)}?`, {
          title: "Conduit",
          kind: "warning",
        });
        if (!ok) return;
      }
      s.closeTab(projectId, groupId, ref);
      if (isFile) {
        s.setDirty(ref, false);
        registry.release(ref);
        registry.disposeIfUnreferenced(ref);
      }
    },

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

    moveTab: (projectId, fromGroupId, ref, toGroupId, toIndex) =>
      applyLayout(projectId, (l) => reduceMoveTab(l, fromGroupId, ref, toGroupId, toIndex)),

    splitTab: (projectId, ref, targetGroupId, side) =>
      applyLayout(projectId, (l) => reduceSplitTab(l, ref, targetGroupId, side, uid())),

    setGroupWeights: (projectId, weights) =>
      applyLayout(projectId, (l) => {
        l.weights = weights;
        return l;
      }),

    setTopTab: (t) => set({ topTab: t }),
    setBottomTab: (t) => set({ bottomTab: t }),

    toggleSidebar: () =>
      set((s) => {
        const next = !s.sidebarCollapsed;
        writeSidebarCollapsed(next);
        return { sidebarCollapsed: next };
      }),
    toggleRight: () =>
      set((s) => {
        const next = !s.rightCollapsed;
        writeRightCollapsed(next);
        return { rightCollapsed: next };
      }),
    setShowSettings: (v) => set({ showSettings: v }),
    setSettingsTab: (t) => set({ settingsTab: t }),

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

/** Parent directory of an absolute path (no trailing slash). Root stays "/". */
export function parentDir(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
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
