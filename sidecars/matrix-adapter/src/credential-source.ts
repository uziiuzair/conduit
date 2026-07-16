import type { Credentials } from "./config.js";

/** A Matrix session, provider-agnostic. Superset-compatible with `Credentials`. */
export interface MatrixSession {
  homeserver: string;
  userId: string;
  accessToken: string;
  deviceId: string | null;
  botName?: string | null;
  botId?: string | null;
}

export function validateMatrixSession(s: MatrixSession): void {
  if (!/^https:\/\//i.test(s.homeserver)) throw new Error("homeserver must be an https URL");
  if (!s.userId.startsWith("@")) throw new Error("user id must look like @name:server");
  if (!s.accessToken) throw new Error("access token is required");
}

/** Anything that can produce a Matrix session for the relay. `acquire` may hit the
 *  network (BadgerClaw) or just validate injected input (generic). */
export interface MatrixCredentialSource {
  readonly provider: "badgerclaw" | "matrix";
  acquire(): Promise<Credentials>;
}
