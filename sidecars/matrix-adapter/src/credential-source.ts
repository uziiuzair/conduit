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

export class GenericMatrixProvider implements MatrixCredentialSource {
  readonly provider = "matrix" as const;
  constructor(private readonly input: MatrixSession) {}
  async acquire(): Promise<Credentials> {
    validateMatrixSession(this.input);
    return {
      homeserver: this.input.homeserver,
      userId: this.input.userId,
      accessToken: this.input.accessToken,
      deviceId: this.input.deviceId,
      botName: this.input.botName ?? null,
      botId: this.input.botId ?? null,
    };
  }
}

export class BadgerClawProvider implements MatrixCredentialSource {
  readonly provider = "badgerclaw" as const;
  /** `mint` is `() => refreshMatrixToken(account, bot, deviceId)` or the redeem flow,
   *  bound by the caller in index.ts — keeps network out of this unit. */
  constructor(private readonly mint: () => Promise<Credentials>) {}
  acquire(): Promise<Credentials> {
    return this.mint();
  }
}
