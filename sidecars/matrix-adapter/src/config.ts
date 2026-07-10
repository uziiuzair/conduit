// Adapter state on disk: ~/.conduit/matrix-adapter/
//   credentials.json  (0600) — Matrix session from the pair-code redeem
//   settings.json     (0600) — owners allowlist + room→session bindings
//   storage/, crypto/         — matrix-bot-sdk state + rust-sdk crypto store
// The crypto store and device_id must survive forever: BadgerClaw phones pin the
// bot's cross-signing identity (TOFU) and show violation banners if it resets.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Credentials {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId: string | null;
  botName: string | null;
  botId: string | null;
}

/** BadgerClaw ACCOUNT session (from `login`), distinct from the bot's Matrix
 *  session above. Holds the registered instance id that `redeem` now requires. */
export interface Account {
  /** Account access token (Bearer) — used only to register the instance. */
  accessToken: string;
  /** The account's own Matrix user id (the default bot owner). */
  userId: string;
  /** Canonical instance id the backend returned from /openclaw/register. */
  instanceId: string;
}

export interface Settings {
  /** Matrix user ids allowed to command the bot / type into sessions. */
  owners: string[];
  /** roomId -> Conduit session id (persisted bindings). */
  rooms: Record<string, string>;
}

export function dataDir(): string {
  return path.join(os.homedir(), ".conduit", "matrix-adapter");
}

export function ensureDataDir(): string {
  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const credsPath = () => path.join(dataDir(), "credentials.json");
const settingsPath = () => path.join(dataDir(), "settings.json");
const accountPath = () => path.join(dataDir(), "account.json");

function writeJson(file: string, value: unknown): void {
  ensureDataDir();
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export const saveCredentials = (c: Credentials): void => writeJson(credsPath(), c);
export const loadCredentials = (): Credentials | null => readJson<Credentials>(credsPath());

export function loadSettings(): Settings {
  return readJson<Settings>(settingsPath()) ?? { owners: [], rooms: {} };
}
export const saveSettings = (s: Settings): void => writeJson(settingsPath(), s);

export const saveAccount = (a: Account): void => writeJson(accountPath(), a);
export const loadAccount = (): Account | null => readJson<Account>(accountPath());
