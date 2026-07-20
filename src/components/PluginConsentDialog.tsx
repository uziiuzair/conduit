import type { PluginManifest, PluginPermission } from "../plugins/types";
import { describe } from "../plugins/permissions";

export function PluginConsentDialog({
  manifest, previouslyGranted, onGrant, onCancel,
}: {
  manifest: PluginManifest;
  previouslyGranted: PluginPermission[];
  onGrant: () => void;
  onCancel: () => void;
}) {
  const requested = (manifest.permissions ?? []) as PluginPermission[];
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal plugin-consent" onClick={(e) => e.stopPropagation()}>
        <h2>Enable “{manifest.name}”?</h2>
        <p className="settings-intro">
          {manifest.author ? `By ${manifest.author}. ` : ""}Version {manifest.version}. This plugin
          is asking for the following access:
        </p>
        <ul className="perm-list">
          {requested.map((p) => {
            const info = describe(p);
            const isNew = !previouslyGranted.includes(p);
            return (
              <li key={p} className={isNew ? "perm-row new" : "perm-row"}>
                <div className="perm-label">{info.label}{isNew && previouslyGranted.length ? " (new)" : ""}</div>
                <div className="perm-risk">{info.riskLine}</div>
              </li>
            );
          })}
          {requested.length === 0 && <li className="perm-row">No special access requested.</li>}
        </ul>
        <div className="modal-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={onGrant}>Grant &amp; enable</button>
        </div>
      </div>
    </div>
  );
}
