import { useEffect, useRef, type ReactNode } from "react";

type DialogProps = {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  returnFocusRef: React.RefObject<HTMLElement | null>;
};

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onClose,
  returnFocusRef,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel === null) return;
    const listFocusables = () =>
      [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => !el.hasAttribute("disabled"),
      );

    const focusables = listFocusables();
    const first = focusables[0];
    if (first !== undefined) {
      window.requestAnimationFrame(() => first.focus());
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const current = listFocusables();
      if (current.length === 0) return;
      const active = document.activeElement;
      const index = current.findIndex((el) => el === active);
      if (index === -1) {
        event.preventDefault();
        current[0]!.focus();
        return;
      }
      const next = event.shiftKey
        ? current[(index - 1 + current.length) % current.length]!
        : current[(index + 1) % current.length]!;
      event.preventDefault();
      next.focus();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (open) return;
    const target = returnFocusRef.current;
    if (target !== null) {
      window.requestAnimationFrame(() => target.focus());
    }
  }, [open, returnFocusRef]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onMouseDown={onClose} role="presentation">
      <div
        className="dialog-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="dialog-title">{title}</h2>
        {children}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {cancelLabel}
          </button>
          <button type="button" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
