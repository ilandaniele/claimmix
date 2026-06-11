"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { getT, type Locale, type TranslationKey } from "./index";
import { LOCALE_COOKIE, SUPPORTED_LOCALES, DEFAULT_LOCALE } from "./locale-shared";

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

  // The server re-renders the layout with the cookie locale on every request
  // (router.refresh, navigation, another tab switching the cookie). Follow it:
  // without this sync, client components (Sidebar/TopBar) keep the stale
  // first-hydration locale while server-rendered pages show the new one.
  // Render-phase state adjustment — the pattern react-hooks/set-state-in-effect
  // prescribes for prop-driven resets.
  const [syncedInitial, setSyncedInitial] = useState<Locale>(initialLocale);
  if (syncedInitial !== initialLocale) {
    setSyncedInitial(initialLocale);
    setLocaleState(initialLocale);
  }

  const setLocale = useCallback((next: Locale) => {
    if (!(SUPPORTED_LOCALES as string[]).includes(next)) return;
    setLocaleState(next);
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; SameSite=Lax`;
  }, []);

  // Keep the device cookie aligned with the effective locale. Matters when the
  // locale came from the account preference (users.locale) on a device whose
  // cookie is missing or stale — server components that read only the cookie
  // (getServerLocale) agree from the next request on.
  useEffect(() => {
    document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; SameSite=Lax`;
  }, [locale]);

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
