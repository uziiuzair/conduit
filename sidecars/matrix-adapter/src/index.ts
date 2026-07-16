#!/usr/bin/env node
// conduit-matrix — CLI entry.
//   pair BCK-XXXX-XXXX --owner @you:badger.signout.io   redeem + save credentials
//   run                                                 start the relay
// See docs/superpowers/specs/2026-07-10-conduit-matrix-adapter-design.md.

import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_API_BASE,
  listBots,
  login as bcLogin,
  redeemPairCode,
  refreshMatrixToken,
  type BotSummary,
} from "./badgerclaw.js";
import {
  ensureDataDir,
  loadAccount,
  loadCredentials,
  loadSettings,
  saveAccount,
  saveCredentials,
  saveSettings,
} from "./config.js";
import { GenericMatrixProvider, BadgerClawProvider, type MatrixCredentialSource } from "./credential-source.js";
import { createMatrixClient } from "./matrix.js";
import { Relay } from "./relay.js";

function usage(): never {
  console.log(
    [
      "conduit-matrix — chat with Conduit sessions from the BadgerClaw app",
      "",
      "  conduit-matrix login",
      "      Sign in to BadgerClaw in the browser and register THIS Mac as a host.",
      "      Required once before pairing (the backend needs a registered instance).",
      "",
      "  conduit-matrix connect [bot-name] [--owner <@user:server>]",
      "      Attach to one of YOUR bots directly (no pair code needed). Lists your",
      "      bots if the name is omitted or ambiguous. This is the recommended path.",
      "",
      "  conduit-matrix pair <BCK-code> [--owner <@user:server>]",
      "      Alternative: redeem a pair code (Bot Management → Pair). Needs the",
      "      BadgerClaw host-pairing backend; use `connect` if pairing errors.",
      "",
      "  conduit-matrix run",
      "      Connect to Matrix and the local Conduit bridge, then relay.",
      "",
      "  conduit-matrix matrix-login --homeserver <https-url> --user <@you:server> --token <access-token>",
      "      Use an existing Matrix account/session directly, without BadgerClaw.",
      "",
      "  In a room with the bot: /conduit list · /conduit use <n> · /conduit detach",
    ].join("\n"),
  );
  process.exit(2);
}

function argValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
}

async function login(args: string[]): Promise<void> {
  const api = argValue(args, "--api") ?? DEFAULT_API_BASE;
  const authBase = argValue(args, "--auth") ?? undefined;
  const account = await bcLogin(api, authBase);
  saveAccount(account);
  console.log(`\nlogged in as ${account.userId}`);
  console.log(`this Mac is registered as instance ${account.instanceId}`);
  console.log("next: conduit-matrix pair <BCK-code>");
}

function matchBot(bots: BotSummary[], q: string): BotSummary | null {
  const n = q.toLowerCase();
  return (
    bots.find((b) => b.id === q) ??
    bots.find((b) => b.botName.toLowerCase() === n) ??
    bots.find((b) => b.botUsername.toLowerCase() === n) ??
    bots.find((b) => b.botUserId.toLowerCase() === n) ??
    null
  );
}

function printBots(bots: BotSummary[]): void {
  for (const b of bots) {
    console.log(`  ${b.botName}  (${b.botUserId})  runtime=${b.runtime}${b.active ? "" : " [inactive]"}`);
  }
}

async function connect(args: string[]): Promise<void> {
  const api = argValue(args, "--api") ?? DEFAULT_API_BASE;
  const name = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--owner" && args[args.indexOf(a) - 1] !== "--api");

  const account = loadAccount();
  if (!account) {
    console.error("not logged in — run `conduit-matrix login` first.");
    process.exit(1);
  }

  const bots = await listBots(account, api);
  if (bots.length === 0) {
    console.error("no bots on your account — create one in the BadgerClaw app (Bot Management → New Bot, runtime OpenClaw).");
    process.exit(1);
  }

  let bot: BotSummary | null;
  if (name) {
    bot = matchBot(bots, name);
    if (!bot) {
      console.error(`no bot matches "${name}". Your bots:`);
      printBots(bots);
      process.exit(1);
    }
  } else if (bots.length === 1) {
    bot = bots[0];
  } else {
    console.error("multiple bots — pass the name: conduit-matrix connect <name>");
    printBots(bots);
    process.exit(1);
  }

  // Reuse the existing device id (if we've connected this bot before) so E2EE
  // keys survive — a new device trips identity-pin warnings on the phone.
  const prev = loadCredentials();
  const deviceId = prev && prev.botId === bot.id ? prev.deviceId : null;

  const creds = await refreshMatrixToken(account, bot, deviceId, api);
  saveCredentials(creds);

  const owner = argValue(args, "--owner") ?? account.userId;
  const settings = loadSettings();
  if (!settings.owners.includes(owner)) settings.owners.push(owner);
  saveSettings(settings);

  console.log(`connected ${creds.userId}${creds.botName ? ` (${creds.botName})` : ""}; owner allowlist: ${settings.owners.join(", ")}`);
  console.log("next: conduit-matrix run   (keep it running alongside Conduit)");
}

