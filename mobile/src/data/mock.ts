import type { ChatItem, Project } from "./types";

/**
 * Mock data backing the front-end shell. Shapes match what the bridge will
 * eventually stream (transcript -> chat items, hooks -> status). Swapping this
 * for a live BridgeClient is the P2 milestone.
 */

export const PROJECTS: Project[] = [
  {
    id: "conduit",
    name: "Conduit",
    path: "~/ooozzy/Conduit",
    agents: [
      {
        id: "auth-agent",
        name: "auth-agent",
        branch: "feat/login-limit",
        kind: "claude",
        status: "needsInput",
        attention: "approval · Bash: rm -rf node_modules",
        pendingApproval: { id: "ap-auth-1", tool: "Bash", input: "rm -rf node_modules && npm i" },
      },
      {
        id: "telemetry-fix",
        name: "telemetry-fix",
        branch: "feat/telemetry",
        kind: "claude",
        status: "running",
        activity: "Editing src/store.ts",
        todos: { done: 2, total: 4 },
      },
      {
        id: "docs-pass",
        name: "docs-pass",
        branch: "main",
        kind: "gemini",
        status: "done",
        doneAgo: "3m ago",
      },
    ],
  },
  {
    id: "acme-saas",
    name: "acme-saas",
    path: "~/work/acme-saas",
    agents: [
      {
        id: "api-agent",
        name: "api-agent",
        branch: "feat/billing",
        kind: "codex",
        status: "needsInput",
        attention: "waiting · your reply",
      },
      {
        id: "ui-agent",
        name: "ui-agent",
        branch: "feat/settings",
        kind: "claude",
        status: "idle",
      },
    ],
  },
];

/** Per-agent chat feed (transcript content + inline status events). */
export const CHATS: Record<string, ChatItem[]> = {
  "auth-agent": [
    { kind: "bubble", id: "u1", role: "user", text: "add rate limiting to the login endpoint" },
    { kind: "bubble", id: "a1", role: "assistant", text: "On it — let me check the current auth code first." },
    { kind: "event", id: "e1", event: "read", label: "read", mono: "src/auth/login.ts" },
    { kind: "event", id: "e2", event: "bash", label: "ran", mono: "npm test", ok: "✓ 12" },
    {
      kind: "todos",
      id: "t1",
      done: 1,
      total: 3,
      items: [
        { text: "inspect login endpoint", status: "completed" },
        { text: "add limiter middleware", status: "in_progress" },
        { text: "write a test", status: "pending" },
      ],
    },
    { kind: "approval", id: "ap-auth-1", tool: "Bash", input: "rm -rf node_modules && npm i" },
  ],
  "telemetry-fix": [
    { kind: "bubble", id: "u1", role: "user", text: "wire the telemetry heartbeat into the store" },
    { kind: "bubble", id: "a1", role: "assistant", text: "Sure — updating the Zustand slice and the ambient hook." },
    { kind: "event", id: "e1", event: "read", label: "read", mono: "src/store.ts" },
    { kind: "event", id: "e2", event: "edit", label: "edited", mono: "src/store.ts" },
    {
      kind: "todos",
      id: "t1",
      done: 2,
      total: 4,
      items: [
        { text: "add heartbeat field", status: "completed" },
        { text: "emit on interval", status: "completed" },
        { text: "wire ambient hook", status: "in_progress" },
        { text: "scrub PII", status: "pending" },
      ],
    },
  ],
  "docs-pass": [
    { kind: "bubble", id: "u1", role: "user", text: "tidy the README setup section" },
    { kind: "bubble", id: "a1", role: "assistant", text: "Done — clarified the data-dir override and the three version files." },
    { kind: "event", id: "e1", event: "edit", label: "edited", mono: "README.md" },
  ],
  "api-agent": [
    { kind: "bubble", id: "u1", role: "user", text: "scaffold the Stripe billing webhook" },
    { kind: "bubble", id: "a1", role: "assistant", text: "I drafted the handler. Which events should I subscribe to — just invoice.paid, or the full lifecycle?" },
  ],
  "ui-agent": [
    { kind: "bubble", id: "u1", role: "user", text: "build the settings page shell" },
    { kind: "bubble", id: "a1", role: "assistant", text: "Settings shell is in. Idle — tell me what to wire next." },
    { kind: "event", id: "e1", event: "edit", label: "edited", mono: "src/SettingsPage.tsx" },
  ],
};
