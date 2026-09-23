import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "../store";

/**
 * Cross-window convergence for Rust's `store-saved` broadcast (Task 5: emitted after every
 * persisted store write, carrying a generation counter no consumer here needs).
 *
 * This is a PLAIN `listen`, not a window-scoped one like the menu/cli-open events elsewhere
 * in the app (those go through `emit_to` to one target window; this one is a true broadcast,
 * and every window must react). The originator refetches its own write too — there is no
 * originator filtering — which is harmless because the merge (`mergeSyncedSlices` ->
 * `mergeSlices` in storeSync.ts) is idempotent.
 *
 * Debounced 300ms: a burst of writes (several session mutations in quick succession) should
 * cost one slice refetch, not one per write.
 */
export function useStoreSync(): void {
  useEffect(() => {
    let timer: number | undefined;
    const un = listen("store-saved", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void useStore.getState().mergeSyncedSlices(), 300);
    });
    return () => {
      window.clearTimeout(timer);
      void un.then((f) => f());
    };
  }, []);
}
