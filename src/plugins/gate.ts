import type { PluginPermission } from "./types";
import { permissionForMethod, permissionForEvent } from "./permissions";

/** True iff `method` is known AND its required permission is in `grants`. Deny-by-default. */
export function checkGrant(grants: PluginPermission[], method: string): boolean {
  const need = permissionForMethod(method);
  return need !== null && grants.includes(need);
}

/** True iff `event` is known AND its required permission is in `grants`. */
export function checkEventGrant(grants: PluginPermission[], event: string): boolean {
  const need = permissionForEvent(event);
  return need !== null && grants.includes(need);
}
