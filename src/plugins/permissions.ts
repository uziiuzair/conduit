import type { PluginPermission } from "./types";

interface PermissionInfo {
  label: string;
  riskLine: string;
  /** host.request methods this permission unlocks */
  methods: string[];
  /** plugin-facing event ids this permission delivers */
  events: string[];
}

export const PERMISSIONS: Record<PluginPermission, PermissionInfo> = {
  commands: {
    label: "Add commands to the palette and bind hotkeys",
    riskLine: "Can add commands and intercept keyboard shortcuts you press.",
    methods: ["commands.register", "commands.unregister"],
    events: [],
  },
  "hooks:session": {
    label: "See when sessions start, stop, or are renamed",
    riskLine: "Can observe which sessions you open and close, and their titles.",
    methods: [],
    events: ["session.start", "session.stop", "session.rename"],
  },
  "hooks:fleet": {
    label: "See fleet / Conductor spawn events",
    riskLine: "Can observe orchestration activity across your projects.",
    methods: [],
    events: ["fleet.spawn"],
  },
  "hooks:lifecycle": {
    label: "See agent activity signals",
    riskLine: "Can observe agent stop/notification and session start/end signals (no transcript contents).",
    methods: [],
    events: ["lifecycle.stop", "lifecycle.notification", "lifecycle.sessionstart", "lifecycle.sessionend"],
  },
  notifications: {
    label: "Show desktop notifications",
    riskLine: "Can pop system notifications (possible nuisance or spoofing).",
    methods: ["notify"],
    events: [],
  },
  "clipboard:write": {
    label: "Write to the clipboard",
    riskLine: "Can replace your clipboard contents.",
    methods: ["clipboard.write"],
    events: [],
  },
  net: {
    label: "Make network requests to declared hosts",
    riskLine: "Can send data to the internet — only to hosts listed in the manifest.",
    methods: ["net.fetch"],
    events: [],
  },
};

const METHOD_TO_PERM = new Map<string, PluginPermission>();
const EVENT_TO_PERM = new Map<string, PluginPermission>();
for (const [perm, info] of Object.entries(PERMISSIONS) as [PluginPermission, PermissionInfo][]) {
  for (const m of info.methods) METHOD_TO_PERM.set(m, perm);
  for (const e of info.events) EVENT_TO_PERM.set(e, perm);
}

export function permissionForMethod(method: string): PluginPermission | null {
  return METHOD_TO_PERM.get(method) ?? null;
}
export function permissionForEvent(event: string): PluginPermission | null {
  return EVENT_TO_PERM.get(event) ?? null;
}
export function describe(perm: PluginPermission): PermissionInfo {
  return PERMISSIONS[perm];
}
export const ALL_EVENTS = [...EVENT_TO_PERM.keys()];
