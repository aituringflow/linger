import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Option = { value: string; label: string; disabled?: boolean };

/** Compact themed select for settings; the menu escapes scrollable dialogs. */
export default function SettingsSelect({ label, value, options, disabled, placeholder, onChange }: {
  label: string; value: string; options: Option[]; disabled?: boolean; placeholder?: string; onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const current = options.find(option => option.value === value);
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const showAbove = below < 180 && above > below;
      const maxHeight = Math.max(80, Math.min(260, showAbove ? above - 6 : below - 6));
      setPosition({ left: rect.left, ...(showAbove ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }), width: rect.width, maxHeight });
    };
    const onPointer = (event: MouseEvent) => { if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    place(); document.addEventListener("mousedown", onPointer); document.addEventListener("keydown", onKey);
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { document.removeEventListener("mousedown", onPointer); document.removeEventListener("keydown", onKey); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  return <div className="memory-select">
    <span className="memory-select-label">{label}</span>
    <button ref={trigger} type="button" className="memory-select-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>("button[aria-selected=true]:not(:disabled), button:not(:disabled)")?.focus()); } }}>
      <span>{current?.label ?? (value || placeholder)}</span><svg className="memory-select-chevron" aria-hidden="true" viewBox="0 0 16 16" fill="none"><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open && position ? createPortal(<div ref={menu} className="memory-select-menu" role="listbox" aria-label={label} style={{ position: "fixed", ...position }} onKeyDown={event => { if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return; event.preventDefault(); const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []); const index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus(); }}>
      {options.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} className={`memory-select-option${option.value === value ? " is-selected" : ""}`} onClick={() => { setOpen(false); onChange(option.value); trigger.current?.focus(); }}>
        <span>{option.label}</span>{option.value === value ? <span aria-hidden="true">✓</span> : null}
      </button>)}
    </div>, document.body) : null}
  </div>;
}
