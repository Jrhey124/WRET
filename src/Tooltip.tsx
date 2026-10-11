import { cloneElement, isValidElement, useEffect, useId, useState, type ReactNode } from "react";

/** Small, keyboard accessible help for a control or tool. */
export function Tooltip({ content, children, wrapperRole }: { content: string; children: ReactNode; wrapperRole?: "presentation" }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const disabled = isValidElement<{ disabled?: boolean }>(children) && children.props.disabled;
  const describedChild = isValidElement<{ "aria-describedby"?: string }>(children)
    ? cloneElement(children, { "aria-describedby": [children.props["aria-describedby"], open ? id : undefined].filter(Boolean).join(" ") || undefined })
    : children;
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  return (
    <span className="tooltip-anchor" role={wrapperRole} tabIndex={disabled ? 0 : undefined} aria-label={disabled ? `Unavailable. ${content}` : undefined} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
      {describedChild}
      {open && <span className="tooltip-content" id={id} role="tooltip">{content}</span>}
    </span>
  );
}
