import { useEffect } from "react";
import { useStore } from "../store";

/** Settings → General: startup / session behavior toggles. */
export function GeneralSettings() {
  const openBehavior = useStore((s) => s.openBehavior);
  const setOpenBehavior = useStore((s) => s.setOpenBehavior);
  const restoreSessionsOnOpen = useStore((s) => s.restoreSessionsOnOpen);
  const setRestoreSessionsOnOpen = useStore((s) => s.setRestoreSessionsOnOpen);
  const persistSessions = useStore((s) => s.persistSessions);
  const setPersistSessions = useStore((s) => s.setPersistSessions);
  const tmuxAvailable = useStore((s) => s.tmuxAvailable);
  const tmuxInstall = useStore((s) => s.tmuxInstall);
  const tmuxSupported = useStore((s) => s.tmuxSupported);
  const richSessionView = useStore((s) => s.richSessionView);
  const setRichSessionView = useStore((s) => s.setRichSessionView);
  const probeTmux = useStore((s) => s.probeTmux);

  // Probe on first open rather than at app boot: it shells out, and nothing before
  // this panel needs the answer. `null` until it lands, which the copy below renders
  // as "checking" instead of flashing a false "not installed".
  useEffect(() => {
    if (tmuxAvailable === null) void probeTmux();
  }, [tmuxAvailable, probeTmux]);

  return (
    <div className="general-settings">
      <label className="dialog-toggle">
        <input
          type="checkbox"
          checked={openBehavior === "last"}
          onChange={(e) => setOpenBehavior(e.target.checked ? "last" : "none")}
        />
        <span>
          Reopen the last project on launch — come back to whichever project you were in
          when you quit. Off = Conduit opens with nothing selected and waits for you to pick.
          Either way it never opens the topmost project just for being topmost, and the first
          launch after an update has nothing to remember yet, so it starts empty once.
        </span>
      </label>

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

      <label className="dialog-toggle">
        <input
          type="checkbox"
          checked={richSessionView}
          onChange={(e) => setRichSessionView(e.target.checked)}
        />
        <span>
          Rich session view — adds a Chat button to each session tab that renders the
          conversation as messages and tool cards instead of terminal output, with a proper
          input box. The terminal keeps running underneath the whole time and is one click
          away; nothing is regenerated or summarized, so it costs no tokens. Claude sessions
          only, since it reads Claude’s transcript.
        </span>
      </label>

      <label className="dialog-toggle">
        <input
          type="checkbox"
          checked={persistSessions && tmuxAvailable !== false}
          disabled={tmuxAvailable === false}
          onChange={(e) => setPersistSessions(e.target.checked)}
        />
        <span>
          Keep sessions running after you quit — each session runs inside tmux, so agents keep
          working when Conduit is closed and the next launch attaches to the live session instead
          of replaying the conversation. Scrollback and anything mid-run survive too. Off = a
          session ends when Conduit does.
          {/* Two different "off" states. `supported === false` is the OS (Windows has no
              tmux and never will), so it gets a statement of fact; anything else is a
              missing install, which gets a way to fix it. Telling a Windows user to reach
              for their package manager is advice that cannot be taken. */}
          {tmuxSupported === false ? (
            <em className="dialog-hint">
              {" "}
              Not available on Windows — session persistence runs on tmux. Sessions end when
              Conduit does; Claude and agy still resume their conversation on the next launch.
            </em>
          ) : (
            tmuxAvailable === false && (
              <em className="dialog-hint">
                {" "}
                Needs tmux, which isn’t installed.
                {/* The command comes from the backend: it depends on the platform and on what
                    is already there, so a hardcoded `brew install tmux` is wrong on every
                    Linux and on a Mac without Homebrew. */}
                {tmuxInstall ? (
                  <>
                    {" "}
                    Install it with <code>{tmuxInstall.command}</code> and reopen Settings.
                  </>
                ) : (
                  <> Install tmux with your system’s package manager and reopen Settings.</>
                )}
              </em>
            )
          )}
          {tmuxAvailable === null && tmuxSupported !== false && (
            <em className="dialog-hint"> Checking for tmux…</em>
          )}
        </span>
      </label>
    </div>
  );
}
