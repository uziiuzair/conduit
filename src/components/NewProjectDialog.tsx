import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore } from "../store";
import { cloneNameFromUrl, validateProjectName } from "../projectNew";

/** Per-machine UI memory, not project state — same tier as the canvas blob. Lives here
 *  rather than in projectNew.ts so that module stays importable under the node-env
 *  vitest (localStorage throws at module scope there). */
const PARENT_KEY = "conduit.newProjectParent";

function readParent(): string {
  try {
    return localStorage.getItem(PARENT_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Create a project folder, or clone a repository into one, then add it as a project.
 * The location is an editable text input with Browse as convenience — typing a path
 * must work, both for keyboard users and because the E2E harness cannot drive the
 * native folder picker.
 */
export function NewProjectDialog({
  mode,
  onClose,
}: {
  mode: "create" | "clone";
  onClose: () => void;
}) {
  const addProject = useStore((s) => s.addProject);
  const home = useStore((s) => s.homeDir);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  /** Until the user edits the folder name, a clone derives it from the URL live. */
  const [nameTouched, setNameTouched] = useState(false);
  const [gitInit, setGitInit] = useState(true);
  const [parent, setParent] = useState(readParent);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  // One id per clone RUN, not per dialog instance: `clone-progress` is a plain broadcast,
  // so without a filter a second run (another window's dialog, or this one reopened while
  // a previous clone is still streaming its last throttled lines) would show the wrong
  // run's progress text. Minted at submit time, not on mount, so an unstarted dialog never
  // listens for a run that hasn't happened yet.
  const requestIdRef = useRef("");

  const effName = mode === "clone" && !nameTouched ? cloneNameFromUrl(url) : name;

  // First run has no remembered location; the home dir is already in the store.
  useEffect(() => {
    if (!parent && home) setParent(home);
  }, [parent, home]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  useEffect(() => {
    if (!busy || mode !== "clone") return;
    const un = listen<{ line: string; requestId: string }>("clone-progress", ({ payload }) => {
      if (payload.requestId === requestIdRef.current) setProgress(payload.line);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [busy, mode]);

  const browse = async () => {
    const dir = await open({
      directory: true,
      multiple: false,
      title: "Choose a location",
      defaultPath: parent || undefined,
    });
    if (typeof dir === "string") setParent(dir);
  };

  const validate = (): string | null => {
    if (mode === "clone" && !url.trim()) return "Repository URL is required";
    const nameErr = validateProjectName(effName);
    if (nameErr) return nameErr;
    if (!parent.trim()) return "Choose a location";
    return null;
  };

  const submit = async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    setBusy(true);
    setError(null);
    setProgress("");
    requestIdRef.current = crypto.randomUUID();
    try {
      const path =
        mode === "create"
          ? await invoke<string>("create_project_dir", {
              parent: parent.trim(),
              name: effName.trim(),
              gitInit,
            })
          : await invoke<string>("clone_project_repo", {
              url: url.trim(),
              parent: parent.trim(),
              name: effName.trim(),
              requestId: requestIdRef.current,
            });
      try {
        localStorage.setItem(PARENT_KEY, parent.trim());
      } catch {
        // Per-machine convenience only; never worth failing the flow over.
      }
      await addProject(path);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const title = mode === "create" ? "New project" : "Clone repository";
  return (
    <div className="dialog-overlay" onClick={busy ? undefined : onClose}>
      <div
        className="dialog np-dialog"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">{title}</div>

        {mode === "clone" && (
          <>
            <div className="dialog-label">Repository URL</div>
            <input
              className="dialog-input np-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/user/repo.git"
              autoFocus
              disabled={busy}
              spellCheck={false}
            />
          </>
        )}

        <div className="dialog-label">{mode === "create" ? "Project name" : "Folder name"}</div>
        <input
          className="dialog-input np-name"
          value={effName}
          onChange={(e) => {
            setNameTouched(true);
            setName(e.target.value);
          }}
          placeholder={mode === "create" ? "my-project" : ""}
          autoFocus={mode === "create"}
          disabled={busy}
          spellCheck={false}
        />

        <div className="dialog-label">Location</div>
        <div className="np-location-row">
          <input
            className="dialog-input np-location"
            value={parent}
            onChange={(e) => setParent(e.target.value)}
            disabled={busy}
            spellCheck={false}
          />
          <button onClick={browse} disabled={busy}>
            Browse…
          </button>
        </div>

        {mode === "create" && (
          <label className="dialog-toggle">
            <input
              type="checkbox"
              checked={gitInit}
              onChange={(e) => setGitInit(e.target.checked)}
              disabled={busy}
            />
            Initialize git repository
          </label>
        )}

        {busy && (
          <div className="dialog-note np-progress">
            {mode === "clone" ? progress || "Cloning…" : "Creating…"}
          </div>
        )}
        {error && <div className="dialog-note np-error">{error}</div>}

        <div className="dialog-actions">
          <button onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="primary np-submit" onClick={submit} disabled={busy}>
            {mode === "create" ? "Create" : "Clone"}
          </button>
        </div>
      </div>
    </div>
  );
}
