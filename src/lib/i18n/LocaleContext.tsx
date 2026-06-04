"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { getT, type Locale, type TranslationKey } from "./index";
import { LOCALE_COOKIE, SUPPORTED_LOCALES, DEFAULT_LOCALE } from "./locale";

interface LocaleContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey) => string;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: DEFAULT_LOCALE,
  setLocale: () => {},
  t: getT(DEFAULT_LOCALE),
});

export function LocaleProvider({
  locale: initialLocale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  const setLocale = useCallback((next: Locale) => {
    if (!(SUPPORTED_LOCALES as string[]).includes(next)) return;
    setLocaleState(next);
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; SameSite=Lax`;
  }, []);

  const tFn = useMemo(() => getT(locale), [locale]);

  return (
    <LocaleContext.Provider value={{ locale, setLocale, t: tFn }}>
      {children}
    </LocaleContext.Provider>
  );
}

/** Hook for client components — returns locale-aware t() and locale controls. */
export function useLocale() {
  return useContext(LocaleContext);
}

/** Convenience hook — returns just the t() function for client components. */
export function useT() {
  return useContext(LocaleContext).t;
}
