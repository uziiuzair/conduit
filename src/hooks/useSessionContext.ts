import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "../store";

/**
 * Keeps `sessionContext` fed for the open project's sessions.
 *
 * The number lives in each session's Claude transcript, which is a file on disk — so this
 * is a read, not a subscription, and the interesting question is only *when* to read.
 * Three moments cover it:
 *
 * - **On a turn ending** (`stop`): the point at which the fill actually changes, and the
 *   moment someone is most likely to look.
 * - **While a turn runs**, on a slow interval, so a long turn's meter creeps up instead of
 *   jumping at the end. Only for sessions that are actually `running` — an idle session's
 *   transcript cannot change under us.
 * - **Once when the project's sessions appear**, which is also what restores every meter
 *   after an app restart. Nothing is persisted precisely because this read is cheap and the
 *   file is the truth.
 */
const RUNNING_POLL_MS = 15_000;

export function useSessionContext(): void {
  const projects = useStore((s) => s.projects);
  const selectedProjectId = useStore((s) => s.selectedProjectId);

  // Session ids of the open project, as a stable string so the effects below re-run when
  // the membership changes rather than on every store write.
  const project = projects.find((p) => p.id === selectedProjectId);
  const ids = (project?.sessions ?? []).map((s) => s.id);
  const idsKey = ids.join(",");

  // Read once whenever the open project's session list changes — covers app start, opening
  // a project, and creating a session.
  useEffect(() => {
    if (!idsKey) return;
    const { refreshSessionContext } = useStore.getState();
    for (const id of idsKey.split(",")) void refreshSessionContext(id);
  }, [idsKey]);

  // A turn ended: re-read that session. Scoped to the hook stream rather than a timer so an
  // idle app does no work at all.
  const idsRef = useRef(idsKey);
  idsRef.current = idsKey;
  useEffect(() => {
    const unlisten = listen<{ session: string; event: string }>("hook", ({ payload }) => {
      if (payload.event !== "stop" && payload.event !== "precompact") return;
      // `precompact` matters as much as `stop`: a compaction is the one event that makes
      // the meter go DOWN, and a stale full meter is exactly when someone acts on it.
      void useStore.getState().refreshSessionContext(payload.session);
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Creep the meter up during a long turn.
  useEffect(() => {
    if (!idsKey) return;
    const t = setInterval(() => {
      const st = useStore.getState();
      for (const id of idsRef.current.split(",")) {
        if (st.live[id]?.status === "running") void st.refreshSessionContext(id);
      }
    }, RUNNING_POLL_MS);
    return () => clearInterval(t);
  }, [idsKey]);
}
