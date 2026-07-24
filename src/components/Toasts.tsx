import { useEffect } from "react";
import { useStore, type ToastKind } from "../store";

function ToastItem({
  id,
  body,
  kind,
  onDone,
}: {
  id: string;
  body: string;
  kind: ToastKind;
  onDone: (id: string) => void;
}) {
  useEffect(() => {
    const h = setTimeout(() => onDone(id), 4000);
    return () => clearTimeout(h);
  }, [id, onDone]);
  return (
    <div
      className={`toast ${kind}`}
      onClick={() => onDone(id)}
      role={kind === "error" ? "alert" : "status"}
    >
      {body}
    </div>
  );
}

/** Mounted once at the app root. Renders the transient toast stack bottom-center. */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <ToastItem key={t.id} id={t.id} body={t.body} kind={t.kind} onDone={dismiss} />
      ))}
    </div>
  );
}
