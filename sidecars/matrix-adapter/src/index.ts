#!/usr/bin/env node
// conduit-matrix — CLI entry.
//   pair BCK-XXXX-XXXX --owner @you:badger.signout.io   redeem + save credentials
//   run                                                 start the relay
// See docs/superpowers/specs/2026-07-10-conduit-matrix-adapter-design.md.

import { DEFAULT_API_BASE, redeemPairCode } from "./badgerclaw.js";
import {
  loadCredentials,
  loadSettings,
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
      "  conduit-matrix pair <BCK-code> --owner <@user:server> [--api <base-url>]",
      "      Redeem a pair code minted in BadgerClaw (Bot Management → Pair) and",
      "      allowlist the owner mxid. Credentials land in ~/.conduit/matrix-adapter/.",
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
  const owner = argValue(args, "--owner");
  const api = argValue(args, "--api") ?? DEFAULT_API_BASE;
  if (!code || !owner || !owner.startsWith("@")) usage();

  const creds = await redeemPairCode(code, api);
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
const main = cmd === "pair" ? pair(rest) : cmd === "run" ? run() : Promise.resolve(usage());
main.catch((e) => {
  console.error(`conduit-matrix: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
