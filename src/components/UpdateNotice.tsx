import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";

const REPO_RELEASES = "https://github.com/uziiuzair/conduit/releases/latest";

function openReleaseNotes() {
  void invoke("open_external", { url: REPO_RELEASES }).catch(() => {});
}

/**
 * Non-blocking "update available / downloading / failed" banner. Rendered as a
 * plain fixed-position overlay sibling in App — never wraps the terminal stack
 * (that would kill live PTYs). Installing relaunches Conduit, which the copy
 * states explicitly.
 */
export function UpdateNotice() {
  const info = useStore((s) => s.updateInfo);
  const phase = useStore((s) => s.updatePhase);
  const progress = useStore((s) => s.updateProgress);
  const error = useStore((s) => s.updateError);
  const install = useStore((s) => s.installUpdate);
  const dismiss = useStore((s) => s.dismissUpdate);

  // Show only when there's a pending update to act on: available, mid-download,
  // or a failed install the user can retry.
  if (!info || (phase !== "available" && phase !== "downloading" && phase !== "error")) {
    return null;
  }

  const downloading = phase === "downloading";
  const errored = phase === "error";
  const pct = Math.round(progress * 100);

  return (
    <div className="update-notice" role="status" aria-label="Software update">
      <div className="update-notice-body">
        <div className="update-notice-title">
          {errored
            ? `Couldn't update to Conduit ${info.version}`
            : `Conduit ${info.version} is available`}
        </div>
        <div className="update-notice-sub">
          {errored ? (
            <>Update failed{error ? `: ${error}` : ""}. You can try again.</>
          ) : (
            <>
              Installing restarts Conduit and ends running agent sessions.{" "}
              <span
                className="update-notice-link"
                role="link"
                tabIndex={0}
                onClick={openReleaseNotes}
                onKeyDown={(e) => e.key === "Enter" && openReleaseNotes()}
              >
                Release notes
              </span>
            </>
          )}
        </div>
      </div>
      {downloading ? (
        <div className="update-notice-progress" aria-label={`Downloading ${pct}%`}>
          <div className="update-notice-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      ) : (
        <div className="update-notice-actions">
          <button className="update-notice-later" onClick={dismiss}>
            Later
          </button>
          <button className="update-notice-install" onClick={() => void install()}>
            {errored ? "Retry" : "Install & Relaunch"}
          </button>
        </div>
      )}
    </div>
  );
}
