import { useEffect, useState } from "react";
import { isGitRepo } from "../store";

export function NewSessionDialog({
  projectPath,
  onCancel,
  onCreate,
}: {
  projectPath: string;
  onCancel: () => void;
  onCreate: (opts: { name?: string; useWorktree: boolean }) => void;
}) {
  const [name, setName] = useState("");
  const [useWorktree, setUseWorktree] = useState(false);
  const [gitOk, setGitOk] = useState(false);

  useEffect(() => {
    let alive = true;
    void isGitRepo(projectPath).then((ok) => {
      if (alive) setGitOk(ok);
    });
    return () => {
      alive = false;
    };
  }, [projectPath]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submit = () => onCreate({ name: name.trim() || undefined, useWorktree: useWorktree && gitOk });

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">New session</div>
        <input
          className="dialog-input"
          placeholder="Name (optional)"
          autoFocus
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <label className={`dialog-toggle ${gitOk ? "" : "disabled"}`} title={gitOk ? "" : "Not a git repository"}>
          <input
            type="checkbox"
            checked={useWorktree && gitOk}
            disabled={!gitOk}
            onChange={(e) => setUseWorktree(e.target.checked)}
          />
          <span>Isolate in a git worktree</span>
        </label>
        <div className="dialog-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={submit}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
