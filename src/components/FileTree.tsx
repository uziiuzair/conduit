import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore, activeGroup } from "../store";
import { FolderIcon, FileIcon, ChevronRightIcon } from "./Icons";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

export function FileTree({
  projectId,
  rootDir,
}: {
  projectId: string;
  rootDir: string;
}) {
  const openFile = useStore((s) => s.openFile);
  const activePath = useStore((s) =>
    activeGroup(s.layouts[projectId])?.activeRef ?? undefined,
  );
  const [entries, setEntries] = useState<DirEntry[] | null>(null);

  useEffect(() => {
    let alive = true;
    setEntries(null);
    void invoke<DirEntry[]>("list_dir", { dir: rootDir })
      .then((e) => alive && setEntries(e))
      .catch(() => alive && setEntries([]));
    return () => {
      alive = false;
    };
  }, [rootDir]);

  if (entries === null) return <p className="placeholder">Loading…</p>;
  if (entries.length === 0) return <p className="placeholder">Empty directory.</p>;

  return (
    <div className="file-tree">
      {entries.map((e) => (
        <TreeEntry
          key={e.path}
          entry={e}
          depth={0}
          activePath={activePath ?? undefined}
          onOpen={(p) => openFile(projectId, p)}
        />
      ))}
    </div>
  );
}

function TreeEntry({
  entry,
  depth,
  activePath,
  onOpen,
}: {
  entry: DirEntry;
  depth: number;
  activePath?: string;
  onOpen: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);

  const toggle = () => {
    if (entry.isDir) {
      const next = !expanded;
      setExpanded(next);
      if (next && children === null) {
        void invoke<DirEntry[]>("list_dir", { dir: entry.path })
          .then(setChildren)
          .catch(() => setChildren([]));
      }
    } else {
      onOpen(entry.path);
    }
  };

  return (
    <>
      <div
        className={`tree-row ${!entry.isDir && activePath === entry.path ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 13 }}
        onClick={toggle}
        title={entry.name}
      >
        {entry.isDir ? (
          <ChevronRightIcon
            size={11}
            className={`chev ${expanded ? "open" : ""}`}
          />
        ) : (
          <span className="chev-spacer" />
        )}
        {entry.isDir ? (
          <FolderIcon size={12} className="tree-ic folder" />
        ) : (
          <FileIcon size={12} className="tree-ic" />
        )}
        <span className="tree-label">{entry.name}</span>
      </div>
      {expanded &&
        children?.map((c) => (
          <TreeEntry
            key={c.path}
            entry={c}
            depth={depth + 1}
            activePath={activePath}
            onOpen={onOpen}
          />
        ))}
    </>
  );
}
