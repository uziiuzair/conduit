export type PluginPermission =
  | "commands"
  | "hooks:session"
  | "hooks:fleet"
  | "hooks:lifecycle"
  | "notifications"
  | "clipboard:write"
  | "net";

export interface CommandContribution { id: string; title: string; hotkey?: string; }
export interface Contributes { commands?: CommandContribution[]; hooks?: string[]; }

export interface PluginManifest {
  id: string; name: string; version: string;
  author?: string; description?: string;
  minAppVersion: string; main?: string;
  permissions?: PluginPermission[];
  contributes?: Contributes;
}

export interface PluginRecord {
  id: string; enabled: boolean;
  grantedPermissions: PluginPermission[];
  consentedVersion: string;
}

export interface PluginDescriptor {
  id: string; path: string;
  manifest: PluginManifest | null;
  problems: string[];
  record: PluginRecord | null;
}

export type PluginRuntimeStatus =
  | "disabled" | "running" | "errored" | "incompatible" | "needs-consent";
