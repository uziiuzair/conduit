import { useEffect, useRef, useState, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { useStore, activeGroup, baseName, parentDir } from "../store";
import { FolderIcon, FileIcon, ChevronRightIcon } from "./Icons";

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}

type Pending = { parentDir: string; kind: "file" | "dir" } | null;
type Menu = { x: number; y: number; entry: DirEntry | null } | null;

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

// Shared context threaded down the recursive tree (avoids prop drilling churn).
interface TreeCtx {
  activePath?: string;
  expanded: Set<string>;
  toggle: (path: string) => void;
  onOpen: (path: string) => void;
  onContext: (e: MouseEvent, entry: DirEntry | null) => void;
  pending: Pending;
  renaming: string | null;
  commitCreate: (name: string) => void;
  cancelCreate: () => void;
  commitRename: (from: string, name: string) => void;
  cancelRename: () => void;
}

export function FileTree({
  projectId,
  rootDir,
}: {
  projectId: string;
  rootDir: string;
}) {
  const openFile = useStore((s) => s.openFile);
  const bumpDir = useStore((s) => s.bumpDir);
  const renamePath = useStore((s) => s.renamePath);
  const deletePath = useStore((s) => s.deletePath);
  const activePath = useStore((s) =>
    activeGroup(s.layouts[projectId])?.activeRef ?? undefined,
  );
  const rootVersion = useStore((s) => s.dirVersion[rootDir] ?? 0);

  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<Menu>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  // Show "Loading…" only when the root itself changes — NOT on a dirVersion bump.
  useEffect(() => {
    setEntries(null);
  }, [rootDir]);

  // (Re)list the root on mount, rootDir change, and targeted bumpDir(rootDir).
  useEffect(() => {
    let alive = true;
    void invoke<DirEntry[]>("list_dir", { dir: rootDir })
      .then((e) => alive && setEntries(e))
      .catch(() => alive && setEntries([]));
    return () => {
      alive = false;
    };
  }, [rootDir, rootVersion]);

  // Close the context menu on any outside interaction (mirrors SessionContextMenu).
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const startCreate = (parent: string, kind: "file" | "dir") => {
    setMenu(null);
    setRenaming(null);
    // Ensure the target folder is expanded so its inline row is visible.
    if (parent !== rootDir) setExpanded((prev) => new Set(prev).add(parent));
    setPending({ parentDir: parent, kind });
  };

  const commitCreate = async (raw: string) => {
    const p = pending;
    setPending(null);
    if (!p) return;
    const name = raw.trim();
    if (!name) return;
    const path = joinPath(p.parentDir, name);
    try {
      await invoke(p.kind === "file" ? "create_file" : "create_dir", { path });
    } catch (e) {
      void invoke("notify_user", { title: "Conduit", body: String(e) }).catch(() => {});
      return;
    }
    bumpDir(p.parentDir);
    if (p.kind === "file") openFile(projectId, path);
  };

  const commitRename = async (from: string, raw: string) => {
    setRenaming(null);
    const name = raw.trim();
    if (!name || name === baseName(from)) return;
    await renamePath(projectId, from, joinPath(parentDir(from), name));
  };

  const onDelete = async (entry: DirEntry) => {
    setMenu(null);
    // Pre-block a dirty open buffer (store.deletePath is the authoritative guard).
    if (useStore.getState().dirty[entry.path]) {
      void invoke("notify_user", {
        title: "Conduit",
        body: "Save or discard changes before deleting this file.",
      }).catch(() => {});
      return;
    }
    const kind = entry.isDir ? "folder" : "file";
    const ok = await ask(
      `Delete ${kind} "${entry.name}" permanently? This cannot be undone.`,
      { title: "Delete", kind: "warning" },
    );
    if (!ok) return;
    await deletePath(projectId, entry.path);
  };

  const onContext = (e: MouseEvent, entry: DirEntry | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, entry });
  };

  const ctx: TreeCtx = {
    activePath,
    expanded,
    toggle,
    onOpen: (p) => openFile(projectId, p),
    onContext,
    pending,
    renaming,
    commitCreate,
    cancelCreate: () => setPending(null),
    commitRename,
    cancelRename: () => setRenaming(null),
  };

  return (
    <div className="file-tree" onContextMenu={(e) => onContext(e, null)}>
      {entries === null ? (
        <p className="placeholder">Loading…</p>
      ) : entries.length === 0 && pending?.parentDir !== rootDir ? (
        <p className="placeholder">Empty directory.</p>
      ) : (
        <>
          {pending?.parentDir === rootDir && (
            <InlineRow
              depth={0}
              kind={pending.kind}
              onCommit={commitCreate}
              onCancel={() => setPending(null)}
            />
          )}
          {entries.map((e) => (
            <TreeEntry key={e.path} entry={e} depth={0} ctx={ctx} />
          ))}
        </>
      )}
      {menu && (
        <FileTreeMenu
          menu={menu}
          rootDir={rootDir}
          onNewFile={(parent) => startCreate(parent, "file")}
          onNewFolder={(parent) => startCreate(parent, "dir")}
          onRename={(entry) => {
            setMenu(null);
            setPending(null);
            setRenaming(entry.path);
          }}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

function TreeEntry({
  entry,
  depth,
  ctx,
}: {
  entry: DirEntry;
  depth: number;
  ctx: TreeCtx;
}) {
  const isOpen = ctx.expanded.has(entry.path);
  const dv = useStore((s) => s.dirVersion[entry.path] ?? 0);
  const [children, setChildren] = useState<DirEntry[] | null>(null);

  // Load / re-list children whenever this dir is expanded or its dirVersion bumps.
  useEffect(() => {
    if (!entry.isDir || !isOpen) return;
    let alive = true;
    void invoke<DirEntry[]>("list_dir", { dir: entry.path })
      .then((c) => alive && setChildren(c))
      .catch(() => alive && setChildren([]));
    return () => {
      alive = false;
    };
  }, [entry.isDir, entry.path, isOpen, dv]);

  const rowClick = () => {
    if (entry.isDir) ctx.toggle(entry.path);
    else ctx.onOpen(entry.path);
  };

  if (ctx.renaming === entry.path) {
    return (
      <InlineRow
        depth={depth}
        kind={entry.isDir ? "dir" : "file"}
        initial={entry.name}
        onCommit={(v) => ctx.commitRename(entry.path, v)}
        onCancel={ctx.cancelRename}
      />
    );
  }

  return (
    <>
      <div
        className={`tree-row ${!entry.isDir && ctx.activePath === entry.path ? "active" : ""}`}
        style={{ paddingLeft: 8 + depth * 13 }}
        onClick={rowClick}
        onContextMenu={(e) => ctx.onContext(e, entry)}
        title={entry.name}
      >
        {entry.isDir ? (
          <ChevronRightIcon size={11} className={`chev ${isOpen ? "open" : ""}`} />
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
      {entry.isDir && isOpen && (
        <>
          {ctx.pending?.parentDir === entry.path && (
            <InlineRow
              depth={depth + 1}
              kind={ctx.pending.kind}
              onCommit={ctx.commitCreate}
              onCancel={ctx.cancelCreate}
            />
          )}
          {children?.map((c) => (
            <TreeEntry key={c.path} entry={c} depth={depth + 1} ctx={ctx} />
          ))}
        </>
      )}
    </>
  );
}

function InlineRow({
  depth,
  kind,
  initial,
  onCommit,
  onCancel,
}: {
  depth: number;
  kind: "file" | "dir";
  initial?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  // Guards against Enter's commit being followed by blur's cancel.
  const done = useRef(false);
  return (
    <div
      className="tree-row"
      style={{ paddingLeft: 8 + depth * 13 }}
      onClick={(e) => e.stopPropagation()}
    >
      <span className="chev-spacer" />
      {kind === "dir" ? (
        <FolderIcon size={12} className="tree-ic folder" />
      ) : (
        <FileIcon size={12} className="tree-ic" />
      )}
      <input
        className="session-rename-input"
        defaultValue={initial ?? ""}
        autoFocus
        spellCheck={false}
        placeholder={kind === "dir" ? "folder name" : "file name"}
        onClick={(e) => e.stopPropagation()}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            if (done.current) return;
            done.current = true;
            onCommit(e.currentTarget.value);
          } else if (e.key === "Escape") {
            done.current = true;
            onCancel();
          }
        }}
        onBlur={() => {
          if (done.current) return;
          done.current = true;
          onCancel();
        }}
      />
    </div>
  );
}

function FileTreeMenu({
  menu,
  rootDir,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
}: {
  menu: NonNullable<Menu>;
  rootDir: string;
  onNewFile: (parent: string) => void;
  onNewFolder: (parent: string) => void;
  onRename: (entry: DirEntry) => void;
  onDelete: (entry: DirEntry) => void;
}) {
  const entry = menu.entry;
  // Folder -> create inside it; file -> create as sibling; empty area -> root.
  const parent = !entry ? rootDir : entry.isDir ? entry.path : parentDir(entry.path);
  return (
    <div
      className="context-menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
    >
      <button onClick={() => onNewFile(parent)}>New File</button>
      <button onClick={() => onNewFolder(parent)}>New Folder</button>
      {entry && <button onClick={() => onRename(entry)}>Rename</button>}
      {entry && (
        <button className="danger" onClick={() => onDelete(entry)}>
          Delete
        </button>
      )}
    </div>
  );
}
