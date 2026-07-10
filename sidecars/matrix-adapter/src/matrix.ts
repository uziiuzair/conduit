// Matrix client bootstrap — same stack as badgerclaw-plugin so the bot behaves
// exactly like a first-class BadgerClaw bot: Element's matrix-bot-sdk fork with the
// rust-sdk (vodozemac) crypto store. E2EE is always on; the crypto store and
// device_id persist under ~/.conduit/matrix-adapter/ and must never be wiped
// casually (phones pin the bot's identity — a reset shows violation banners).

import path from "node:path";
import fs from "node:fs";
import {
  AutojoinRoomsMixin,
  MatrixClient,
  RustSdkCryptoStorageProvider,
  SimpleFsStorageProvider,
} from "@vector-im/matrix-bot-sdk";
import { StoreType } from "@matrix-org/matrix-sdk-crypto-nodejs";
import { ensureDataDir, type Credentials } from "./config.js";

export async function createMatrixClient(creds: Credentials): Promise<MatrixClient> {
  const dir = ensureDataDir();
  const storageDir = path.join(dir, "storage");
  const cryptoDir = path.join(dir, "crypto");
  fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cryptoDir, { recursive: true, mode: 0o700 });

  const storage = new SimpleFsStorageProvider(path.join(storageDir, "bot.json"));
  const crypto = new RustSdkCryptoStorageProvider(cryptoDir, StoreType.Sqlite);
  const client = new MatrixClient(creds.homeserver, creds.accessToken, storage, crypto);
  AutojoinRoomsMixin.setupOnClient(client);

  // Prepare the crypto machinery before syncing (plugin does the same).
  await client.crypto?.prepare();
  return client;
}

/** Send with a msgtype, plain body. */
export async function sendMessage(
  client: MatrixClient,
  roomId: string,
  msgtype: "m.text" | "m.notice",
  body: string,
): Promise<void> {
  await client.sendMessage(roomId, { msgtype, body });
}
