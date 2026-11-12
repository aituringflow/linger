import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLauncher } from './state';
import { zhCN, type TranslationKey } from './locales/zh-CN';
import { en } from './locales/en';

type Locale = 'zh-CN' | 'en';
type I18n = { locale: Locale; t: (key: TranslationKey, params?: Record<string, string | number>) => string };
const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { state } = useLauncher();
  const [systemLanguage, setSystemLanguage] = useState(() => navigator.language);
  useEffect(() => {
    const update = () => setSystemLanguage(navigator.language);
    window.addEventListener('languagechange', update);
    return () => window.removeEventListener('languagechange', update);
  }, []);
  const preference = state.launcher?.language;
  const locale: Locale = preference === 'zh-CN' || preference === 'en'
    ? preference : systemLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const value = useMemo<I18n>(() => {
    const messages: Record<TranslationKey, string> = locale === 'en' ? en : zhCN;
    return { locale, t: (key, params) => (messages[key] ?? zhCN[key]).replace(/\{(\w+)\}/g, (match, name: string) => params?.[name] === undefined ? match : String(params[name])) };
  }, [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useTranslation(): I18n {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useTranslation requires I18nProvider');
  return context;
}
