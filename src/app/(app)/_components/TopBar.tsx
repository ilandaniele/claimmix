/**
 * Top navigation bar for the analyst dashboard.
 *
 * Features per AC11:
 *   - User initials avatar (e.g. "LR" for Lucía Ramallo)
 *   - User name + role display
 *   - Sign out action
 *
 * Design: white background, slate-900 text, right-aligned user section.
 */

"use client";

import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";

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

function getRoleLabel(role: string): string {
  return role === "admin" ? "Administrador" : "Analista";
}

export function TopBar({ fullName, role }: TopBarProps) {
  const router = useRouter();

  async function handleSignOut() {
    await supabaseBrowser.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  const initials = getInitials(fullName);
  const roleLabel = getRoleLabel(role);

  return (
    <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-6">
      {/* Left: page title placeholder — overridden by individual pages */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-400" aria-label="Atajo de comandos">
          <kbd className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-xs font-mono text-slate-500">
            ⌘K
          </kbd>
        </span>
      </div>

      {/* Right: language switcher + user info + sign out */}
      <div className="flex items-center gap-3">
        <LanguageSwitcher />
        {/* User name + role */}
        <div className="hidden sm:block text-right">
          <p className="text-sm font-medium text-slate-900 leading-none">{fullName}</p>
          <p className="text-xs text-slate-500 mt-0.5">{roleLabel}</p>
        </div>

        {/* Initials avatar */}
        <div
          aria-label={`Avatar de ${fullName}`}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-800 text-xs font-semibold text-white select-none"
        >
          {initials}
        </div>

        {/* Sign out button */}
        <button
          onClick={handleSignOut}
          data-testid="signout-button"
          className="rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors"
          aria-label="Cerrar sesión"
        >
          Salir
        </button>
      </div>
    </header>
  );
}
