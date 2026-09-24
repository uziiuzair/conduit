import { useEffect, useState, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { InfoIcon } from "./Icons";

/** Mirrors `cli_shim::ShimStatus` (serde camelCase). */
type ShimStatus = {
  installed: boolean;
  path: string | null;
  dir: string | null;
  onPath: boolean;
};

/**
 * One settings row: a short scannable title on the control line, the full explanation
 * behind the (i) disclosure. `status` renders ALWAYS-visible follow-on lines (a restart
 * note, a missing dependency, an install path) — state the user must see without
 * clicking; the detail copy is background reading. `control` replaces the checkbox for
 * non-toggle rows (workspace root, CLI shim) and renders full-width under the title.
 *
 * The (i) button lives OUTSIDE the <label> on purpose: inside it, expanding the
 * explanation would also flip the checkbox.
 */
function SettingRow({
  id,
  title,
  detail,
  status,
  checked,
  disabled,
  onChange,
  control,
}: {
  id: string;
  title: ReactNode;
  detail: ReactNode;
  status?: ReactNode;
  checked?: boolean;
  disabled?: boolean;
  onChange?: (on: boolean) => void;
  control?: ReactNode;
}) {
  const [openInfo, setOpenInfo] = useState(false);
  const detailId = `setting-detail-${id}`;
  return (
    <div className={"setting-row" + (disabled ? " disabled" : "")}>
      <div className="setting-row-head">
        {onChange ? (
          <label className="setting-row-label">
            <input
              type="checkbox"
              checked={checked}
              disabled={disabled}
              onChange={(e) => onChange(e.target.checked)}
            />
            <span className="setting-row-title">{title}</span>
          </label>
        ) : (
          <span className="setting-row-label">
            <span className="setting-row-title">{title}</span>
          </span>
        )}
        <button
          type="button"
          className={"setting-info" + (openInfo ? " on" : "")}
          title={openInfo ? "Hide explanation" : "What does this do?"}
          aria-label={openInfo ? "Hide explanation" : "Show explanation"}
          aria-expanded={openInfo}
          aria-controls={detailId}
          onClick={() => setOpenInfo((v) => !v)}
        >
          <InfoIcon size={13} />
        </button>
      </div>
      {status && <div className="setting-status">{status}</div>}
      {control && <div className="setting-control">{control}</div>}
      <div id={detailId} className="setting-detail" data-open={openInfo || undefined}>
        <div className="setting-detail-inner">{detail}</div>
      </div>
    </div>
  );
}

/** Settings → General: startup / session behavior toggles. */
export function GeneralSettings() {
  const openBehavior = useStore((s) => s.openBehavior);
  const setOpenBehavior = useStore((s) => s.setOpenBehavior);
  const restoreSessionsOnOpen = useStore((s) => s.restoreSessionsOnOpen);
  const setRestoreSessionsOnOpen = useStore((s) => s.setRestoreSessionsOnOpen);
  const announceAsIde = useStore((s) => s.announceAsIde);
  const setAnnounceAsIde = useStore((s) => s.setAnnounceAsIde);
  const persistSessions = useStore((s) => s.persistSessions);
  const setPersistSessions = useStore((s) => s.setPersistSessions);
  const tmuxAvailable = useStore((s) => s.tmuxAvailable);
  const tmuxInstall = useStore((s) => s.tmuxInstall);
  const tmuxSupported = useStore((s) => s.tmuxSupported);
  const richSessionView = useStore((s) => s.richSessionView);
  const setRichSessionView = useStore((s) => s.setRichSessionView);
  const autoProjectColors = useStore((s) => s.autoProjectColors);
  const setAutoProjectColors = useStore((s) => s.setAutoProjectColors);
  const profileWindowMode = useStore((s) => s.profileWindowMode);
  const setProfileWindowMode = useStore((s) => s.setProfileWindowMode);
  const probeTmux = useStore((s) => s.probeTmux);
  const workspaceRoot = useStore((s) => s.workspaceRoot);
  const setWorkspaceRoot = useStore((s) => s.setWorkspaceRoot);

  const [shim, setShim] = useState<ShimStatus | null>(null);
  const [shimError, setShimError] = useState<string | null>(null);

  useEffect(() => {
    void invoke<ShimStatus>("cli_shim_status")
      .then(setShim)
      .catch(() => {});
  }, []);

  const runShim = async (cmd: "install_cli_shim" | "remove_cli_shim") => {
    setShimError(null);
    try {
      setShim(await invoke<ShimStatus>(cmd));
    } catch (e) {
      setShimError(String(e));
    }
  };

  // Probe on first open rather than at app boot: it shells out, and nothing before
  // this panel needs the answer. `null` until it lands, which the copy below renders
  // as "checking" instead of flashing a false "not installed".
  useEffect(() => {
    if (tmuxAvailable === null) void probeTmux();
  }, [tmuxAvailable, probeTmux]);

  // Two different "off" states for session persistence. `supported === false` is the OS
  // (Windows has no tmux and never will), so it gets a statement of fact; anything else
  // is a missing install, which gets a way to fix it. Telling a Windows user to reach
  // for their package manager is advice that cannot be taken.
  const tmuxStatus =
    tmuxSupported === false ? (
      <>
        Not available on Windows — session persistence runs on tmux. Sessions end when
        Conduit does; Claude and agy still resume their conversation on the next launch.
      </>
    ) : tmuxAvailable === false ? (
      <>
        Needs tmux, which isn’t installed.
        {/* The command comes from the backend: it depends on the platform and on what is
            already there, so a hardcoded `brew install tmux` is wrong on every Linux and
            on a Mac without Homebrew. */}
        {tmuxInstall ? (
          <>
            {" "}
            Install it with <code>{tmuxInstall.command}</code> and reopen Settings.
          </>
        ) : (
          <> Install tmux with your system’s package manager and reopen Settings.</>
        )}
      </>
    ) : tmuxAvailable === null ? (
      <>Checking for tmux…</>
    ) : undefined;

  return (
    <div className="general-settings">
      <SettingRow
        id="reopen-last"
        title="Reopen the last project on launch"
        checked={openBehavior === "last"}
        onChange={(on) => setOpenBehavior(on ? "last" : "none")}
        detail="Come back to whichever project you were in when you quit. Off = Conduit opens with nothing selected and waits for you to pick. Either way it never opens the topmost project just for being topmost, and the first launch after an update has nothing to remember yet, so it starts empty once."
      />

      <SettingRow
        id="restore-sessions"
        title="Restore sessions when opening a project"
        checked={restoreSessionsOnOpen}
        onChange={setRestoreSessionsOnOpen}
        detail="Relaunch and resume every session of a project the moment you open it — Claude and agy reopen the conversation where you left off — instead of waiting for a click. Off = sessions spawn only when you click their tab."
      />

      <SettingRow
        id="announce-ide"
        title="Announce as IDE to Claude sessions"
        checked={announceAsIde}
        onChange={setAnnounceAsIde}
        detail="New Claude sessions connect to Conduit the way they connect to VS Code: review and edit proposed file changes in a side-by-side diff, and send editor selections to the session as context. Off = sessions run as plain terminals. Applies to sessions started after the change."
      />

      <SettingRow
        id="auto-colors"
        title="Color-code projects automatically"
        checked={autoProjectColors}
        onChange={setAutoProjectColors}
        detail="Every project gets a stable accent colour — sidebar folder, tab badges in mixed panes. Off = projects stay neutral unless you pick a colour yourself by right-clicking the project. Colours you pick stay either way."
      />

      <SettingRow
        id="profile-windows"
        title="Open profiles in their own windows"
        checked={profileWindowMode === "window"}
        onChange={(on) => setProfileWindowMode(on ? "window" : "switch")}
        status="Takes effect after restarting Conduit."
        detail="Picking a profile opens (or focuses) a separate window pinned to it, like Obsidian vaults, instead of re-filtering this one. Each window shows and runs only its profile's projects; closing a window leaves its sessions running."
      />

      <SettingRow
        id="rich-view"
        title="Rich session view"
        checked={richSessionView}
        onChange={setRichSessionView}
        detail="Adds a Chat button to each session tab that renders the conversation as messages and tool cards instead of terminal output, with a proper input box. The terminal keeps running underneath the whole time and is one click away; nothing is regenerated or summarized, so it costs no tokens. Claude sessions only, since it reads Claude’s transcript."
      />

      <SettingRow
        id="persist-sessions"
        title="Keep sessions running after you quit"
        checked={persistSessions && tmuxAvailable !== false}
        disabled={tmuxAvailable === false}
        onChange={setPersistSessions}
        status={tmuxStatus}
        detail="Each session runs inside tmux, so agents keep working when Conduit is closed and the next launch attaches to the live session instead of replaying the conversation. Scrollback and anything mid-run survive too. Off = a session ends when Conduit does."
      />

      <SettingRow
        id="workspace-root"
        title="Workspace root"
        detail="The folder HQ root chats read from — where your projects live. Leave empty for your home directory. Root chats can read anything under it but never modify files."
        control={
          <div className="workspace-root-input">
            <input
              type="text"
              value={workspaceRoot}
              placeholder="~ (home directory)"
              spellCheck={false}
              onChange={(e) => setWorkspaceRoot(e.target.value)}
            />
            <button
              onClick={async () => {
                const dir = await open({
                  directory: true,
                  multiple: false,
                  title: "Choose workspace root",
                });
                if (typeof dir === "string") setWorkspaceRoot(dir);
              }}
            >
              Choose…
            </button>
          </div>
        }
      />

      <SettingRow
        id="cli-shim"
        title={
          <>
            The <code>conduit</code> command
          </>
        }
        detail={
          <>
            Open a project from your terminal the way <code>code .</code> does.{" "}
            <code>conduit .</code> opens the current folder;{" "}
            <code>conduit . --agent claude</code> also starts one new session in it. If
            Conduit is not running, it launches first.
          </>
        }
        status={
          shim?.installed || shimError ? (
            <>
              {shim?.installed && <>Installed at {shim.path}.</>}
              {shim?.installed && !shim.onPath && <> Add {shim.dir} to your PATH to use it.</>}
              {shimError && <> {shimError}</>}
            </>
          ) : undefined
        }
        control={
          <div className="cli-shim-action">
            <button
              onClick={() =>
                void runShim(shim?.installed ? "remove_cli_shim" : "install_cli_shim")
              }
            >
              {shim?.installed ? "Remove" : "Install"}
            </button>
          </div>
        }
      />
    </div>
  );
}
