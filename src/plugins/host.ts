import { invoke } from "@tauri-apps/api/core";
import { WorkerSandbox, type SandboxHost, type FromWorker } from "./sandbox";
import { checkGrant, checkEventGrant } from "./gate";
import type { PluginDescriptor, PluginPermission } from "./types";

interface Loaded {
  id: string;
  grants: PluginPermission[];
  sandbox: SandboxHost;
  hookEvents: Set<string>; // plugin-facing events it subscribed via manifest
}

class PluginHostImpl {
  private loaded = new Map<string, Loaded>();

  /** Start an enabled, consented plugin: spawn its worker, wire the dispatcher. */
  async start(desc: PluginDescriptor): Promise<void> {
    if (!desc.manifest || desc.problems.length || !desc.record?.enabled) return;
    if (this.loaded.has(desc.id)) return;
    const grants = (desc.record.grantedPermissions ?? []) as PluginPermission[];
    const source = await invoke<string>("read_plugin_source", { id: desc.id });
    const sandbox = new WorkerSandbox();
    const hookEvents = new Set(desc.manifest.contributes?.hooks ?? []);
    const entry: Loaded = { id: desc.id, grants, sandbox, hookEvents };
    this.loaded.set(desc.id, entry);
    sandbox.start(source, (m) => this.onMessage(entry, m));
  }

  stop(id: string): void {
    const e = this.loaded.get(id);
    if (!e) return;
    e.sandbox.send({ type: "unload" });
    e.sandbox.terminate();
    this.loaded.delete(id);
  }

  stopAll(): void {
    for (const id of [...this.loaded.keys()]) this.stop(id);
  }

  /** Fan a sanitized event to every plugin that (a) declared the event AND
   *  (b) was granted its permission. */
  emit(pluginEvent: string, payload: unknown): void {
    for (const e of this.loaded.values()) {
      if (!e.hookEvents.has(pluginEvent)) continue;
      if (!checkEventGrant(e.grants, pluginEvent)) continue;
      e.sandbox.send({ type: "event", event: pluginEvent, payload });
    }
  }

  private async onMessage(e: Loaded, m: FromWorker): Promise<void> {
    if (m.type === "request") {
      const ok = checkGrant(e.grants, m.method);
      if (!ok) {
        e.sandbox.send({ type: "response", rid: m.rid, ok: false, error: `permission denied: ${m.method}` });
        return;
      }
      try {
        const value = await this.forward(m.method, m.params);
        e.sandbox.send({ type: "response", rid: m.rid, ok: true, value });
      } catch (err) {
        e.sandbox.send({ type: "response", rid: m.rid, ok: false, error: String(err) });
      }
    } else if (m.type === "error") {
      console.error(`[plugin ${e.id}]`, m.message);
    }
  }

  /** Map a granted host method to a real app action. Only methods reachable in Plan 1. */
  private async forward(method: string, params: any): Promise<unknown> {
    switch (method) {
      case "notify":
        await invoke("notify_user", { title: params?.title ?? "", subtitle: null, body: params?.body ?? "" });
        return null;
      case "commands.register":
      case "commands.unregister":
        return null; // registry wired in Plan 2
      default:
        throw new Error(`method not available: ${method}`);
    }
  }
}

export const pluginHost = new PluginHostImpl();
