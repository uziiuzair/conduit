import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Mirror of fsops::FileBase64 (serde camelCase). */
interface FileBase64 {
  base64: string;
  size: number;
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

function mimeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// Overlays the (model-less) editor host for binary raster images — same overlay
// pattern as MarkdownPreview (absolute, z-index 4, under the conflict banners at 5).
// Bytes arrive base64 over IPC (read_file_base64, 16 MB cap in Rust) and render as a
// data: URL, which is script-inert in an <img> context.
export function ImagePreview({ path }: { path: string }) {
  const [state, setState] = useState<
    { url: string; size: number } | { error: string } | null
  >(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let alive = true;
    setState(null);
    setDims(null);
    invoke<FileBase64>("read_file_base64", { path })
      .then((r) => {
        if (alive) setState({ url: `data:${mimeOf(path)};base64,${r.base64}`, size: r.size });
      })
      .catch((e) => {
        if (alive) setState({ error: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [path]);

  return (
    <div className="image-preview">
      {state === null ? null : "error" in state ? (
        <div className="image-preview-note">{state.error}</div>
      ) : (
        <>
          <img
            src={state.url}
            alt={path}
            onLoad={(e) =>
              setDims({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
            }
          />
          <div className="image-preview-note">
            {dims ? `${dims.w}×${dims.h} · ` : ""}
            {fmtSize(state.size)}
          </div>
        </>
      )}
    </div>
  );
}
