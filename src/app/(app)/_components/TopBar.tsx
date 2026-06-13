"use client";

import { useRouter } from "next/navigation";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useT } from "@/lib/i18n/LocaleContext";
import { authClient } from "@/lib/auth/client";

interface TopBarProps {
  fullName: string;
  role: string;
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0]?.toUpperCase() ?? "")
    .join("");
}

export function TopBar({ fullName, role }: TopBarProps) {
  const router = useRouter();
  const t = useT();

  async function handleSignOut() {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  }

  const initials = getInitials(fullName);
  const roleLabel = role === "admin" ? t("role.admin") : t("role.analyst");

  return (
    <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-6">
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-400" aria-label="Command shortcut">
          <kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-xs text-slate-500">
            Ctrl K
          </kbd>
        </span>
      </div>

      <div className="flex items-center gap-3">
        <ThemeToggle />
        <LanguageSwitcher />
        <div className="hidden text-right sm:block">
          <p className="text-sm font-medium leading-none text-slate-900">{fullName}</p>
          <p className="mt-0.5 text-xs text-slate-500">{roleLabel}</p>
        </div>

        <div
          aria-label={`Avatar ${fullName}`}
          className="flex h-8 w-8 select-none items-center justify-center rounded-full bg-slate-800 text-xs font-semibold text-white"
        >
          {initials}
        </div>

        <button
          onClick={handleSignOut}
          data-testid="signout-button"
          className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
          aria-label={t("nav.signOut")}
        >
          {t("nav.signOut")}
        </button>
      </div>
    </header>
  );
}
