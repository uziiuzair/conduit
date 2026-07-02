import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";

const REPO_RELEASES = "https://github.com/uziiuzair/conduit/releases/latest";

/**
 * Non-blocking "update available / downloading" banner. Rendered as a plain
 * overlay sibling in App — never wraps the terminal stack (that would kill live
 * PTYs). Installing relaunches Conduit, which the copy states explicitly.
 */
export function UpdateNotice() {
  const info = useStore((s) => s.updateInfo);
  const phase = useStore((s) => s.updatePhase);
  const progress = useStore((s) => s.updateProgress);
  const install = useStore((s) => s.installUpdate);
  const dismiss = useStore((s) => s.dismissUpdate);

  // Only show when there's an available update (or it's mid-download).
  if (!info || (phase !== "available" && phase !== "downloading")) return null;

  const downloading = phase === "downloading";
  const pct = Math.round(progress * 100);

  return (
    <div className="update-notice" role="dialog" aria-live="polite">
      <div className="update-notice-body">
        <div className="update-notice-title">
          Conduit {info.version} is available
        </div>
        <div className="update-notice-sub">
          Installing restarts Conduit and ends running agent sessions.{" "}
          <span
            className="update-notice-link"
            role="link"
            tabIndex={0}
            onClick={() => void invoke("open_external", { url: REPO_RELEASES }).catch(() => {})}
            onKeyDown={(e) =>
              e.key === "Enter" &&
              void invoke("open_external", { url: REPO_RELEASES }).catch(() => {})
            }
          >
            Release notes
          </span>
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
            Install &amp; Relaunch
          </button>
        </div>
      )}
    </div>
  );
}
