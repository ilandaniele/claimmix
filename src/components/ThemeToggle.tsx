"use client";

import { useT } from "@/lib/i18n/LocaleContext";
import { useTheme } from "@/lib/theme/ThemeContext";

export function ThemeToggle() {
  const t = useT();
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900"
      aria-label={isDark ? t("theme.light") : t("theme.dark")}
      title={isDark ? t("theme.light") : t("theme.dark")}
    >
      <span aria-hidden="true">{isDark ? "L" : "D"}</span>
      <span className="sr-only">{t("theme.toggle")}</span>
    </button>
  );
}
