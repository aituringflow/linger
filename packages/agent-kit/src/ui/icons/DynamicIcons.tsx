/** Icons whose geometry or state depends on the current UI value. */
export function ContextMeterIcon({ radius, circumference, offset }: { radius: number; circumference: number; offset: number }) {
  return <svg viewBox="0 0 18 18" aria-hidden="true">
    <circle className="ctx-meter-track" cx="9" cy="9" r={radius} />
    <circle className="ctx-meter-bar" cx="9" cy="9" r={radius} strokeDasharray={circumference} strokeDashoffset={offset} />
  </svg>;
}

export function ProgressRingIcon({ percent }: { percent: number | null }) {
  return <svg className={`desktop-update-progress${percent === null ? " is-indeterminate" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
    <circle className="desktop-update-progress-track" cx="12" cy="12" r="9" />
    <circle className="desktop-update-progress-value" cx="12" cy="12" r="9"
      style={percent === null ? undefined : { strokeDasharray: `${2 * Math.PI * 9}`, strokeDashoffset: `${2 * Math.PI * 9 * (1 - percent / 100)}` }} />
  </svg>;
}

export function ThinkingChevronIcon({ open }: { open: boolean }) {
  return <svg viewBox="0 0 24 24"><polyline points={open ? "6 9 12 15 18 9" : "9 6 15 12 9 18"} /></svg>;
}

export function PermissionIcon({ full }: { full: boolean }) {
  return <svg className="chat-permission-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 19 6v5c0 4.5-2.8 8.3-7 10-4.2-1.7-7-5.5-7-10V6l7-3z" />{full ? <><path d="M12 8v5" /><path d="M12 16h.01" /></> : <path d="m9 12 2 2 4-4" />}</svg>;
}

export function NavigationHomeIcon({ selected }: { selected: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
    <path d="M2.5 10.5 11.1 3.4a1.4 1.4 0 0 1 1.8 0l8.6 7.1" fill={selected ? "currentColor" : "none"} />
    <path d="M5.2 10.4v9.1c0 .8.6 1.5 1.5 1.5h3.3v-7.2h4V21h3.3c.9 0 1.5-.7 1.5-1.5v-9.1" fill={selected ? "currentColor" : "none"} stroke={selected ? "none" : "currentColor"} />
  </svg>;
}

export function NavigationLibraryIcon({ selected }: { selected: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinejoin="round"><rect x="7" y="7" width="14" height="14" rx="2.5" fill={selected ? "currentColor" : "none"} fillOpacity={selected ? .18 : 0} /><path d="M4.5 17A2.5 2.5 0 0 1 2 14.5v-10A2.5 2.5 0 0 1 4.5 2h10A2.5 2.5 0 0 1 17 4.5" /><circle cx="16" cy="11.5" r="1" fill="currentColor" stroke="none" /><path d="m8 18 4-4 2.3 2.3 2-2L21 19" /></svg>;
}

/** Based on Phosphor's user-list silhouette; colors follow the sidebar theme. */
export function NavigationContactsIcon({ selected }: { selected: boolean }) {
  return <svg viewBox="0 0 256 256" aria-hidden="true" fill="none">
    {selected ? <path fill="currentColor" d="M109.29 142a48 48 0 1 0-58.58 0C30.09 150.73 13.84 168.3 8.25 190A8 8 0 0 0 16 200h128a8 8 0 0 0 7.75-10c-5.59-21.7-21.84-39.27-42.46-48Z" />
      : <><circle cx="80" cy="104" r="40" stroke="currentColor" strokeWidth="16" />
        <path d="M16 192c8-27 33-48 64-48s56 21 64 48" stroke="currentColor" strokeWidth="16" strokeLinecap="round" /></>}
    <path d="M160 88h72M160 136h56" stroke="currentColor" strokeWidth="16" strokeLinecap="round" />
  </svg>;
}

const upPath = "M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3";
const downPath = "M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17";
// Both parts are closed and solid, with a narrow gap separating the cuff from the hand.
const solidUpPath = "M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3Z";
export function FeedbackVoteIcon({ vote, selected = false }: { vote?: "up" | "down" | null; selected?: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className={selected ? "chat-fb-icon-selected" : undefined}>{vote ? selected
    ? <g transform={vote === "down" ? "rotate(180 12 12)" : undefined}><path d={solidUpPath} /><rect x="2" y="11" width="4" height="11" rx="1.5" /></g>
    : <path d={vote === "up" ? upPath : downPath} /> : <>
    <g transform="translate(0 1) scale(.62)"><path d={upPath} /></g>
    <g transform="translate(10 9) scale(.62)"><path d={downPath} /></g>
  </>}</svg>;
}


export function FeedbackCopyIcon({ copied }: { copied: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{copied ? <path d="m5 12 4 4L19 6" /> : <><rect x="3" y="8" width="13" height="13" rx="3" /><path d="M8 8V6a3 3 0 0 1 3-3h7a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3h-2" /></>}</svg>;
}