async function pair(args: string[]): Promise<void> {
  // Positional = the pair code; skip each --flag together with its value.
  let code: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      i += 1;
    } else {
      code = args[i];
      break;
    }
  }
  const api = argValue(args, "--api") ?? DEFAULT_API_BASE;
  if (!code) usage();

  const account = loadAccount();
  if (!account) {
    console.error("not logged in — run `conduit-matrix login` first (registers this Mac).");
    process.exit(1);
  }
  // Owner defaults to the logged-in account's own mxid; --owner overrides/adds.
  const owner = argValue(args, "--owner") ?? account.userId;
  if (!owner.startsWith("@")) {
    console.error(`--owner must be a Matrix id like @you:badger.signout.io (got ${owner})`);
    process.exit(1);
  }

  const creds = await redeemPairCode(code, account.instanceId, api);
  saveCredentials(creds);
  const settings = loadSettings();
  if (!settings.owners.includes(owner)) settings.owners.push(owner);
  saveSettings(settings);
  console.log(
    `paired as ${creds.userId}${creds.botName ? ` (${creds.botName})` : ""}; owner allowlist: ${settings.owners.join(", ")}`,
  );
  console.log("next: conduit-matrix run   (keep it running alongside Conduit)");
}

async function matrixLogin(args: string[]): Promise<void> {
  const homeserver = argValue(args, "--homeserver");
  const userId = argValue(args, "--user");
  const accessToken = argValue(args, "--token");
  if (!homeserver || !userId || !accessToken) {
    console.error("usage: conduit-matrix matrix-login --homeserver <https-url> --user <@you:server> --token <access-token>");
    process.exit(1);
  }
  const creds = await new GenericMatrixProvider({ homeserver, userId, accessToken, deviceId: null }).acquire();
  saveCredentials({ ...creds, provider: "matrix" });
  const settings = loadSettings();
  if (!settings.owners.includes(userId)) settings.owners.push(userId);
  saveSettings(settings);
  console.log(`saved generic Matrix session for ${userId}; run: conduit-matrix run`);
}

/** Refuse to start a SECOND relay: two processes share one rust-sdk crypto store,
 *  which corrupts E2EE Megolm state and leaves the phone unable to decrypt (messages
 *  stuck "loading"). A pidfile with a liveness check is the guard. */
function acquireSingletonLock(): void {
  const lock = path.join(ensureDataDir(), "relay.pid");
  try {
    const prev = Number(fs.readFileSync(lock, "utf8").trim());
    if (prev && prev !== process.pid) {
      try {
        process.kill(prev, 0); // throws if the pid is dead
        console.error(
          `another conduit-matrix relay is already running (pid ${prev}). ` +
            `Stop it first — two relays corrupt the E2EE crypto store. ` +
            `If you're sure it's dead, delete ${lock} and retry.`,
        );
        process.exit(1);
      } catch {
        /* stale pid — fall through and take the lock */
      }
    }
  } catch {
    /* no lockfile yet */
  }
  fs.writeFileSync(lock, String(process.pid), { mode: 0o600 });
  const release = () => {
    try {
      if (Number(fs.readFileSync(lock, "utf8").trim()) === process.pid) fs.unlinkSync(lock);
    } catch {
      /* already gone */
    }
  };
  process.on("exit", release);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}

async function run(): Promise<void> {
  acquireSingletonLock();
  const creds = loadCredentials();
  if (!creds) {
    console.error("no credentials — run `conduit-matrix pair <code> --owner <mxid>` first");
    process.exit(1);
  }
  const settings = loadSettings();
  if (settings.owners.length === 0) {
    console.error("no owners allowlisted — re-run pair with --owner <mxid>");
    process.exit(1);
  }
  const source: MatrixCredentialSource =
    creds.provider === "matrix"
      ? new GenericMatrixProvider(creds)
      : new BadgerClawProvider(async () => creds); // stored bot session; refresh handled in connect()
  const session = await source.acquire();
  const client = await createMatrixClient(session);
  const relay = new Relay(client, creds.userId);
  await relay.start();
  await client.start();
  console.log(`conduit-matrix: relaying as ${creds.userId}`);
}

const [, , cmd, ...rest] = process.argv;
const main =
  cmd === "login"
    ? login(rest)
    : cmd === "connect"
      ? connect(rest)
      : cmd === "pair"
        ? pair(rest)
        : cmd === "run"
          ? run()
          : cmd === "matrix-login"
            ? matrixLogin(rest)
            : Promise.resolve(usage());
main.catch((e) => {
  console.error(`conduit-matrix: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
