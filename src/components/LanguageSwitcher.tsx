"use client";

import { useRouter } from "next/navigation";
import { useLocale } from "@/lib/i18n/LocaleContext";
import type { Locale } from "@/lib/i18n";

const LOCALE_LABELS: Record<Locale, string> = {
  "es-AR": "ES",
  "en-US": "EN",
};

export function LanguageSwitcher() {
  const { locale, setLocale } = useLocale();
  const router = useRouter();

  function handleSwitch(next: Locale) {
    if (next === locale) return;
    setLocale(next);
    // Persist per account (applied on any device at next login). Fire-and-forget:
    // the cookie already covers this device even if the request fails.
    void fetch("/api/auth/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: next }),
    }).catch(() => {});
    router.refresh();
  }

  return (
    <div
      className="flex items-center rounded-md border border-slate-200 overflow-hidden text-xs font-medium"
      role="group"
      aria-label="Language"
    >
      {(Object.keys(LOCALE_LABELS) as Locale[]).map((loc) => (
        <button
          key={loc}
          onClick={() => handleSwitch(loc)}
          aria-pressed={locale === loc}
          className={[
            "px-2 py-1 transition-colors",
            locale === loc
              ? "bg-slate-800 text-white"
              : "bg-white text-slate-500 hover:bg-slate-50 hover:text-slate-900",
          ].join(" ")}
        >
          {LOCALE_LABELS[loc]}
        </button>
      ))}
    </div>
  );
}
