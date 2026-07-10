// The one badgerclaw-api call the adapter makes: redeem a pair code minted in the
// iOS app. Unauthenticated by design (the code IS the credential, ~60s validity);
// returns a ready-to-use Matrix session for the bot. Mirrors what the host CLI's
// `badgerclaw pair <code>` does.

import type { Credentials } from "./config.js";

export const DEFAULT_API_BASE = "https://api.badger.signout.io";

interface RedeemResponse {
  homeserver: string;
  access_token: string;
  user_id: string;
  bot_name?: string | null;
  device_id?: string | null;
  bot_id?: string | null;
  runtime?: string | null;
}

export async function redeemPairCode(
  code: string,
  apiBase = DEFAULT_API_BASE,
): Promise<Credentials> {
  const resp = await fetch(`${apiBase.replace(/\/$/, "")}/api/v1/pairing/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.trim() }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(
      `pairing redeem failed (${resp.status}): ${detail.slice(0, 300) || resp.statusText}`,
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
