"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { zh, type ChatTranslationKey as Key } from "./locales/zh-CN.ts";
import { en } from "./locales/en.ts";

type Translate = (key: Key, values?: Record<string, string | number>) => string;
function translate(locale: "zh-CN" | "en"): Translate {
  const messages = locale === "en" ? en : zh;
  return (key, values) => messages[key].replace(/\{(\w+)\}/g, (match, name: string) => values?.[name] === undefined ? match : String(values[name]));
}
export function translateChat(locale: "zh-CN" | "en", key: Key, values?: Record<string, string | number>): string {
  return translate(locale)(key, values);
}
const ChatI18nContext = createContext<{ locale: "zh-CN" | "en"; t: Translate }>({ locale: "zh-CN", t: translate("zh-CN") });
export function ChatLocaleProvider({ locale, children }: { locale?: "zh-CN" | "en"; children: ReactNode }) {
  const inherited = useContext(ChatI18nContext);
  const effectiveLocale = locale ?? inherited.locale;
  const value = useMemo(() => ({ locale: effectiveLocale, t: translate(effectiveLocale) }), [effectiveLocale]);
  return <ChatI18nContext.Provider value={value}>{children}</ChatI18nContext.Provider>;
}
export function useChatTranslation(): Translate { return useContext(ChatI18nContext).t; }
export function useChatLocale(): "zh-CN" | "en" { return useContext(ChatI18nContext).locale; }
