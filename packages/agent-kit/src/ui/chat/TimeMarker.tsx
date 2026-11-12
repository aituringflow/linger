import { translateChat, useChatLocale } from "./i18n.tsx";

const GAP_MS = 5 * 60 * 1000;

function validDate(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** WeChat-style timeline: first dated message, a new day, or a pause in the conversation. */
export function shouldShowTimeMarker(current?: string | null, previous?: string | null): boolean {
  const next = validDate(current);
  if (!next) return false;
  const prev = validDate(previous);
  if (!prev) return true;
  return next.toDateString() !== prev.toDateString() || next.getTime() - prev.getTime() >= GAP_MS;
}

export function formatTimeMarker(value: string, now = new Date(), locale: "zh-CN" | "en" = "zh-CN"): string {
  const date = validDate(value);
  if (!date) return "";
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (days === 0) return time;
  if (days === 1) return translateChat(locale, "yesterday", { time });
  if (days >= 2 && days < 7) return `${new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date)} ${time}`;
  const dateLabel = new Intl.DateTimeFormat(locale, { year: date.getFullYear() === now.getFullYear() ? undefined : "numeric", month: "long", day: "numeric" }).format(date);
  return `${dateLabel} ${time}`;
}

export default function TimeMarker({ at }: { at: string }) {
  const locale = useChatLocale();
  const label = formatTimeMarker(at, new Date(), locale);
  return <div className="chat-time-marker" role="separator" aria-label={label}><time dateTime={at}>{label}</time></div>;
}
