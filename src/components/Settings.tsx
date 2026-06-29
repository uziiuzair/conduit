import { useEffect } from "react";
import { AgentList } from "./AgentList";

export function Settings({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog settings" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <div className="settings-tabs"><span className="settings-tab on">Agents</span></div>
          <button className="settings-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="settings-body">
          <p className="settings-intro">Conduit runs whichever of these are installed on your PATH. Pick the default for new sessions.</p>
          <AgentList />
        </div>
      </div>
    </div>
  );
}
