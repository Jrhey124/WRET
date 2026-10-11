import { useEffect } from "react";

const help: Record<string, string> = {
  "Open project":"Open a Whidra archive and restore its evidence, findings, and notes. Existing WRET archives are supported.",
  "Export project":"Download the current investigation as a portable Whidra archive.",
  "Import files":"Add evidence files to this investigation.",
  "Import evidence files":"Add evidence files to this investigation.",
  "Import site folder":"Import a site folder and preserve its relative file paths.",
  "New project":"Start a separate investigation after confirming the current project is no longer needed.",
  "Analyze again":"Run static analysis again on the selected evidence.",
  "Annotate":"Add a note linked to the selected evidence range.",
  "Export Markdown report":"Download a readable Whidra Markdown summary of retained findings and notes.",
  "Export portable project":"Download a Whidra archive that can be reopened later.",
  "Collect website evidence":"Follow Chrome or Edge collection instructions and import recorded evidence for offline review.",
  "Open saved project":"Choose a previously exported Whidra or WRET archive.",
  "Project name":"Rename this investigation. The name is included in its archive and report.",
  "Project search":"Search names and text across imported evidence.",
  "Analyst note":"Write an observation attached to the selected evidence or project.",
  "Note type":"Choose whether this note is a comment, finding, or label.",
  "Encoded input":"Enter encoded text to inspect possible decoding operations.",
  "Decoding operation":"Choose a reversible transform to apply to the encoded input.",
  "Hex byte offset":"Jump to a byte offset in the original evidence.",
  "Evidence views":"Switch between source, byte, formatted, syntax, graph, and decoding views.",
  "Command palette":"Find navigation and common project actions. Press Escape to close.",
};

function labelOf(element: HTMLElement) {
  const associatedLabel = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
    ? element.labels?.[0]?.innerText
    : element.closest("label")?.innerText;
  return (element.getAttribute("aria-label") || element.getAttribute("placeholder") || associatedLabel || element.innerText || element.getAttribute("title") || element.tagName)
    .replace(/[+↗→]/g, "").replace(/\s+/g, " ").trim();
}

/** Adds consistent hover and keyboard help to every interactive workbench control. */
export function GlobalTooltips() {
  useEffect(() => {
    let active: HTMLElement | undefined;
    let tip: HTMLDivElement | undefined;
    const hide = () => {
      active?.removeAttribute("aria-describedby");
      tip?.remove();
      active = undefined;
      tip = undefined;
    };
    const show = (target: EventTarget | null) => {
      const element = (target as HTMLElement | null)?.closest<HTMLElement>("button,input,select,textarea,[role=button],summary");
      if (!element || element.closest(".tooltip-anchor") || element.closest(".tooltip-content") || element.closest(".command-backdrop") || (element instanceof HTMLInputElement && element.type === "hidden")) return hide();
      const name = labelOf(element);
      const description = element.getAttribute("title") || help[name] || (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
        ? `Set “${name}” to control the current investigation tool.`
        : `Activate “${name}” to apply this action to the current investigation.`);
      if (element === active && tip?.textContent === description) return;
      hide();
      active = element;
      tip = document.createElement("div");
      tip.className = "tooltip-content global-tooltip";
      tip.id = `wret-help-${Math.random().toString(36).slice(2)}`;
      tip.setAttribute("role", "tooltip");
      tip.textContent = description;
      element.setAttribute("aria-describedby", tip.id);
      document.body.append(tip);
      const rect = element.getBoundingClientRect();
      const width = Math.min(280, window.innerWidth - 24);
      tip.style.width = `${width}px`;
      let left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2));
      let top = rect.top - tip.offsetHeight - 8;
      if (top < 8) top = Math.min(window.innerHeight - tip.offsetHeight - 8, rect.bottom + 8);
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
      tip.style.bottom = "auto";
      tip.style.transform = "none";
    };
    const pointer = (event: Event) => show(event.target);
    const blur = (event: FocusEvent) => {
      if (!(event.relatedTarget instanceof Node && (event.relatedTarget === active || active?.contains(event.relatedTarget)))) hide();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") hide(); };
    document.addEventListener("pointerover", pointer);
    document.addEventListener("focusin", pointer);
    document.addEventListener("pointerout", blur);
    document.addEventListener("focusout", blur);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      hide();
      document.removeEventListener("pointerover", pointer);
      document.removeEventListener("focusin", pointer);
      document.removeEventListener("pointerout", blur);
      document.removeEventListener("focusout", blur);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);
  return null;
}
