import { useStore } from "../store";
import { pluginHost } from "./host";
import { sanitizeHookPayload, sanitizeSession, type HookPayload } from "./events";

/** Discover + start enabled plugins. Call once on app mount. */
export async function initPlugins(): Promise<void> {
  await useStore.getState().refreshPlugins();
  for (const desc of useStore.getState().plugins) {
    if (desc.record?.enabled) await pluginHost.start(desc);
  }
}

/** Feed a relayed "hook" event into the plugin host as a lifecycle.* event. */
export function feedHook(p: HookPayload): void {
  const { event, session } = sanitizeHookPayload(p);
  pluginHost.emit(event, { session });
}

/** Feed a session lifecycle change. */
export function feedSession(event: "session.start" | "session.stop" | "session.rename", s: { id: string; title?: string }): void {
  pluginHost.emit(event, sanitizeSession(s));
}

/** Feed a fleet event. */
export function feedFleet(event: "fleet.spawn" | "fleet.stop", payload: { session?: string }): void {
  pluginHost.emit(event, { session: payload.session ?? "" });
}
