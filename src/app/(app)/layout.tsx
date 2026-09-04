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
import { getUserRow } from "@/lib/auth/user-row";
import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { users } from "@/lib/db/schema";
import { Sidebar } from "./_components/Sidebar";
import { TopBar } from "./_components/TopBar";
import { getT } from "@/lib/i18n";
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
  // La misma fila que despues pide la pagina: `getUserRow` la dedupe por
  // pedido, asi que entre el layout y la pagina la base la entrega una vez.
  if (user?.id) userRow = await getUserRow(user.id);

  // El nombre en el idioma del usuario, así que se resuelve DESPUÉS del
  // locale — ver más abajo, donde la preferencia de la cuenta le gana a la
  // cookie del dispositivo.
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
  const t = getT(locale);
  const fullName: string = userRow?.full_name ?? user?.email ?? t("layout.nombreFallback");

  return (
    <LocaleProvider locale={locale}>
      <ThemeProvider>
        {/*
         * `lienzo` en vez del gris plano: el lavado lavanda que hace que las
         * tarjetas se lean como si flotaran. Va como clase porque la CSP no
         * acepta `style=` — ver `globals.css`.
         */}
        <div className="lienzo flex h-screen overflow-hidden">
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
