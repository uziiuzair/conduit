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
import { ask } from "@tauri-apps/plugin-dialog";
import * as registry from "./monaco/registry";
import {
  cycleTabRef,
  moveTab as reduceMoveTab,
  reopenTabAt as reduceReopenTabAt,
  splitTab as reduceSplitTab,
} from "./layout";
import { cleanupEdits } from "./trim";
import type * as Monaco from "monaco-editor";
import type { SettingsTab } from "./components/Settings";
import type { PluginDescriptor, PluginPermission } from "./plugins/types";
import { pluginHost } from "./plugins/host";
import { feedSession } from "./plugins";

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
  /** The agent's own captured conversation id (agy), for resume. Set by the backend. */
  agentConversationId?: string | null;
}

/** A registered agent account (mirrors the Rust serde struct, camelCase). */
export interface Account {
  id: string;
  label: string;
  configDir: string;
  /** Which agents this account is signed in for (assignment eligibility + usage bar). */
  agents: AgentId[];
}

/** Per-agent default account map: agent id -> account id (mirrors the Rust HashMap). */
export type DefaultAccounts = Partial<Record<AgentId, string>>;

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
  /** Preview (transient, italic) tab: the next preview open in its group replaces it.
   *  Pinned by editing, double-click, or an explicit (non-preview) open. Mirrored in
   *  the Rust WsTab struct so it survives layout persistence. */
  preview?: boolean;
}

