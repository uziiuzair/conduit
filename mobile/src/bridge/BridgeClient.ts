import type { ClientMsg, ServerMsg } from "./protocol";

export type ConnState = "connecting" | "open" | "closed";

interface Handlers {
  onMessage: (m: ServerMsg) => void;
  onState?: (s: ConnState) => void;
}

/**
 * Thin typed WebSocket wrapper for the bridge, with auto-reconnect (exponential
 * backoff, capped). Uses React Native's global WebSocket. The desktop is the
 * source of truth, so on reconnect the caller re-issues `list`/`attach`.
 */
export class BridgeClient {
  private ws: WebSocket | null = null;
  private closedByUser = false;
  private backoff = 500;

  constructor(
    private readonly url: string,
    private readonly handlers: Handlers,
    private readonly token?: string,
  ) {
    this.connect();
  }

  private connect() {
    this.handlers.onState?.("connecting");
    // Append the dev shared token as a query param when set; the desktop bridge
    // (CONDUIT_BRIDGE_TOKEN) rejects the handshake without it. No token => loopback.
    const target = this.token
      ? `${this.url}${this.url.includes("?") ? "&" : "?"}token=${encodeURIComponent(this.token)}`
      : this.url;
    const ws = new WebSocket(target);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.handlers.onState?.("open");
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      try {
        this.handlers.onMessage(JSON.parse(e.data) as ServerMsg);
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      this.handlers.onState?.("closed");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose fires next; reconnect handled there */
    };
  }

  private scheduleReconnect() {
    if (this.closedByUser) return;
    const wait = Math.min(this.backoff, 8000);
    this.backoff = Math.min(this.backoff * 2, 8000);
    setTimeout(() => {
      if (!this.closedByUser) this.connect();
    }, wait);
  }

  private send(msg: ClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  list() {
    this.send({ type: "list" });
  }

  attach(sessionId: string) {
    this.send({ type: "attach", session_id: sessionId });
  }

  /** Send a prompt: type the text + Enter into the live PTY (same as desktop typing). */
  prompt(sessionId: string, text: string) {
    this.send({ type: "input", session_id: sessionId, data: text + "\r" });
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }
}
