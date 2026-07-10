// BadgerClaw backend calls. Two flows:
//   login()  — PKCE browser auth + register THIS machine as an instance. The
//              backend requires a registered instance_id on redeem (as of
//              2026-04-22), so a Conduit host must register just like a real
//              `badgerclaw login` host would. We deliberately do NOT install
//              BadgerClaw's gateway/plugin daemon — the Conduit adapter is the
//              only thing that will run this bot.
//   redeem() — exchange a pair code (+ instance_id) for the bot's Matrix session.
//
// Endpoints and payloads mirror badgerclaw-cli (commands/login.ts, lib/instance.ts,
// commands/autopair.ts). No secrets are read from disk here.

import crypto from "node:crypto";
import os from "node:os";
import { spawn } from "node:child_process";
import type { Account, Credentials } from "./config.js";

export const DEFAULT_API_BASE =
  process.env.BADGERCLAW_API_URL ?? "https://api.badger.signout.io";
export const DEFAULT_AUTH_BASE =
  process.env.BADGERCLAW_AUTH_URL ?? "https://badgerclaw.ai";

const ADAPTER_VERSION = "0.1.0";
const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 120_000;

/** Deterministic per-machine fingerprint — sha256(host-platform-arch)[:16].
 *  Same formula as badgerclaw-cli/lib/instance.ts so the backend recognizes a
 *  machine already registered by the real CLI. */
function machineFingerprint(): string {
  return crypto
    .createHash("sha256")
    .update(`${os.hostname()}-${os.platform()}-${os.arch()}`)
    .digest("hex")
    .slice(0, 16);
}

function proposedInstanceId(): string {
  const fp = machineFingerprint();
  const host = os.hostname().toLowerCase().replace(/[^a-z0-9]/g, "-");
  return `openclaw-${host}-${fp}`;
}

const base64url = (b: Buffer) => b.toString("base64url");

function tryOpenBrowser(url: string): void {
  // Best-effort; the URL is also printed so the user can click it.
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  } catch {
    /* printed below regardless */
  }
}

interface PollResponse {
  access_token?: string;
  user_id?: string;
}

/**
 * Browser PKCE login, then register this machine as an instance. Returns the
 * account session (token + user id + canonical instance id) to persist.
 */
