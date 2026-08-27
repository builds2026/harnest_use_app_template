"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { IconButton } from "@/components/ui";
import { translate, type Locale, type MessageKey } from "@/lib/i18n";

type Theme = "light" | "dark";
type LocaleValue = { locale: Locale; setLocale: (locale: Locale) => void; theme: Theme; setTheme: (theme: Theme) => void; t: (key: MessageKey, values?: Record<string, string | number>) => string };
const LocaleContext = createContext<LocaleValue>({ locale: "en-US", setLocale: () => undefined, theme: "light", setTheme: () => undefined, t: (key, values) => translate("en-US", key, values) });

export function LocaleProvider({ initialLocale, children }: { initialLocale: Locale; children: React.ReactNode }) {
  const [locale, update] = useState(initialLocale);
  const [theme, updateTheme] = useState<Theme>("light");
  const setLocale = (next: Locale) => {
    update(next); document.documentElement.lang = next;
    document.cookie = `arc_locale=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
  };
  const setTheme = (next: Theme) => {
    updateTheme(next); document.documentElement.dataset.theme = next;
    localStorage.setItem("arc_theme", next);
  };
  useEffect(() => {
    const saved = localStorage.getItem("arc_theme");
    const next = saved === "light" || saved === "dark" ? saved : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    // Theme is persisted browser state and is intentionally discovered after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    updateTheme(next); document.documentElement.dataset.theme = next;
  }, []);
  return <LocaleContext.Provider value={{ locale, setLocale, theme, setTheme, t: (key, values) => translate(locale, key, values) }}>{children}</LocaleContext.Provider>;
}

export const useLocale = () => useContext(LocaleContext);

export function LocaleSwitch() {
  const { locale, setLocale, t } = useLocale();
  return <button type="button" className="locale-switch" onClick={() => setLocale(locale === "en-US" ? "ko-KR" : "en-US")} aria-label={t("locale.switch")}>{t("locale.label")}</button>;
}

export function ThemeSwitch() {
  const { theme, setTheme, t } = useLocale();
  const dark = theme === "dark";
  return <IconButton label={t(dark ? "theme.light" : "theme.dark")} onClick={() => setTheme(dark ? "light" : "dark")}><span aria-hidden="true">{dark ? "☀" : "☾"}</span></IconButton>;
}
