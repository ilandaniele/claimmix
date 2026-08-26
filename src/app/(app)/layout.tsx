/**
 * App shell layout — wraps all authenticated pages under (app)/ route group.
 *
 * Structure:
 *   - Left sidebar with navigation
 *   - Top bar with user info and command palette trigger
 *   - Main content area
 *
 * This layout is only rendered for authenticated users (enforced by proxy.ts).
 * It fetches the current user's profile (Drizzle) to display name/initials.
 */

import { eq } from "drizzle-orm";

import { getSessionContext } from "@/lib/auth/session";
import { isOperatorEmail } from "@/lib/auth/require-operator";
import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { users } from "@/lib/db/schema";
import { Sidebar } from "./_components/Sidebar";
import { TopBar } from "./_components/TopBar";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";
import { getServerLocale } from "@/lib/i18n/locale";
import { ThemeProvider } from "@/lib/theme/ThemeContext";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionContext();
  const user = session?.user ?? null;

  // Direct lookup by PK — graceful null handling: a missing/failed profile row
  // must never crash the shell (falls back to session email / defaults).
  let userRow: { full_name: string; role: string; locale: string | null } | null =
    null;
  if (user?.id) {
    try {
      userRow = firstRow(
        // sin-inquilino: Ésta es la consulta que AVERIGUA de qué inquilino es la sesión.
        // No puede pasar por una capa que necesita el dato que ella busca.
        await db
          .select({
            full_name: users.full_name,
            role: users.role,
            locale: users.locale,
          })
          .from(users)
          .where(eq(users.id, user.id))
          .limit(1)
      );
    } catch {
      userRow = null;
    }
  }

  const fullName: string = userRow?.full_name ?? user?.email ?? "Analista";
  const role: string = userRow?.role ?? "analyst";
  // Sólo para decidir si el enlace a la cartera aparece. La pantalla se
  // defiende sola con requireOperator: esconder un enlace no es una guarda.
  const isOperator = isOperatorEmail(user?.email);
  // Account preference wins over the device cookie (so the saved language
  // follows the user to any device); cookie/default covers the rest.
  const cookieLocale = await getServerLocale();
  const accountLocale = userRow?.locale;
  const locale =
    accountLocale === "es-AR" || accountLocale === "en-US"
      ? accountLocale
      : cookieLocale;

  return (
    <LocaleProvider locale={locale}>
      <ThemeProvider>
        <div className="flex h-screen overflow-hidden bg-[#F8FAFC] dark:bg-[#0B1120]">
          {/* Left sidebar */}
          <Sidebar role={role} isOperator={isOperator} />

          {/* Main content area */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Top navigation bar */}
            <TopBar fullName={fullName} role={role} />

            {/* Page content */}
            <main className="flex-1 overflow-auto">
              {children}
            </main>
          </div>
        </div>
      </ThemeProvider>
    </LocaleProvider>
  );
}