/** A recently closed file tab, restorable via ⌘⇧T (explicit closes only). */
export interface ClosedTab {
  projectId: string;
  groupId: string;
  index: number;
  ref: string;
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

/** Mirror of hotexit::HotExitEntry (serde camelCase). */
export interface HotExitEntry {
  path: string;
  content: string;
  mtimeMs: number;
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
  /** Per-agent default account for this project's sessions (beats the global default). */
  defaultAccounts?: DefaultAccounts;
}

// ---- Task board (Conductor board) ----
export interface BoardColumn { id: string; name: string }
export interface BoardClaim { by: string; at: number; leaseUntil: number }
export interface BoardComment { by: string; at: number; text: string }
export type Stage =
  | "requested" | "discovery" | "requirement_draft" | "business_clarification"
  | "ux_input" | "architecture_input" | "implementation_plan" | "implementation"
  | "verification" | "blocked" | "done";
export interface WorkflowHistory { at: number; by: string; from: Stage; to: Stage; note: string }
export interface Workflow {
  kind: string; stage: Stage; resumeState: Stage | null;
  blockedQuestion: string | null; history: WorkflowHistory[];
}
export interface BoardCard {
  id: string; title: string; body: string; column: string; order: string;
  labels: string[]; createdBy: string; createdAt: number; updatedAt: number;
  workflow: Workflow | null; links: { workItem: string | null; pr: string; branch: string };
  comments: BoardComment[]; claim: BoardClaim | null;
}
export interface BoardSnapshot { columns: BoardColumn[]; cards: BoardCard[] }

// ---- Continuity (presence + handoffs) — mirror the Rust serde structs (camelCase) ----
export interface Presence { sessionId: string; status: "active" | "idle" | "gone"; lastSeenAt: string }
export interface CardHandoff {
  cardId: string; id: string; fromLabel: string | null; context: string;
  state: string | null; suggestedNextActions: string | null; status: string; createdAt: string;
}
export interface ContinuityView { presence: Presence[]; handoffs: CardHandoff[] }

/** Center pane mode, per project: the terminal workspace or the task board. */
export type CenterMode = "terminals" | "board";

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
/** One account's Claude usage (mirrors Rust ClaudeAccountUsage). accountId null = env default. */
export interface ClaudeAccountUsage {
  accountId: string | null;
  label: string;
  usage: ClaudeUsage;
}

// ---- Antigravity (agy) usage — mirror Rust agy_usage.rs (camelCase) ----
export interface AgyBucket {
  bucketId: string;
  label: string; // "Weekly" | "5-hour"
  remainingFraction: number; // 0..1
  resetsAt: string | null;
  disabled: boolean;
}
export interface AgyGroup {
  displayName: string; // "Gemini Models" | "Claude & GPT Models"
  buckets: AgyBucket[];
}
export interface AgyContext {
  usedPercentage: number;
  contextWindowSize: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}
export interface AgyUsage {
  /** Resolved account this snapshot belongs to; null = env default. Keys agyUsageByAccount. */
  accountId: string | null;
  planTier: string | null;
  email: string | null;
  groups: AgyGroup[];
  context: AgyContext | null;
  agentState: string | null;
  updatedAt: number; // epoch ms
}
/** The map key for an account snapshot (env default has no id). */
export function accountKey(accountId: string | null | undefined): string {
  return accountId ?? "default";
}

// ---- Usage bar view preferences (user-configurable; persisted in localStorage) ----
export interface UsagePrefs {
  /** How the usage bar renders. "selected" reproduces the pre-multi-account single panel. */
  layout: "selected" | "stacked" | "summary" | "lowAlertOnly";
  /** Which windows to show. Off-by-one agents just skip the windows they don't have. */
  windows: { fiveHour: boolean; weekly: boolean; weeklyOpus: boolean; context: boolean };
  /** Row order: most-critical (least remaining) first, or alphabetical by label. */
  sort: "critical" | "label";
  /** A window at or below this % remaining is "low" (drives the hot color + lowAlertOnly). */
  lowThresholdPct: number;
}
export const DEFAULT_USAGE_PREFS: UsagePrefs = {
  layout: "selected",
  windows: { fiveHour: true, weekly: true, weeklyOpus: true, context: true },
  sort: "critical",
  lowThresholdPct: 20,
};
const USAGE_PREFS_KEY = "conduit.usagePrefs";
function readUsagePrefs(): UsagePrefs {
  try {
    const raw = localStorage.getItem(USAGE_PREFS_KEY);
    if (!raw) return DEFAULT_USAGE_PREFS;
    const p = JSON.parse(raw);
    return {
      ...DEFAULT_USAGE_PREFS,
      ...p,
      windows: { ...DEFAULT_USAGE_PREFS.windows, ...(p?.windows ?? {}) },
    };
  } catch {
    return DEFAULT_USAGE_PREFS;
  }
}
function writeUsagePrefs(p: UsagePrefs): void {
  try {
    localStorage.setItem(USAGE_PREFS_KEY, JSON.stringify(p));
  } catch {
    /* quota — non-fatal */
  }
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
/** Per-account "plan usage connected" flags, keyed by accountKey (env default = "default").
 *  Migrates the legacy boolean ("1") to `{ default: true }`. */
export function readPlanConnected(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(PLAN_CONNECTED_KEY);
    if (raw === "1") return { default: true };
    if (raw === "0" || raw == null) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}
function writePlanConnected(v: Record<string, boolean>): void {
  try {
    localStorage.setItem(PLAN_CONNECTED_KEY, JSON.stringify(v));
  } catch {
    /* quota — non-fatal */
  }
}

// Restore-on-open: eagerly spawn (and resume) every session of the ACTIVE project on launch /
// project switch, instead of waiting for a click. Default ON. Same persisted-pref pattern.
const RESTORE_SESSIONS_KEY = "conduit.restoreSessionsOnOpen";
function readRestoreSessionsOnOpen(): boolean {
  try {
    return localStorage.getItem(RESTORE_SESSIONS_KEY) !== "0"; // default on (absent => true)
  } catch {
    return true;
  }
}
function writeRestoreSessionsOnOpen(v: boolean): void {
  try {
    localStorage.setItem(RESTORE_SESSIONS_KEY, v ? "1" : "0");
  } catch {
    /* quota — non-fatal */
  }
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

// Editor UX prefs (native View menu). Same localStorage pattern as the collapse flags;
// fontZoom follows the width prefs' validate-else-default idiom (never clamp a bad read).
const WORD_WRAP_KEY = "conduit.wordWrap";
const TRIM_ON_SAVE_KEY = "conduit.trimOnSave";
const FONT_ZOOM_KEY = "conduit.fontZoom";
export const FONT_ZOOM_MIN = -4;
export const FONT_ZOOM_MAX = 8;
function readWordWrap(): boolean {
  try { return localStorage.getItem(WORD_WRAP_KEY) === "1"; } catch { return false; }
}
function writeWordWrap(v: boolean): void {
  try { localStorage.setItem(WORD_WRAP_KEY, v ? "1" : "0"); } catch { /* quota — non-fatal */ }
}
function readTrimOnSave(): boolean {
  try { return localStorage.getItem(TRIM_ON_SAVE_KEY) === "1"; } catch { return false; }
}
function writeTrimOnSave(v: boolean): void {
  try { localStorage.setItem(TRIM_ON_SAVE_KEY, v ? "1" : "0"); } catch { /* quota — non-fatal */ }
}
function readFontZoom(): number {
  try {
    const v = Number(localStorage.getItem(FONT_ZOOM_KEY));
    return Number.isInteger(v) && v >= FONT_ZOOM_MIN && v <= FONT_ZOOM_MAX ? v : 0;
  } catch {
    return 0;
  }
}
function writeFontZoom(v: number): void {
  try { localStorage.setItem(FONT_ZOOM_KEY, String(v)); } catch { /* quota — non-fatal */ }
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

/** The account key a session resolves to (session → project default → global default →
 *  env default), mirroring the Rust resolver. Used by the usage bar's "selected" layout. */
export function resolvedAccountKey(
  defaultAccounts: DefaultAccounts,
  project: Project,
  session: Session,
): string {
  const id =
    session.accountId ??
    project.defaultAccounts?.[session.agent] ??
    defaultAccounts[session.agent] ??
    null;
  return accountKey(id);
}

// ---- whitespace-on-save ----
/** Apply "Clean Whitespace on Save" as ONE undoable model edit, just before the
 *  write, so the post-cleanup version id becomes the saved baseline (saveFile's
 *  setSaved captures it after the write). Cast precedent: CodeEditorPane's onReload —
 *  RegistryModel deliberately hides edit APIs. Markdown keeps trailing spaces (hard
 *  line breaks) but still gains the final newline. */
function applyWhitespaceCleanup(m: Monaco.editor.ITextModel): void {
  const lines = m.getLinesContent();
  const { trims, appendFinalNewline } = cleanupEdits(lines, {
    trimTrailing: m.getLanguageId() !== "markdown",
  });
  const edits: Monaco.editor.IIdentifiedSingleEditOperation[] = trims.map((t) => ({
    range: {
      startLineNumber: t.lineNumber,
      startColumn: t.fromColumn,
      endLineNumber: t.lineNumber,
      endColumn: t.endColumn,
    },
    text: "",
  }));
  if (appendFinalNewline) {
    const line = lines.length;
    const col = (lines[line - 1]?.length ?? 0) + 1;
    edits.push({
      range: { startLineNumber: line, startColumn: col, endLineNumber: line, endColumn: col },
      text: m.getEOL(),
    });
  }
  if (edits.length) m.pushEditOperations([], edits, () => null);
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
  editingProjectId: string | null;
  homeDir: string | null;
  topTab: TopTab;
  bottomTab: BottomTab;
  themePref: ThemePref;
  activeThemeId: ThemeId;

  claudeStatus: ClaudeStatus | null;
  /** Claude usage per account (env default + every registered Claude account). */
  claudeUsage: ClaudeAccountUsage[];
  /** Per-account "plan usage connected" flags, keyed by accountKey. */
  planConnected: Record<string, boolean>;
  /** agy usage per account, keyed by accountKey (accountId ?? "default"). */
  agyUsageByAccount: Record<string, AgyUsage>;
  agyUsageTracking: boolean;
  /** Usage-bar view preferences (layout, window filters, sort, low threshold). */
  usagePrefs: UsagePrefs;
  setUsagePrefs: (patch: Partial<UsagePrefs>) => void;

  // ---- panel collapse + Settings dialog (native menu-driven, App-level) ----
  /** Persisted. When true (default), opening/switching to a project eagerly spawns and
   *  resumes all its sessions instead of waiting for a click. */
  restoreSessionsOnOpen: boolean;
  setRestoreSessionsOnOpen: (v: boolean) => void;
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
  /** Run an agent's official installer, then re-detect. Returns an error string or null. */
  installAgent: (id: AgentId) => Promise<string | null>;
  completeAgentSetup: () => void;
  /** Anonymous-telemetry opt-out (true = do not send). Default false (on). */
  telemetryOptOut: boolean;
  setTelemetryOptOut: (v: boolean) => void;
  loadAgents: () => Promise<void>;

  // ---- Agent account registry (Feature 2 + multi-account) ----
  accounts: Account[];
  /** Per-agent global default account (agent -> account id). */
  defaultAccounts: DefaultAccounts;
  loadAccounts: () => Promise<void>;
  discoverAccounts: () => Promise<Account[]>;
  /** Returns an error string (duplicate / missing dir) or null on success. */
  addAccount: (label: string, configDir: string) => Promise<string | null>;
  removeAccount: (id: string) => Promise<void>;
  /** Set (id) or clear (null) the global default account for one agent. */
  setDefaultAccount: (agent: AgentId, id: string | null) => Promise<void>;
  /** Set (id) or clear (null) a project's default account for one agent. */
  setProjectDefaultAccount: (
    projectId: string,
    agent: AgentId,
    id: string | null,
  ) => Promise<void>;
  /** Overwrite which agents an account is signed in for. */
  setAccountAgents: (accountId: string, agents: AgentId[]) => Promise<void>;
  /** Pin (id) or clear (null) a single session's account. */
  setSessionAccount: (sessionId: string, id: string | null) => Promise<void>;

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

  // Plugins
  plugins: PluginDescriptor[];
  refreshPlugins: () => Promise<void>;
  enablePlugin: (id: string, grants: PluginPermission[], version: string) => Promise<void>;
  disablePlugin: (id: string) => Promise<void>;
  removePlugin: (id: string) => Promise<void>;
  setAllPluginsEnabled: (enabled: boolean) => Promise<void>;

  addProject: (path: string) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  addSession: (projectId: string, opts?: { name?: string; useWorktree?: boolean; agent?: AgentId; role?: SessionRole; account?: string | null }) => Promise<void>;
  renameSession: (projectId: string, sessionId: string, name: string) => Promise<void>;
  /** Rename a project's display label only (not the directory on disk). */
  renameProject: (projectId: string, name: string) => Promise<void>;
  /** Move a project / session in the sidebar. `toIndex` is the insertion index in the
   *  list WITHOUT the moved item (sessions reorder within their own project only). */
  reorderProject: (projectId: string, toIndex: number) => Promise<void>;
  reorderSession: (projectId: string, sessionId: string, toIndex: number) => Promise<void>;
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
  /** Open a file tab. `preview: true` opens transiently: it replaces the active
   *  group's current preview tab; a later explicit open (or an edit) pins it.
   *  `reveal` is a one-shot scroll target (terminal path-click's :line:col). */
  openFile: (
    projectId: string,
    path: string,
    opts?: { preview?: boolean; reveal?: { line: number; col?: number } },
  ) => void;
  /** Clear the preview flag on any tab holding `ref` (pin). */
  pinTab: (projectId: string, ref: string) => void;

  // ---- Tier-2 editor UX ----
  /** Recently closed file tabs (explicit closes only), most recent last. Session-only. */
  closedTabs: ClosedTab[];
  reopenClosedTab: () => void;
  saveAll: () => Promise<void>;
  /** ⌃Tab / ⌃⇧Tab within the active group (wrapping). */
  cycleTab: (delta: 1 | -1) => void;
  /** ⌘1..9 — 1-based tab index in the active group; 9 = last (browser convention). */
  activateTabAt: (index: number) => void;
  /** projectId -> maximized groupId. Ephemeral by design: validateLayout and the Rust
   *  ProjectLayout struct would both strip it from the persisted layout. */
  maximized: Record<string, string>;
  toggleMaximizeGroup: (projectId: string) => void;
  /** Persisted editor prefs (View menu). */
  wordWrap: boolean;
  toggleWordWrap: () => void;
  trimOnSave: boolean;
  toggleTrimOnSave: () => void;
  fontZoom: number;
  setFontZoom: (z: number) => void;
  /** Ask the file tree to expand to + scroll to a path (nonce forces re-trigger). */
  reveal: { path: string; nonce: number } | null;
  revealInTree: (path: string) => void;
  /** Consume the reveal request (FileTree calls this once handled) — without it a
   *  stale request would replay on every FileTree remount (refresh, git poll, …). */
  clearReveal: () => void;

  // ---- Tier-3 editor UX ----
  /** projectId -> MRU absolute file paths, most recent first (Quick Open's empty-
   *  query list). Session-only. */
  recentFiles: Record<string, string[]>;
  /** One-shot request that the pane showing `path` enter ("on") or flip ("toggle")
   *  its diff-with-HEAD view. Consumed by CodeEditorPane like pendingReveal. */
  pendingDiff: { path: string; nonce: number; mode: "on" | "toggle" } | null;
  requestDiff: (path: string, mode: "on" | "toggle") => void;
  clearPendingDiff: () => void;
  /** Format the active file tab through the project's formatter (Rust shell-out);
   *  applies the result as one undo-preserving edit. Errors surface as toasts. */
  formatActiveDocument: () => Promise<void>;
  /** Overwrite an open buffer with current disk content (undo-preserving), settle
   *  its dirty/conflict state. Used after an explicit discard-to-HEAD; no-op when
   *  the path has no live editable model. */
  reloadBufferFromDisk: (path: string) => Promise<void>;
  /** Hot exit: path -> backed-up content from the previous run, loaded once at
   *  startup and consumed (one-shot) as panes create models for those paths. */
  hotExit: Record<string, string>;
  consumeHotExit: (path: string) => string | undefined;
  /** Write the current dirty set to the hot-exit backup. True on success —
   *  the quit path quits silently only when this succeeds. */
  flushHotExit: () => Promise<boolean>;

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
  startProjectRename: (projectId: string) => void;
  cancelProjectRename: () => void;
  setStatus: (id: string, status: SessionStatus) => void;
  setTodos: (id: string, todos: TodoItem[]) => void;
  setActivity: (id: string, activity: string | undefined) => void;
  setCompacting: (id: string, compacting: boolean) => void;
  setThemePref: (pref: ThemePref) => void;
  applySystemDark: (dark: boolean) => void;

  refreshClaudeStatus: () => Promise<void>;
  refreshClaudeUsage: () => Promise<void>;
  /** Connect plan usage for one account (null = env default). */
  connectPlanUsage: (accountId: string | null) => Promise<boolean>;
  /** One click: enable agy push-tracking + connect plan usage for every Claude account. */
  connectAllUsage: () => Promise<void>;
  setAgyUsage: (u: AgyUsage) => void;
  refreshAgyUsage: () => Promise<void>;
  refreshAgyUsageTracking: () => Promise<void>;
  setAgyUsageTracking: (enabled: boolean) => Promise<boolean>;

  // ---- Task board (Conductor board) ----
  /** Center pane mode per project ("terminals" | "board"); default (unset) is "terminals". */
  centerMode: Record<string, CenterMode>;
  /** Latest board snapshot per project, refreshed by useBoard. */
  boards: Record<string, BoardSnapshot>;
  /** Latest continuity view (presence + handoffs) per project, refreshed by useBoard. */
  continuity: Record<string, ContinuityView>;
  setCenterMode: (projectId: string, mode: CenterMode) => void;
  toggleCenterMode: (projectId: string) => void;
  setBoard: (projectId: string, snapshot: BoardSnapshot) => void;
  setContinuity: (projectId: string, view: ContinuityView) => void;
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
      const patch: Partial<AppState> = { layouts: { ...s.layouts, [projectId]: next } };
      // Maximize follows the active group: any layout action that activates a
      // DIFFERENT group (open/select/split/reopen/…) — or prunes the maximized one —
      // restores the split view. Without this, the newly active pane would stay
      // hidden behind the `gi === maxIdx` visibility gate: an invisible active group.
      const maxId = s.maximized[projectId];
      if (maxId && (next.activeGroupId !== maxId || !next.groups.some((g) => g.id === maxId))) {
        const m = { ...s.maximized };
        delete m[projectId];
        patch.maximized = m;
      }
      return patch;
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
    claudeUsage: [],
    planConnected: readPlanConnected(),
    updateInfo: null,
    updatePhase: "idle",
    updateProgress: 0,
    updateError: null,
    agyUsageByAccount: {},
    agyUsageTracking: false,
    usagePrefs: readUsagePrefs(),
    restoreSessionsOnOpen: readRestoreSessionsOnOpen(),
    sidebarCollapsed: readSidebarCollapsed(),
    rightCollapsed: readRightCollapsed(),
    showSettings: false,
    settingsTab: "agents",
    menu: null,
    editingSessionId: null,
    editingProjectId: null,
    homeDir: null,
    agents: null,
    defaultAgent: readDefaultAgent(),
    accounts: [],
    defaultAccounts: {},
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

    plugins: [],

    topTab: "files",
    bottomTab: "terminal",
    themePref: readStoredPref(),
    activeThemeId: resolveThemeId(readStoredPref(), systemPrefersDark()),
    closedTabs: [],
    maximized: {},
    wordWrap: readWordWrap(),
    trimOnSave: readTrimOnSave(),
    fontZoom: readFontZoom(),
    reveal: null,
    recentFiles: {},
    pendingDiff: null,
    hotExit: {},

    load: async () => {
      const [projects, home, accounts, defaultAccounts, trust, opencode, hotExitEntries] =
        await Promise.all([
          invoke<Project[]>("load_projects"),
          getHomeDir().catch(() => null),
          invoke<Account[]>("list_accounts").catch(() => [] as Account[]),
          invoke<DefaultAccounts>("get_default_accounts").catch(() => ({}) as DefaultAccounts),
          invoke<TrustSettings>("get_trust_settings").catch(
            () => ({ privateMode: false }) as TrustSettings,
          ),
          invoke<OpenCodeSettings>("get_opencode_settings").catch(() => get().opencode),
          invoke<HotExitEntry[]>("hotexit_load").catch(() => [] as HotExitEntry[]),
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
      // Hot-exit backups from the previous run: stashed keyed by path, consumed
      // one-shot as panes create models. Never blocks load.
      const hotExit: Record<string, string> = {};
      for (const e of hotExitEntries) hotExit[e.path] = e.content;
      set({
        projects,
        homeDir: home,
        layouts,
        selectedProjectId: projects[0]?.id ?? null,
        accounts,
        defaultAccounts,
        privateMode: trust.privateMode,
        opencode,
        hotExit,
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
      const [accounts, defaultAccounts] = await Promise.all([
        invoke<Account[]>("list_accounts").catch(() => [] as Account[]),
        invoke<DefaultAccounts>("get_default_accounts").catch(() => ({}) as DefaultAccounts),
      ]);
      set({ accounts, defaultAccounts });
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
      // A removed account also detaches from any project defaults; refresh the tree.
      await get().load();
    },
    setDefaultAccount: async (agent, id) => {
      await invoke("set_default_account", { agent, accountId: id }).catch(() => {});
      set((s) => {
        const next = { ...s.defaultAccounts };
        if (id) next[agent] = id;
        else delete next[agent];
        return { defaultAccounts: next };
      });
    },
    setProjectDefaultAccount: async (projectId, agent, id) => {
      await invoke("set_project_default_account", { projectId, agent, accountId: id }).catch(
        () => {},
      );
      set((s) => ({
        projects: s.projects.map((p) => {
          if (p.id !== projectId) return p;
          const next: DefaultAccounts = { ...(p.defaultAccounts ?? {}) };
          if (id) next[agent] = id;
          else delete next[agent];
          return { ...p, defaultAccounts: next };
        }),
      }));
    },
    setAccountAgents: async (accountId, agents) => {
      await invoke("set_account_agents", { accountId, agents }).catch(() => {});
      await get().loadAccounts();
    },
    setSessionAccount: async (sessionId, id) => {
      await invoke("set_session_account", { sessionId, accountId: id }).catch(() => {});
      set((s) => ({
        projects: s.projects.map((p) => ({
          ...p,
          sessions: p.sessions.map((sess) =>
            sess.id === sessionId ? { ...sess, accountId: id } : sess,
          ),
        })),
      }));
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

    refreshPlugins: async () => {
      const plugins = await invoke<PluginDescriptor[]>("list_plugins");
      set({ plugins });
    },
    enablePlugin: async (id, grants, version) => {
      await invoke("set_plugin_grants", { id, permissions: grants, consentedVersion: version });
      await invoke("set_plugin_enabled", { id, enabled: true });
      await get().refreshPlugins();
      const desc = get().plugins.find((p) => p.id === id);
      if (desc) await pluginHost.start(desc);
    },
    disablePlugin: async (id) => {
      pluginHost.stop(id);
      await invoke("set_plugin_enabled", { id, enabled: false });
      await get().refreshPlugins();
    },
    removePlugin: async (id) => {
      pluginHost.stop(id);
      await invoke("remove_plugin", { id });
      await get().refreshPlugins();
    },
    setAllPluginsEnabled: async (enabled) => {
      if (!enabled) pluginHost.stopAll();
      for (const p of get().plugins) {
        if (p.manifest && p.problems.length === 0) {
          await invoke("set_plugin_enabled", { id: p.id, enabled });
        }
      }
      await get().refreshPlugins();
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
        // Clear dirty only when this was the model's last reference — the same
        // absolute path can be open under another project, whose buffer (and its
        // unsaved edits) survives this release.
        if ((registry.model(ref)?.refCount ?? 1) <= 1) s.setDirty(ref, false);
        registry.release(ref);
        registry.disposeIfUnreferenced(ref);
      }
      set((st) => {
        const layouts = { ...st.layouts };
        delete layouts[id];
        const maximized = { ...st.maximized };
        delete maximized[id];
        const projects = st.projects.filter((p) => p.id !== id);
        const selectedProjectId =
          st.selectedProjectId === id ? projects[0]?.id ?? null : st.selectedProjectId;
        return { projects, layouts, selectedProjectId, maximized };
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
      // Pin an explicitly-chosen account (blank = inherit the project/global default).
      if (opts?.account) {
        session.accountId = opts.account;
        await invoke("set_session_account", { sessionId: session.id, accountId: opts.account }).catch(
          () => {},
        );
      }
      set((s) => ({
        projects: s.projects.map((p) =>
          p.id === projectId ? { ...p, sessions: [...p.sessions, session] } : p,
        ),
        selectedProjectId: projectId,
      }));
      feedSession("session.start", { id: session.id, title: session.name });
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
      feedSession("session.rename", { id: sessionId, title: clean });
    },

    renameProject: async (projectId, name) => {
      const clean = name.trim();
      if (!clean) {
        set({ editingProjectId: null });
        return;
      }
      await invoke("rename_project", { projectId, name: clean });
      set((s) => ({
        editingProjectId: null,
        projects: s.projects.map((p) =>
          p.id === projectId ? { ...p, name: clean } : p,
        ),
      }));
    },

    reorderProject: async (projectId, toIndex) => {
      // Mirror optimistically (the move is local-first UX), then persist; a persist
      // failure only costs the order on next launch, never the projects themselves.
      set((s) => {
        const from = s.projects.findIndex((p) => p.id === projectId);
        if (from < 0) return {};
        const projects = [...s.projects];
        const [moved] = projects.splice(from, 1);
        projects.splice(Math.min(toIndex, projects.length), 0, moved);
        return { projects };
      });
      await invoke("reorder_project", { projectId, toIndex }).catch(() => {});
    },

    reorderSession: async (projectId, sessionId, toIndex) => {
      set((s) => ({
        projects: s.projects.map((p) => {
          if (p.id !== projectId) return p;
          const from = p.sessions.findIndex((x) => x.id === sessionId);
          if (from < 0) return p;
          const sessions = [...p.sessions];
          const [moved] = sessions.splice(from, 1);
          sessions.splice(Math.min(toIndex, sessions.length), 0, moved);
          return { ...p, sessions };
        }),
      }));
      await invoke("reorder_session", { projectId, sessionId, toIndex }).catch(() => {});
    },

    removeSession: async (projectId, sessionId) => {
      await invoke("remove_session", { projectId, sessionId });
      feedSession("session.stop", { id: sessionId });
      set((s) => {
        const live = { ...s.live };
        delete live[sessionId];
        const projects = s.projects.map((p) =>
          p.id === projectId
            ? { ...p, sessions: p.sessions.filter((x) => x.id !== sessionId) }
            : p,
        );
        let layouts = s.layouts;
        let maximized = s.maximized;
        const cur = s.layouts[projectId];
        if (cur) {
          const next = validateLayout(cur, projects.find((p) => p.id === projectId));
          persistLayout(projectId, next);
          layouts = { ...s.layouts, [projectId]: next };
          // Same maximize hygiene as applyLayout (this path commits a layout
          // directly): a pruned/deactivated maximized group must drop the flag or
          // the next ⇧⌘M is a silent no-op on a stale id.
          const maxId = s.maximized[projectId];
          if (maxId && (next.activeGroupId !== maxId || !next.groups.some((g) => g.id === maxId))) {
            maximized = { ...s.maximized };
            delete maximized[projectId];
          }
        }
        return { projects, live, layouts, maximized };
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
    openFile: (projectId, path, opts) => {
      const l = get().layouts[projectId];
      // Only a genuinely new tab bumps the ref (rOpenTab just re-activates an existing one).
      const already = !!l && l.groups.some((g) => g.tabs.some((t) => t.ref === path));
      const preview = !!opts?.preview && !already;
      // A preview open replaces the active group's current preview tab in place.
      let replaced: string | null = null;
      if (preview && l) {
        const g = activeGroup(l);
        replaced = g?.tabs.find((t) => t.preview && t.ref !== path)?.ref ?? null;
      }
      applyLayout(projectId, (l2) => {
        if (!opts?.preview) {
          // An explicit open of an existing preview tab pins it.
          for (const g of l2.groups) {
            const t = g.tabs.find((x) => x.ref === path && x.preview);
            if (t) delete t.preview;
          }
        }
        const tab: WsTab = preview
          ? { kind: "file", ref: path, preview: true }
          : { kind: "file", ref: path };
        if (replaced) {
          const g = l2.groups.find((x) => x.id === l2.activeGroupId) ?? l2.groups[0];
          const i = g ? g.tabs.findIndex((t) => t.ref === replaced) : -1;
          if (g && i !== -1) {
            g.tabs.splice(i, 1, tab);
            g.activeRef = path;
            l2.activeGroupId = g.id;
            return l2;
          }
        }
        return rOpenTab(l2, tab);
      });
      if (!already) registry.acquire(path);
      if (replaced) {
        // Same release pair as requestCloseTab. A preview tab pins on its first edit,
        // so the replaced buffer is never dirty.
        registry.release(replaced);
        registry.disposeIfUnreferenced(replaced);
      }
      // One-shot reveal target: CodeEditorPane scrolls to it once the model is set.
      if (opts?.reveal)
        set({ pendingReveal: { path, line: opts.reveal.line, col: opts.reveal.col ?? 1 } });
      // Quick Open's MRU: most recent first, deduped, capped.
      set((s) => {
        const prev = s.recentFiles[projectId] ?? [];
        const next = [path, ...prev.filter((p) => p !== path)].slice(0, 30);
        return { recentFiles: { ...s.recentFiles, [projectId]: next } };
      });
    },

    pinTab: (projectId, ref) =>
      applyLayout(projectId, (l) => {
        for (const g of l.groups) {
          const t = g.tabs.find((x) => x.ref === ref);
          if (t) delete t.preview;
        }
        return l;
      }),

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

    setDirty: (path, dirty) => {
      set((s) => {
        const next = { ...s.dirty };
        if (dirty) next[path] = true;
        else delete next[path];
        return { dirty: next };
      });
      // Editing pins a preview tab (VS Code semantics) — this also guarantees a
      // preview tab replaced by openFile is never dirty.
      if (dirty) {
        const s = get();
        for (const p of s.projects) {
          const hasPreview = s.layouts[p.id]?.groups.some((g) =>
            g.tabs.some((t) => t.ref === path && t.preview),
          );
          if (hasPreview) s.pinTab(p.id, path);
        }
      }
      // Rust consults this count on quit/window-close (DirtyGuard) so clean quits
      // stay instant while dirty ones round-trip for a confirm.
      void invoke("set_dirty_count", { count: Object.keys(get().dirty).length }).catch(() => {});
    },

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
      // The saving.has guard also makes the window re-entrancy-safe: a second ⌘S
      // while a write is in flight must not run (its finally would tear down the
      // first save's suppression window — the shared Set doesn't nest).
      if (!entry || entry.readOnly || !entry.model || registry.saving.has(path)) return;
      // Enter the saving window BEFORE any cleanup edit: it silences both the file
      // watcher and the pane's dirty dispatch for these transitional events — the
      // store is settled explicitly in the finally below.
      registry.saving.add(path);
      if (get().trimOnSave) {
        applyWhitespaceCleanup(entry.model as unknown as Monaco.editor.ITextModel);
      }
      const value = entry.model.getValue();
      // The version whose content is being written — snapshotted NEXT TO getValue().
      // setSaved must record this, not the post-write current id: a keystroke landing
      // during the awaited write would otherwise be absorbed into the saved point and
      // the buffer would read clean while differing from disk.
      const writtenVersion = entry.model.getAlternativeVersionId();
      try {
        const stat = await invoke<FileStat>("write_file", { path, content: value });
        registry.setSaved(path, { mtimeMs: stat.mtimeMs, size: stat.size }, writtenVersion);
        get().clearConflict(path);
      } catch (e) {
        void invoke("notify_user", { title: "Conduit", body: `Save failed: ${String(e)}` }).catch(
          () => {},
        );
      } finally {
        registry.saving.delete(path);
        // Settle the store on BOTH outcomes: success leaves it clean unless a
        // keystroke landed mid-write; a failed write after suppressed trim edits
        // must re-arm the dirty dot / Save All / quit guard.
        get().setDirty(path, registry.dirtyOf(path));
      }
    },

    requestCloseTab: async (projectId, groupId, ref) => {
      const s = get();
      const group = s.layouts[projectId]?.groups.find((g) => g.id === groupId);
      const tab = group?.tabs.find((t) => t.ref === ref);
      const isFile = tab?.kind === "file";
      // Guard/clear dirty only when this tab is the model's LAST reference (the same
      // absolute path can be open under another project): otherwise nothing is
      // discarded — the buffer lives on elsewhere — and force-clearing store.dirty
      // would strand it clean while the surviving tab still holds unsaved edits.
      const lastRef = isFile && (registry.model(ref)?.refCount ?? 1) <= 1;
      if (isFile && lastRef && s.dirty[ref]) {
        const ok = await ask(`Discard unsaved changes to ${baseName(ref)}?`, {
          title: "Conduit",
          kind: "warning",
        });
        if (!ok) return;
      }
      // Record explicit file closes for ⌘⇧T (rename/delete closes bypass this path —
      // their old ref is gone from disk and shouldn't be restorable).
      if (isFile && group) {
        const index = group.tabs.findIndex((t) => t.ref === ref);
        set((st) => ({
          closedTabs: [...st.closedTabs, { projectId, groupId, index, ref }].slice(-20),
        }));
      }
      s.closeTab(projectId, groupId, ref);
      if (isFile) {
        if (lastRef) s.setDirty(ref, false);
        registry.release(ref);
        registry.disposeIfUnreferenced(ref);
      }
    },

    reopenClosedTab: () => {
      const stack = [...get().closedTabs];
      while (stack.length) {
        const c = stack.pop()!;
        if (!get().projects.some((p) => p.id === c.projectId)) continue;
        set({ closedTabs: stack, selectedProjectId: c.projectId });
        const l = get().layouts[c.projectId];
        const already = !!l && l.groups.some((g) => g.tabs.some((t) => t.ref === c.ref));
        applyLayout(c.projectId, (l2) =>
          reduceReopenTabAt(l2, c.groupId, c.index, { kind: "file", ref: c.ref }),
        );
        if (!already) registry.acquire(c.ref);
        return;
      }
      set({ closedTabs: [] });
    },

    saveAll: async () => {
      const s = get();
      await Promise.all(Object.keys(s.dirty).map((p) => s.saveFile(p)));
    },

    cycleTab: (delta) => {
      const s = get();
      if (!s.selectedProjectId) return;
      const g = activeGroup(s.layouts[s.selectedProjectId]);
      if (!g) return;
      const ref = cycleTabRef(g, delta);
      if (ref) s.setActiveTab(s.selectedProjectId, g.id, ref);
    },

    activateTabAt: (index) => {
      const s = get();
      if (!s.selectedProjectId) return;
      const g = activeGroup(s.layouts[s.selectedProjectId]);
      if (!g || g.tabs.length === 0) return;
      const i = index >= 9 ? g.tabs.length - 1 : index - 1;
      if (i >= g.tabs.length) return;
      s.setActiveTab(s.selectedProjectId, g.id, g.tabs[i].ref);
    },

    toggleMaximizeGroup: (projectId) =>
      set((s) => {
        const next = { ...s.maximized };
        const l = s.layouts[projectId];
        const g = activeGroup(l);
        if (next[projectId] || !l || !g || l.groups.length < 2) {
          delete next[projectId];
        } else {
          next[projectId] = g.id;
        }
        return { maximized: next };
      }),

    toggleWordWrap: () =>
      set((s) => {
        const next = !s.wordWrap;
        writeWordWrap(next);
        return { wordWrap: next };
      }),

    toggleTrimOnSave: () =>
      set((s) => {
        const next = !s.trimOnSave;
        writeTrimOnSave(next);
        return { trimOnSave: next };
      }),

    setFontZoom: (z) => {
      const v = Math.max(FONT_ZOOM_MIN, Math.min(FONT_ZOOM_MAX, Math.round(z)));
      writeFontZoom(v);
      set({ fontZoom: v });
    },

    revealInTree: (path) =>
      set((s) => {
        if (s.rightCollapsed) writeRightCollapsed(false);
        return {
          rightCollapsed: false,
          topTab: "files" as TopTab,
          reveal: { path, nonce: (s.reveal?.nonce ?? 0) + 1 },
        };
      }),

    clearReveal: () => set({ reveal: null }),

    requestDiff: (path, mode) =>
      set((s) => ({
        pendingDiff: { path, nonce: (s.pendingDiff?.nonce ?? 0) + 1, mode },
      })),
    clearPendingDiff: () => set((s) => (s.pendingDiff ? { pendingDiff: null } : {})),

    formatActiveDocument: async () => {
      const s = get();
      const toast = (body: string) =>
        void invoke("notify_user", { title: "Format Document", body }).catch(() => {});
      const pid = s.selectedProjectId;
      const project = s.projects.find((p) => p.id === pid);
      const g = pid ? activeGroup(s.layouts[pid]) : null;
      const tab = g?.tabs.find((t) => t.ref === g.activeRef);
      if (!project || !tab || tab.kind !== "file") return;
      const path = tab.ref;
      const entry = registry.model(path);
      if (!entry?.model || entry.readOnly || registry.saving.has(path)) return;
      const content = entry.model.getValue();
      let formatted: string;
      try {
        const r = await invoke<{ formatted: string; formatter: string }>("format_content", {
          dir: project.path,
          path,
          content,
        });
        formatted = r.formatted;
      } catch (e) {
        toast(String(e));
        return;
      }
      // The buffer may have moved while the formatter ran; formatting a stale
      // snapshot would silently revert those keystrokes.
      if (entry.model.getValue() !== content) {
        toast("Buffer changed while formatting — try again.");
        return;
      }
      if (formatted === content) return;
      const m = entry.model as unknown as Monaco.editor.ITextModel;
      m.pushEditOperations(
        [],
        [{ range: m.getFullModelRange(), text: formatted }],
        () => null,
      );
    },

    reloadBufferFromDisk: async (path) => {
      const entry = registry.model(path);
      if (!entry?.model || entry.readOnly || registry.saving.has(path)) return;
      const fc = await invoke<FileContent>("read_file", { path });
      // Same post-await re-check + reconciliation window as CodeEditorPane.onReload:
      // an own save that started mid-read owns the buffer, and the pane's contentSub
      // must not dispatch for this transitional edit.
      if (registry.saving.has(path)) return;
      if (fc.error !== null || fc.binary || fc.readOnly) return;
      const m = entry.model as unknown as Monaco.editor.ITextModel;
      registry.saving.add(path);
      try {
        m.pushEditOperations([], [{ range: m.getFullModelRange(), text: fc.content }], () => null);
        registry.setSaved(path, { mtimeMs: fc.mtimeMs, size: fc.size });
      } finally {
        registry.saving.delete(path);
      }
      get().setDirty(path, registry.dirtyOf(path));
      get().clearConflict(path);
    },

    consumeHotExit: (path) => {
      const content = get().hotExit[path];
      if (content === undefined) return undefined;
      set((s) => {
        const hotExit = { ...s.hotExit };
        delete hotExit[path];
        return { hotExit };
      });
      return content;
    },

    flushHotExit: async () => {
      const entries: HotExitEntry[] = [];
      const covered = new Set<string>();
      for (const path of Object.keys(get().dirty)) {
        const entry = registry.model(path);
        if (!entry?.model || entry.readOnly) continue;
        covered.add(path);
        entries.push({ path, content: entry.model.getValue(), mtimeMs: Date.now() });
      }
      // Backups not yet consumed (their tab exists but was never revealed, so no
      // model was created) MUST ride along — models are lazy, and dropping these
      // here would destroy the only copy of the previous run's edits. A backup
      // whose tab no longer exists anywhere is dropped: nothing will ever consume it.
      const openRefs = new Set<string>();
      for (const layout of Object.values(get().layouts)) {
        for (const g of layout.groups) {
          for (const t of g.tabs) if (t.kind === "file") openRefs.add(t.ref);
        }
      }
      for (const [path, content] of Object.entries(get().hotExit)) {
        if (!covered.has(path) && openRefs.has(path)) {
          entries.push({ path, content, mtimeMs: Date.now() });
        }
      }
      try {
        await invoke("hotexit_save", { entries });
        return true;
      } catch {
        return false;
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
      applyLayout(projectId, (l) => {
        const next = reduceMoveTab(l, fromGroupId, ref, toGroupId, toIndex);
        // Dragging a tab is a deliberate placement — it pins a preview tab (VS Code
        // semantics), which also keeps the one-preview-per-group invariant: without
        // this, a dragged-in preview could be silently replaced by the next
        // single-click open in its new group.
        for (const g of next.groups) {
          const t = g.tabs.find((x) => x.ref === ref);
          if (t) delete t.preview;
        }
        return next;
      }),

    splitTab: (projectId, ref, targetGroupId, side) =>
      applyLayout(projectId, (l) => {
        const next = reduceSplitTab(l, ref, targetGroupId, side, uid());
        for (const g of next.groups) {
          const t = g.tabs.find((x) => x.ref === ref);
          if (t) delete t.preview; // splitting out is a deliberate placement too
        }
        return next;
      }),

    setGroupWeights: (projectId, weights) =>
      applyLayout(projectId, (l) => {
        l.weights = weights;
        return l;
      }),

    setTopTab: (t) => set({ topTab: t }),
    setBottomTab: (t) => set({ bottomTab: t }),

    setRestoreSessionsOnOpen: (v) => {
      writeRestoreSessionsOnOpen(v);
      set({ restoreSessionsOnOpen: v });
    },

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
    startProjectRename: (projectId) => set({ editingProjectId: projectId, menu: null }),
    cancelProjectRename: () => set({ editingProjectId: null }),

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
        const u = await invoke<ClaudeAccountUsage[]>("fetch_claude_usage");
        set({ claudeUsage: u });
      } catch { /* fail-open: keep last-known */ }
    },

    checkForUpdates: async (opts) => {
      // Don't interfere with an install already in progress.
      if (get().updatePhase === "downloading") return;
      const manual = opts?.manual ?? false;
      // Only show the transient "checking" state when there's no live banner to
      // disturb — otherwise a background poll would flicker an "available" notice.
      const showChecking =
        manual || get().updatePhase === "idle" || get().updatePhase === "error";
      if (showChecking) set({ updatePhase: "checking", updateError: null });
      try {
        const update = await check();
        if (!update) {
          void pendingUpdate?.close();
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
        // Release any previously-held handle (Update is a Rust-side Resource).
        if (pendingUpdate && pendingUpdate !== update) void pendingUpdate.close();
        pendingUpdate = null;
        if (!shouldNotify) {
          void update.close();
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
        // Fail open. A background check that errors leaves any existing pending
        // update untouched and stays quiet; only a manual check surfaces the error.
        if (manual) {
          set({ updatePhase: "error", updateError: String(e) });
        } else if (get().updatePhase === "checking") {
          set({ updatePhase: "idle" });
        }
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
      void pendingUpdate?.close();
      pendingUpdate = null;
      set({ updateInfo: null, updatePhase: "idle" });
    },

    connectPlanUsage: async (accountId) => {
      const key = accountKey(accountId);
      try {
        const ok = await invoke<boolean>("connect_claude_plan_usage", { accountId });
        const next = { ...get().planConnected, [key]: ok };
        writePlanConnected(next);
        set({ planConnected: next });
        if (ok) await get().refreshClaudeUsage();
        return ok;
      } catch {
        // An invoke-level failure is transient plumbing, not "no credentials" -- keep the
        // previous connected state so one blip can't flip a working account to
        // disconnected (persisted false blocks rehydrate on the next launch).
        return false;
      }
    },

    connectAllUsage: async () => {
      // Enable agy push-tracking (installs the status-line helper for agy sessions) so agy
      // accounts populate once a session runs.
      if (!get().agyUsageTracking) await get().setAgyUsageTracking(true);
      // Make sure the Claude account list is populated before we iterate it (it may be empty
      // if the poll hasn't run yet), then connect every account's plan usage.
      await get().refreshClaudeUsage();
      for (const t of get().claudeUsage) {
        // eslint-disable-next-line no-await-in-loop
        await get().connectPlanUsage(t.accountId);
      }
    },

    // agy usage arrives pushed from Rust (the status-line helper POSTs on each agy state
    // change); this setter is called by App's "agyusage" event listener. Keyed by account.
    setAgyUsage: (u) =>
      set((s) => ({
        agyUsageByAccount: { ...s.agyUsageByAccount, [accountKey(u.accountId)]: u },
      })),

    refreshAgyUsage: async () => {
      try {
        const list = await invoke<AgyUsage[]>("fetch_agy_usage");
        const next: Record<string, AgyUsage> = {};
        for (const u of list) next[accountKey(u.accountId)] = u;
        set({ agyUsageByAccount: next });
      } catch { /* fail-open: keep last-known */ }
    },

    setUsagePrefs: (patch) =>
      set((s) => {
        const next = {
          ...s.usagePrefs,
          ...patch,
          windows: { ...s.usagePrefs.windows, ...(patch.windows ?? {}) },
        };
        writeUsagePrefs(next);
        return { usagePrefs: next };
      }),

    refreshAgyUsageTracking: async () => {
      try {
        const on = await invoke<boolean>("agy_usage_tracking_enabled");
        set({ agyUsageTracking: on });
      } catch { /* leave as-is */ }
    },

    setAgyUsageTracking: async (enabled) => {
      try {
        await invoke<boolean>("set_agy_usage_tracking", { enabled });
        set({ agyUsageTracking: enabled });
        return true;
      } catch {
        // Refresh from disk so the toggle reflects reality (e.g. a foreign statusLine
        // blocked the write).
        await get().refreshAgyUsageTracking();
        return false;
      }
    },

    applySystemDark: (dark) => {
      if (get().themePref !== "auto") return;
      const id = resolveThemeId("auto", dark);
      applyTheme(id);
      set({ activeThemeId: id });
    },

    // ---- Task board (Conductor board) ----
    centerMode: {},
    boards: {},
    continuity: {},
    setCenterMode: (projectId, mode) =>
      set((s) => ({ centerMode: { ...s.centerMode, [projectId]: mode } })),
    toggleCenterMode: (projectId) =>
      set((s) => {
        const cur = s.centerMode[projectId] ?? "terminals";
        return { centerMode: { ...s.centerMode, [projectId]: cur === "board" ? "terminals" : "board" } };
      }),
    setBoard: (projectId, snapshot) =>
      set((s) => ({ boards: { ...s.boards, [projectId]: snapshot } })),
    setContinuity: (projectId, view) =>
      set((s) => ({ continuity: { ...s.continuity, [projectId]: view } })),
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

/** Last path component of a path. Splits on both `/` and `\` so Windows-native
 *  paths (which the Rust side emits via `Path::join`, e.g. worktree paths) resolve
 *  correctly — otherwise the whole backslash path is returned as one segment. */
export function baseName(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/** Parent directory of an absolute path (no trailing separator). Handles both `/`
 *  and `\` separators. POSIX root stays "/". */
export function parentDir(path: string): string {
  const p = path.replace(/[/\\]+$/, "");
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i < 0) return p;
  return i === 0 ? "/" : p.slice(0, i);
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
