"use client";

import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
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
  const isAdmin = role === "admin" || role === "owner";
  const roleLabel =
    role === "owner"
      ? "Owner"
      : role === "admin"
        ? t("role.admin") || "Administrador"
        : role === "specialist"
          ? "Especialista"
          : role === "viewer"
            ? "Visor"
            : t("role.analyst") || "Analista";

  return (
    <header className="flex h-12 flex-shrink-0 items-center justify-end border-b border-[#EEF0F3] bg-white px-4 dark:border-[#1E2D45] dark:bg-[#0F1929]">
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <LanguageSwitcher />

        {/* divider */}
        <div className="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700" />

        {/* Avatar */}
        <div
          aria-label={`Avatar ${fullName}`}
          className="flex h-7 w-7 flex-shrink-0 select-none items-center justify-center rounded-full bg-indigo-600 text-xs font-semibold text-white"
        >
          {initials}
        </div>

        {/* Full name — hidden on mobile */}
        <span className="hidden text-sm font-medium text-slate-900 sm:inline dark:text-slate-100">
          {fullName}
        </span>

        {/* Role badge */}
        <span
          className={[
            "hidden rounded-full px-2 py-0.5 text-[12px] font-medium sm:inline",
            isAdmin
              ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-400"
              : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400",
          ].join(" ")}
        >
          {roleLabel}
        </span>

        {/* Sign out icon button */}
        <button
          onClick={handleSignOut}
          data-testid="signout-button"
          className="flex h-7 w-7 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100"
          aria-label={t("nav.signOut") || "Cerrar sesión"}
        >
          <LogOut size={16} />
        </button>
      </div>
    </header>
  );
}
