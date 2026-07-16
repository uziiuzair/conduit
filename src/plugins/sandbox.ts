import { WORKER_BOOTSTRAP } from "./worker-runtime";

/** Messages the host receives from a worker. */
export type FromWorker =
  | { type: "request"; rid: number; method: string; params: unknown }
  | { type: "ready" }
  | { type: "error"; message: string }
  | { type: "pong" };

/** Messages the host sends to a worker. */
export type ToWorker =
  | { type: "load"; source: string }
  | { type: "event"; event: string; payload: unknown }
  | { type: "response"; rid: number; ok: boolean; value?: unknown; error?: string }
  | { type: "unload" }
  | { type: "ping" };

/** A swappable sandbox runtime. WorkerSandbox is the only impl in increment #1;
 *  a QuickJS impl could satisfy the same interface later. */
export interface SandboxHost {
  start(source: string, onMessage: (m: FromWorker) => void): void;
  send(m: ToWorker): void;
  terminate(): void;
}

export class WorkerSandbox implements SandboxHost {
  private worker: Worker | null = null;
  private url: string | null = null;

  start(source: string, onMessage: (m: FromWorker) => void): void {
    const blob = new Blob([WORKER_BOOTSTRAP], { type: "text/javascript" });
    this.url = URL.createObjectURL(blob);
    this.worker = new Worker(this.url, { type: "module" });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => onMessage(e.data);
    this.worker.onerror = (e) => onMessage({ type: "error", message: e.message });
    this.send({ type: "load", source });
  }

  send(m: ToWorker): void {
    this.worker?.postMessage(m);
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
  }
}
