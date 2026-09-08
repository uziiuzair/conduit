import { useEffect, useRef, useState } from "react";
import { SECTION_PALETTE, type CanvasSection } from "../canvas";

/**
 * One section's frame.
 *
 * Nothing here takes the pointer except the title chip and the grip: the body must stay
 * transparent to clicks, or a section would swallow every interaction with the cards it
 * contains -- and the cards are the point.
 *
 * The chip sits ABOVE the box rather than inside it, matching Figma, for the same reason:
 * inside, it would compete for space with whatever the section holds.
 */
export function CanvasSectionFrame({
  section,
  selected,
  editRequest,
  onMovePointerDown,
  onResizePointerDown,
  onContextMenu,
  onRename,
}: {
  section: CanvasSection;
  selected: boolean;
  /**
   * Bumped by the parent's "Rename" context-menu item to enter edit mode without a pointer
   * event. `window.prompt()` is unreliable in WKWebView (see the ProfileBar comment in
   * Sidebar.tsx), so this is the only other door into edit mode besides the double-click
   * below -- the editing state itself stays entirely local; this only requests it open.
   */
  editRequest?: number;
  onMovePointerDown: (e: React.PointerEvent) => void;
  onResizePointerDown: (e: React.PointerEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // See `editRequest` above: only reacts to a CHANGE, so it never re-opens editing on an
  // unrelated re-render (e.g. the section moving while the menu happens to still name it).
  const seenEditRequest = useRef(editRequest);
  useEffect(() => {
    if (editRequest !== undefined && editRequest !== seenEditRequest.current) {
      seenEditRequest.current = editRequest;
      setDraft(section.title);
      setEditing(true);
    }
  }, [editRequest, section.title]);

  const tint =
    section.color === undefined
      ? "var(--border)"
      : SECTION_PALETTE[section.color % SECTION_PALETTE.length];

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== section.title) onRename(next);
    else setDraft(section.title);
  };

  return (
    <div
      className={`canvas-section ${selected ? "selected" : ""}`}
      style={{ left: section.x, top: section.y, width: section.w, height: section.h }}
    >
      <div
        className="canvas-section-box"
        style={{
          borderColor: tint,
          // A wash, not a fill: the cards inside have to stay readable over it.
          background: `color-mix(in srgb, ${tint} 8%, transparent)`,
        }}
      />
      {editing ? (
        <input
          ref={inputRef}
          className="canvas-section-title editing"
          style={{ background: tint }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(section.title);
              setEditing(false);
            }
            e.stopPropagation(); // the board owns Escape, undo and Delete
          }}
        />
      ) : (
        <div
          className="canvas-section-title"
          style={{ background: tint }}
          title={section.title}
          onPointerDown={onMovePointerDown}
          onDoubleClick={() => {
            setDraft(section.title);
            setEditing(true);
          }}
          onContextMenu={onContextMenu}
        >
          {section.title}
        </div>
      )}
      <div
        className="canvas-section-grip"
        title="Drag to resize"
        onPointerDown={onResizePointerDown}
      />
    </div>
  );
}
