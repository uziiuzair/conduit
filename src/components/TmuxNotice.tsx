import { useState } from "react";
import { useStore } from "../store";

/**
 * "Sessions won't survive a quit, and here is why."
 *
 * Session persistence runs on tmux, and without tmux Conduit falls back silently — which is
 * the whole problem: the setting reads as on, agents die on quit, and nothing ever says the
 * word tmux. This is the one place that says it.
 *
 * The install command is copied rather than run. It is `sudo` on Linux and, on a Mac with no
 * Homebrew, an installer that rewrites parts of /opt — not something to execute because
 * someone clicked a banner. Copying puts it one paste from done and leaves the decision
 * where it belongs.
 */
export function TmuxNotice() {
  const persistSessions = useStore((s) => s.persistSessions);
  const tmuxAvailable = useStore((s) => s.tmuxAvailable);
  const install = useStore((s) => s.tmuxInstall);
  const tmuxSupported = useStore((s) => s.tmuxSupported);
  const dismissed = useStore((s) => s.tmuxNoticeDismissed);
  const dismiss = useStore((s) => s.dismissTmuxNotice);
  const [copied, setCopied] = useState(false);

  // `null` = still probing. Only nag someone who asked for persistence in the first place,
  // and never on a platform where persistence cannot exist: on Windows there is no tmux to
  // install, so this banner would be a permanent complaint about the operating system.
  if (dismissed || tmuxSupported === false || tmuxAvailable !== false || !persistSessions)
    return null;

  const copy = () => {
    if (!install) return;
    void navigator.clipboard
      .writeText(install.command)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  };

  return (
    <div className="tmux-notice">
      <span className="tmux-notice-text">
        Sessions won’t keep running after you quit — that needs <strong>tmux</strong>, which
        isn’t installed.
      </span>
      {install && (
        <>
          <code className="tmux-notice-cmd" title={install.command}>
            {install.command}
          </code>
          <button className="tmux-notice-btn" onClick={copy}>
            {copied ? "Copied" : `Copy: ${install.label}`}
          </button>
        </>
      )}
      <button className="tmux-notice-btn subtle" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  );
}
