import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

const REPO_URL = "https://github.com/uziiuzair/conduit";
const SITE_URL = "https://ooozzy.com";

function openExternal(url: string) {
  void invoke("open_external", { url }).catch(() => {});
}

export function AboutPanel() {
  const [version, setVersion] = useState("");
  useEffect(() => {
    void getVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  const link = (url: string, label: string) => (
    <a
      className="about-link"
      role="link"
      tabIndex={0}
      onClick={() => openExternal(url)}
      onKeyDown={(e) => e.key === "Enter" && openExternal(url)}
    >
      {label}
    </a>
  );

  return (
    <div className="about-panel">
      <div className="about-wordmark">Conduit</div>
      <p className="settings-intro">
        Multiple real Claude Code terminals across your projects, in one window.
      </p>
      <p className="about-credit">
        Built with love by Uzair Hayat at {link(SITE_URL, "Ooozzy")}.
      </p>
      <div className="about-rows">
        <div className="about-row">
          <span className="about-key">Version</span>
          <span className="about-val">{version || "..."}</span>
        </div>
        <div className="about-row">
          <span className="about-key">Source</span>
          {link(REPO_URL, "github.com/uziiuzair/conduit")}
        </div>
        <div className="about-row">
          <span className="about-key">License</span>
          <span className="about-val">MIT</span>
        </div>
      </div>
    </div>
  );
}
