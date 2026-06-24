/**
 * BridgeClient — a thin wrapper over a WebSocket speaking the Conduit mobile bridge
 * protocol. The bridge is desktop-authoritative on sizing: this client ADOPTS the
 * `size` the bridge sends after attach and never sends a `resize`.
 */

/** Decode a base64 string of raw PTY bytes into a Uint8Array. */
export function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

type ServerMsg =
  | { type: 'sessions'; sessions: string[] }
  | { type: 'size'; cols: number; rows: number }
  | { type: 'output'; data: string }
  | { type: 'error'; message: string };

export class BridgeClient {
  private ws: WebSocket | null = null;

  // Callbacks the UI assigns. Defaulted to no-ops so the parser is always safe to call.
  onSessions: (ids: string[]) => void = () => {};
  onSize: (cols: number, rows: number) => void = () => {};
  onOutput: (bytes: Uint8Array) => void = () => {};
  onError: (msg: string) => void = () => {};
  onOpen: () => void = () => {};
  onClose: () => void = () => {};

  constructor(private readonly url: string) {}

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => this.onOpen();
    ws.onclose = () => this.onClose();
    ws.onerror = () => this.onError('connection error');
    ws.onmessage = (ev) => this.handleMessage(ev.data);
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw) as ServerMsg;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'sessions':
        this.onSessions(msg.sessions ?? []);
        break;
      case 'size':
        this.onSize(msg.cols, msg.rows);
        break;
      case 'output':
        this.onOutput(b64ToBytes(msg.data));
        break;
      case 'error':
        this.onError(msg.message);
        break;
    }
  }

  private send(obj: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  list(): void {
    this.send({ type: 'list' });
  }

  attach(sessionId: string): void {
    this.send({ type: 'attach', session_id: sessionId });
  }

  /** `data` is a RAW keystroke string (e.g. "ls\r", "\x1b"), NOT base64. */
  sendInput(sessionId: string, data: string): void {
    this.send({ type: 'input', session_id: sessionId, data });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
