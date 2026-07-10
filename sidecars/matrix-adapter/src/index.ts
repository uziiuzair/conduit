#!/usr/bin/env node
// conduit-matrix — CLI entry.
//   pair BCK-XXXX-XXXX --owner @you:badger.signout.io   redeem + save credentials
//   run                                                 start the relay
// See docs/superpowers/specs/2026-07-10-conduit-matrix-adapter-design.md.

import { DEFAULT_API_BASE, login as bcLogin, redeemPairCode } from "./badgerclaw.js";
import {
  loadAccount,
  loadCredentials,
  loadSettings,
  saveAccount,
  saveCredentials,
  saveSettings,
} from "./config.js";
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
      "  conduit-matrix pair <BCK-code> [--owner <@user:server>]",
      "      Redeem a pair code minted in BadgerClaw (Bot Management → Pair).",
      "      Owner defaults to your logged-in account; only owners can command the bot.",
      "",
      "  conduit-matrix run",
      "      Connect to Matrix and the local Conduit bridge, then relay.",
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

async function run(): Promise<void> {
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
  const client = await createMatrixClient(creds);
  const relay = new Relay(client, creds.userId);
  await relay.start();
  await client.start();
  console.log(`conduit-matrix: relaying as ${creds.userId}`);
}

const [, , cmd, ...rest] = process.argv;
const main =
  cmd === "login"
    ? login(rest)
    : cmd === "pair"
      ? pair(rest)
      : cmd === "run"
        ? run()
        : Promise.resolve(usage());
main.catch((e) => {
  console.error(`conduit-matrix: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
