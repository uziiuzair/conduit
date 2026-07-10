// Conduit bridge client. bridge.rs is one-attach-per-connection, so the adapter
// keeps one control connection (for `list`) plus one connection per bound session.
// Everything reconnects with backoff — Conduit quitting and relaunching is normal.

import WebSocket from "ws";
import {
  attachFrame,
  gitFrame,
  inputFrame,
  listFrame,
  parseServerFrame,
  type BridgeProject,
  type ChatItem,
  type GitResult,
  type ServerFrame,
} from "./protocol.js";

const PORT_RANGE_START = 8455;
const PORT_RANGE_END = 8475;
const PROBE_TIMEOUT_MS = 1200;
const RECONNECT_MS = 15_000;

/** Find the bridge: CONDUIT_BRIDGE_URL wins (LAN/token mode), else probe loopback
 *  ports until one actually ANSWERS `list` with a `projects` frame. A completed
 *  handshake alone is not proof — a stale/foreign Conduit instance (or any other
 *  websocket server squatting in the range) would otherwise win the probe and then
 *  time out on every real request. */
export async function discoverBridgeUrl(): Promise<string | null> {
  const override = process.env.CONDUIT_BRIDGE_URL?.trim();
  if (override) return override;
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    const url = `ws://127.0.0.1:${port}`;
    const ok = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(url, { handshakeTimeout: PROBE_TIMEOUT_MS });
      const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS * 2);
      const done = (v: boolean) => {
        clearTimeout(timer);
        try {
          ws.terminate();
        } catch {
          /* already dead */
        }
        resolve(v);
      };
      ws.once("open", () => ws.send(listFrame()));
      ws.once("error", () => done(false));
      ws.on("message", (raw) => {
        if (parseServerFrame(String(raw))?.type === "projects") done(true);
      });
    });
    if (ok) return url;
  }
  return null;
}

/** One-shot: fetch the project/session tree over a fresh connection. */
export function fetchProjects(url: string): Promise<BridgeProject[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: PROBE_TIMEOUT_MS });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("bridge list timed out"));
    }, 5000);
    ws.once("open", () => ws.send(listFrame()));
    ws.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    ws.on("message", (raw) => {
      const frame = parseServerFrame(String(raw));
      if (frame?.type === "projects") {
        clearTimeout(timer);
        ws.close();
        resolve(frame.projects);
      }
    });
  });
}

export interface SessionEvents {
  onChat(items: ChatItem[]): void;
  onStatus(event: string, body: unknown): void;
  onHistoryCount(n: number): void;
  /** Attach failed or connection dropped; the link will retry until closed. */
  onDown(reason: string): void;
  onUp(): void;
}

/**
 * A persistent attachment to one Conduit session. Chat items are micro-batched
 * (75ms) so a burst of transcript lines becomes one coalesced Matrix drain rather
 * than a message per line. `output` frames (raw PTY bytes) are discarded — the
 * transcript is the chat source of truth.
 */
export class SessionLink {
  private ws: WebSocket | null = null;
  private closed = false;
  private up = false;
  private pending: ChatItem[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  /** FIFO of resolvers waiting on a `gitresult` (git queries are user-driven and
   *  sequential per room, so first-in-first-out matching is sufficient). */
  private gitWaiters: ((r: GitResult | null) => void)[] = [];

  constructor(
    private url: string,
    readonly sessionId: string,
    private events: SessionEvents,
  ) {
    this.connect();
  }

  get isUp(): boolean {
    return this.up;
  }

  send(data: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(inputFrame(this.sessionId, data));
    return true;
  }

  /** Request a git query for this session's repo; resolves with the gitresult
   *  frame (or null on timeout / link down). */
  requestGit(action: string, path?: string, timeoutMs = 8000): Promise<GitResult | null> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: GitResult | null) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      this.gitWaiters.push(done);
      setTimeout(() => {
        // Drop this waiter if it's still pending (keeps the FIFO aligned).
        const i = this.gitWaiters.indexOf(done);
        if (i !== -1) this.gitWaiters.splice(i, 1);
        done(null);
      }, timeoutMs);
      this.ws!.send(gitFrame(this.sessionId, action, path));
    });
  }

  close(): void {
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.ws?.terminate();
    this.ws = null;
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.url, { handshakeTimeout: PROBE_TIMEOUT_MS });
    this.ws = ws;
    ws.once("open", () => ws.send(attachFrame(this.sessionId)));
    ws.on("message", (raw) => this.handle(parseServerFrame(String(raw))));
    const drop = (why: string) => {
      if (this.closed) return;
      const wasUp = this.up;
      this.up = false;
      this.ws = null;
      if (wasUp) this.events.onDown(why);
      setTimeout(() => this.connect(), RECONNECT_MS);
    };
    ws.once("close", () => drop("bridge connection closed"));
    ws.once("error", (e) => {
      ws.terminate();
      drop(String(e));
    });
  }

  private handle(frame: ServerFrame | null): void {
    if (!frame) return;
    switch (frame.type) {
      case "size":
        // First frame after a successful attach — the link is live.
        if (!this.up) {
          this.up = true;
          this.events.onUp();
        }
        break;
      case "history":
        this.up = true;
        this.events.onHistoryCount(frame.items.length);
        break;
      case "chat":
        this.pending.push(frame.item);
        if (!this.flushTimer) {
          this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            const batch = this.pending;
            this.pending = [];
            if (batch.length > 0) this.events.onChat(batch);
          }, 75);
        }
        break;
      case "status":
        this.events.onStatus(frame.event, frame.body);
        break;
      case "error":
        this.events.onDown(frame.message);
        break;
      case "gitresult": {
        const waiter = this.gitWaiters.shift();
        if (waiter) waiter(frame);
        break;
      }
      case "output":
      case "projects":
        break; // PTY bytes / unsolicited lists: not chat material
    }
  }
}
