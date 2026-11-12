"use client";

import { useEffect } from "react";

export type MobileChoice = { key: string; label: string; credits?: string };

export function MobileChoiceDialog({ title, choices, value, disabled, onChoose, onClose }: {
  title: string;
  choices: readonly MobileChoice[];
  value: string;
  disabled?: boolean;
  onChoose: (key: string) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return <div className="chat-mobile-choice-backdrop" onClick={onClose}>
    <section className="chat-mobile-choice-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <div className="chat-mobile-choice-head">
        <strong>{title}</strong>
        <button type="button" onClick={onClose} aria-label="关闭">×</button>
      </div>
      <div className="chat-mobile-choice-list">
        {choices.map((choice) => <button key={choice.key} type="button" disabled={disabled}
          className={`chat-mobile-choice-item${choice.key === value ? " is-selected" : ""}`}
          aria-current={choice.key === value ? "true" : undefined}
          onClick={() => { onChoose(choice.key); onClose(); }}>
          <span className="chat-mobile-choice-label" title={choice.label}>{choice.label}</span>
          <span className="chat-mobile-choice-extra">
            {choice.credits ? <span className="chat-mobile-choice-credits">{choice.credits}</span> : null}
            <span className="chat-mobile-choice-check" aria-hidden="true">{choice.key === value ? "✓" : ""}</span>
          </span>
        </button>)}
      </div>
    </section>
  </div>;
}
