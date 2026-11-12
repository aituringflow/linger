/* Semantic icons for agent tool activity. */
const TOOL_ICON_STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export const iconGlobe = (
  <svg viewBox="0 0 24 24" width="13" height="13" {...TOOL_ICON_STROKE}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c3 3.4 3 14.6 0 18" />
    <path d="M12 3c-3 3.4-3 14.6 0 18" />
  </svg>
);
export const iconTerminal = (
  <svg viewBox="0 0 24 24" width="13" height="13" {...TOOL_ICON_STROKE}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9l3 3-3 3" />
    <path d="M12 15h5" />
  </svg>
);
export const iconFilePlus = (
  <svg viewBox="0 0 24 24" width="13" height="13" {...TOOL_ICON_STROKE}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <path d="M12 11v6" />
    <path d="M9 14h6" />
  </svg>
);
export const iconFile = (
  <svg viewBox="0 0 24 24" width="13" height="13" {...TOOL_ICON_STROKE}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </svg>
);
export const iconSearch = (
  <svg viewBox="0 0 24 24" width="13" height="13" {...TOOL_ICON_STROKE}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </svg>
);
export const iconPencil = (
  <svg viewBox="0 0 24 24" width="13" height="13" {...TOOL_ICON_STROKE}>
    <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </svg>
);
export const iconNotebook = (
  <svg viewBox="0 0 24 24" width="13" height="13" {...TOOL_ICON_STROKE}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M8 3v18" />
    <path d="M12 8h4" />
    <path d="M12 12h4" />
  </svg>
);
export const iconBrowser = (
  <svg viewBox="0 0 24 24" width="13" height="13" {...TOOL_ICON_STROKE}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18" />
    <path d="M7 6.5h.01" />
    <path d="M10 6.5h.01" />
  </svg>
);
export const iconAsk = (
  <svg viewBox="0 0 24 24" width="13" height="13" {...TOOL_ICON_STROKE}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.2 9a2.8 2.8 0 0 1 5.5.8c0 1.9-2.7 2.4-2.7 4" />
    <path d="M12 17.5h.01" />
  </svg>
);

