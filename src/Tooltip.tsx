import { cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactNode } from "react";

/** Small, keyboard accessible help for a control or tool. */
export function Tooltip({ content, children, wrapperRole }: { content: string; children: ReactNode; wrapperRole?: "presentation" }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const hoverTimer = useRef<number | undefined>(undefined);
  const disabled = isValidElement<{ disabled?: boolean }>(children) && children.props.disabled;
  const describedChild = isValidElement<{ "aria-describedby"?: string }>(children)
    ? cloneElement(children, { "aria-describedby": [children.props["aria-describedby"], open ? id : undefined].filter(Boolean).join(" ") || undefined })
    : children;
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { if (hoverTimer.current !== undefined) window.clearTimeout(hoverTimer.current); hoverTimer.current = undefined; setOpen(false); }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  useEffect(() => () => { if (hoverTimer.current !== undefined) window.clearTimeout(hoverTimer.current); }, []);
  return (
    <span className="tooltip-anchor" role={wrapperRole} tabIndex={disabled ? 0 : undefined} aria-label={disabled ? `Unavailable. ${content}` : undefined} onMouseEnter={() => { hoverTimer.current = window.setTimeout(() => setOpen(true), 450); }} onMouseLeave={() => { if (hoverTimer.current !== undefined) window.clearTimeout(hoverTimer.current); hoverTimer.current = undefined; setOpen(false); }} onFocus={() => setOpen(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
      {describedChild}
      {open && <span className="tooltip-content" id={id} role="tooltip">{content.length > 320 ? `${content.slice(0, 317)}...` : content}</span>}
    </span>
  );
}