export async function login(
  apiBase = DEFAULT_API_BASE,
  authBase = DEFAULT_AUTH_BASE,
): Promise<Account> {
  const api = apiBase.replace(/\/$/, "");
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());

  const authUrl = `${authBase.replace(/\/$/, "")}/cli-auth?code=${challenge}`;
  console.log("Opening the browser to sign in to BadgerClaw…");
  console.log(`If it doesn't open, visit:\n  ${authUrl}\n`);
  tryOpenBrowser(authUrl);

  const started = Date.now();
  let session: { accessToken: string; userId: string } | null = null;
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let resp: Response;
    try {
      resp = await fetch(`${api}/api/v1/openclaw/cli/auth/poll/${challenge}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code_verifier: verifier, code_challenge: challenge }),
      });
    } catch {
      continue; // transient; keep polling until timeout
    }
    if (resp.status === 429) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (!resp.ok) continue; // still pending
    const data = (await resp.json().catch(() => ({}))) as PollResponse;
    if (data.access_token && data.user_id) {
      session = { accessToken: data.access_token, userId: data.user_id };
      break;
    }
  }
  if (!session) throw new Error("login timed out — no approval received in the browser");

  // Register this machine as an instance (adopt the server's canonical id).
  let instanceId = proposedInstanceId();
  const reg = await fetch(`${api}/api/v1/openclaw/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessToken}`,
    },
    body: JSON.stringify({
      instance_id: instanceId,
      label: os.hostname(),
      version: ADAPTER_VERSION,
      machine_fingerprint: machineFingerprint(),
    }),
  });
  if (!reg.ok) {
    const detail = await reg.text().catch(() => "");
    throw new Error(
      `instance registration failed (${reg.status}): ${firstError(detail) || reg.statusText}`,
    );
  }
  const regBody = (await reg.json().catch(() => ({}))) as {
    result?: { instance_id?: string };
    instance_id?: string;
  };
  instanceId = regBody.result?.instance_id ?? regBody.instance_id ?? instanceId;

  return { accessToken: session.accessToken, userId: session.userId, instanceId };
}

export interface BotSummary {
  id: string;
  botUserId: string;
  botName: string;
  botUsername: string;
  runtime: string;
  active: boolean;
}

/** List the account's bots (GET /api/v1/bots, account-authenticated). */
export async function listBots(
  account: Account,
  apiBase = DEFAULT_API_BASE,
): Promise<BotSummary[]> {
  const resp = await fetch(`${apiBase.replace(/\/$/, "")}/api/v1/bots`, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
  });
  if (resp.status === 401) throw new Error("account session expired — run `conduit-matrix login` again");
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`could not list bots (${resp.status}): ${firstError(detail) || resp.statusText}`);
  }
  const rows = (await resp.json()) as Array<{
    id: string;
    bot_user_id: string;
    bot_name: string;
    bot_username: string;
    runtime?: string;
    active: boolean;
  }>;
  return rows.map((r) => ({
    id: r.id,
    botUserId: r.bot_user_id,
    botName: r.bot_name,
    botUsername: r.bot_username,
    runtime: r.runtime ?? "openclaw",
    active: r.active,
  }));
}

/**
 * Mint a Matrix session for a bot directly — appservice login via the account,
 * no pair code / instance / redeem. `deviceId` is reused across refreshes so the
 * bot's E2EE keys survive (a new device would trip identity-pinning on the phone).
 */
export async function refreshMatrixToken(
  account: Account,
  bot: BotSummary,
  deviceId: string | null,
  apiBase = DEFAULT_API_BASE,
): Promise<Credentials> {
  const resp = await fetch(
    `${apiBase.replace(/\/$/, "")}/api/v1/bots/${bot.id}/refresh-matrix-token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${account.accessToken}`,
      },
      body: JSON.stringify(deviceId ? { device_id: deviceId } : {}),
    },
  );
  if (resp.status === 401) throw new Error("account session expired — run `conduit-matrix login` again");
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `could not get the bot's Matrix session (${resp.status}): ${firstError(detail) || resp.statusText}`,
    );
  }
  const r = (await resp.json()) as {
    access_token: string;
    device_id?: string | null;
    homeserver: string;
    user_id: string;
  };
  if (!r.access_token || !r.homeserver || !r.user_id) {
    throw new Error("refresh returned an incomplete Matrix session");
  }
  return {
    homeserver: r.homeserver,
    userId: r.user_id,
    accessToken: r.access_token,
    deviceId: r.device_id ?? deviceId,
    botName: bot.botName,
    botId: bot.id,
  };
}

interface RedeemResponse {
  homeserver: string;
  access_token: string;
  user_id: string;
  bot_name?: string | null;
  device_id?: string | null;
  bot_id?: string | null;
  runtime?: string | null;
}

/** Redeem a pair code for the bot's Matrix session. `instanceId` is required by
 *  the backend (this machine must be a registered instance — see login()). */
export async function redeemPairCode(
  code: string,
  instanceId: string,
  apiBase = DEFAULT_API_BASE,
): Promise<Credentials> {
  const resp = await fetch(`${apiBase.replace(/\/$/, "")}/api/v1/pairing/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.trim(), instance_id: instanceId }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `pairing redeem failed (${resp.status}): ${firstError(detail) || resp.statusText}`,
    );
  }
  const r = (await resp.json()) as RedeemResponse;
  if (!r.homeserver || !r.access_token || !r.user_id) {
    throw new Error("pairing redeem returned an incomplete session");
  }
  return {
    homeserver: r.homeserver,
    userId: r.user_id,
    accessToken: r.access_token,
    deviceId: r.device_id ?? null,
    botName: r.bot_name ?? null,
    botId: r.bot_id ?? null,
  };
}

/** Pull the human message out of BadgerClaw's `{result, errors:[...], stack}`
 *  envelope; fall back to the raw (truncated) body. */
function firstError(body: string): string | null {
  try {
    const j = JSON.parse(body) as { errors?: unknown; detail?: unknown };
    if (Array.isArray(j.errors) && typeof j.errors[0] === "string") return j.errors[0];
    if (typeof j.detail === "string") return j.detail;
  } catch {
    /* not JSON */
  }
  return body ? body.slice(0, 300) : null;
}
