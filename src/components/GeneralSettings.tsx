import { useStore } from "../store";

/** Settings → General: startup / session behavior toggles. */
export function GeneralSettings() {
  const restoreSessionsOnOpen = useStore((s) => s.restoreSessionsOnOpen);
  const setRestoreSessionsOnOpen = useStore((s) => s.setRestoreSessionsOnOpen);

  return (
    <div className="general-settings">
      <label className="dialog-toggle">
        <input
          type="checkbox"
          checked={restoreSessionsOnOpen}
          onChange={(e) => setRestoreSessionsOnOpen(e.target.checked)}
        />
        <span>
          Restore sessions when opening a project — relaunch and resume every session of a
          project the moment you open it (Claude and agy reopen the conversation where you left
          off), instead of waiting for a click. Off = sessions spawn only when you click their tab.
        </span>
      </label>
    </div>
  );
}
