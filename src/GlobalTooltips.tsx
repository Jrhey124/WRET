import { useEffect } from "react";

const help: Record<string, string> = {
  "Open project": "Open a Whidra archive and restore its evidence, findings, and notes. Existing WRET archives are supported.",
  "Export project": "Download the current investigation as a portable Whidra archive.",
  "Import files": "Add evidence files to this investigation.",
  "Import evidence files": "Add evidence files to this investigation.",
  "Import site folder": "Import a site folder and preserve its relative file paths.",
  "New project": "Start a separate investigation after confirming the current project is no longer needed.",
  "Analyze again": "Run static analysis again on the selected evidence.",
  "Annotate": "Add a note linked to the selected evidence range.",
  "Export Markdown report": "Download a readable Whidra Markdown summary of retained findings and notes.",
  "Export portable project": "Download a Whidra archive that can be reopened later.",
  "Collect website evidence": "Follow Chrome or Edge collection instructions and import recorded evidence for offline review.",
  "Open saved project": "Choose a previously exported Whidra or WRET archive.",
  "Project name": "Rename this investigation. The name is included in its archive and report.",
  "Project search": "Search names and text across imported evidence.",
  "Analyst note": "Write an observation attached to the selected evidence or project.",
  "Note type": "Choose whether this note is a comment, finding, or label.",
  "Encoded input": "Enter encoded text to inspect possible decoding operations.",
  "Decoding operation": "Choose a reversible transform to apply to the encoded input.",
  "Hex byte offset": "Jump to a byte offset in the original evidence.",
  "Evidence views": "Switch between source, byte, formatted, syntax, graph, and decoding views.",
  "Command palette": "Find navigation and common project actions. Press Escape to close.",
  "Deobfuscate JavaScript": "Preview conservative syntax based cleanup. Imported code is never executed.",
};

function labelOf(element: HTMLElement) {
  const associatedLabel = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
    ? element.labels?.[0]?.innerText
    : element.closest("label")?.innerText;
  return (element.getAttribute("aria-label") || element.getAttribute("placeholder") || associatedLabel || element.innerText || element.tagName)
    .replace(/[+â†—â†’]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Adds consistent delayed hover and immediate keyboard help to workbench controls. */
export function GlobalTooltips() {
  useEffect(() => {
    let active: HTMLElement | undefined;
    let tip: HTMLDivElement | undefined;
    let timer: number | undefined;
    let previousDescription: string | null = null;
    const hide = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (active) {
        if (previousDescription === null) active.removeAttribute("aria-describedby");
        else active.setAttribute("aria-describedby", previousDescription);
      }
      tip?.remove();
      active = undefined;
      tip = undefined;
      previousDescription = null;
    };
    const render = (target: EventTarget | null, delayed: boolean) => {
      const element = (target as HTMLElement | null)?.closest<HTMLElement>("button,input,select,textarea,[role=button],summary");
      if (!element || element.closest(".tooltip-anchor") || element.closest(".tooltip-content") || element.closest(".command-backdrop") || (element instanceof HTMLInputElement && element.type === "hidden")) return hide();
      const name = labelOf(element);
      const title = element.getAttribute("title") || "";
      const fullDescription = help[name] || (title.length <= 120 ? title : "") || (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
        ? `Set “${name}” to control the current investigation tool.`
        : `Activate “${name}” to apply this action to the current investigation.`);
      const description = fullDescription.length > 320 ? `${fullDescription.slice(0, 317)}...` : fullDescription;
      if (element === active && (tip?.textContent === description || timer !== undefined)) return;
      hide();
      active = element;
      const showNow = () => {
        if (active !== element) return;
        tip = document.createElement("div");
        tip.className = "tooltip-content global-tooltip";
        tip.id = `whidra-help-${Math.random().toString(36).slice(2)}`;
        tip.setAttribute("role", "tooltip");
        tip.textContent = description;
        previousDescription = element.getAttribute("aria-describedby");
        element.setAttribute("aria-describedby", [previousDescription, tip.id].filter(Boolean).join(" "));
        document.body.append(tip);
        const rect = element.getBoundingClientRect();
        const width = Math.max(0, Math.min(280, window.innerWidth - 24));
        tip.style.width = `${width}px`;
        const height = tip.getBoundingClientRect().height;
        const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2));
        let top = rect.top - height - 8;
        if (top < 8) top = Math.min(window.innerHeight - height - 8, rect.bottom + 8);
        tip.style.left = `${left}px`;
        tip.style.top = `${Math.max(8, top)}px`;
        timer = undefined;
      };
      if (delayed) timer = window.setTimeout(showNow, 450);
      else showNow();
    };
    const pointer = (event: Event) => render(event.target, true);
    const focus = (event: FocusEvent) => render(event.target, false);
    const blur = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node && (event.relatedTarget === active || active?.contains(event.relatedTarget)))) hide();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    document.addEventListener("pointerover", pointer);
    document.addEventListener("focusin", focus);
    document.addEventListener("pointerout", blur);
    document.addEventListener("focusout", blur);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      hide();
      document.removeEventListener("pointerover", pointer);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("pointerout", blur);
      document.removeEventListener("focusout", blur);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);
  return null;
}
