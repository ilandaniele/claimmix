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

import { getSessionContext } from "@/lib/auth/session";
import { isOperatorEmail } from "@/lib/auth/require-operator";
import { getUserRow } from "@/lib/auth/user-row";
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
          {/*
           * La primera parada de teclado de todas las pantallas del turno.
           *
           * Antes de esto, llegar al contenido costaba recorrer la barra
           * entera en CADA navegación: entre once y catorce paradas según el
           * rol —la barra, los dos idiomas, el tema y «Cerrar sesión»—. Es el
           * bloque repetido del que habla el criterio 2.4.1 de WCAG, que es
           * nivel A.
           *
           * Va arriba de todo porque lo único que lo hace servir es ser el
           * PRIMER elemento enfocable del documento: cualquier control que se
           * meta antes lo vuelve decorativo.
           *
           * `<a>` pelado y no `<Link>`: el salto tiene que ser navegación de
           * fragmento del navegador, que es lo que además mueve el foco al
           * destino. Con `<Link>` la ruta la maneja el cliente, la URL cambia
           * y el foco se queda donde estaba.
           *
           * Escondido fuera de pantalla y no con `hidden` ni `display:none`:
           * tiene que existir para el lector de pantalla. Se destapa con
           * `focus:translate-y-0`. `fixed` y no `absolute` porque el
           * contenedor de al lado tiene `overflow-hidden`.
           */}
          <a
            href="#contenido"
            className="fixed top-3 left-3 z-50 -translate-y-[200%] rounded-xl bg-violet-600 px-4 py-2 text-[13.5px] font-semibold text-white shadow-lg transition-transform focus:translate-y-0"
          >
            {t("nav.saltarAlContenido")}
          </a>

          {/* Left sidebar */}
          <Sidebar role={role} isOperator={isOperator} />

          {/* Main content area */}
          <div className="flex flex-1 flex-col overflow-hidden">
            {/* Top navigation bar */}
            <TopBar fullName={fullName} role={role} />

            {/* Page content */}
            {/*
             * `tabIndex={-1}` para que el salto TERMINE acá: sin él, el
             * navegador mueve el scroll pero el foco se queda en la barra y
             * el siguiente Tab vuelve al principio. No entra en el orden de
             * tabulación —es -1, no 0—. El anillo que dibuja el navegador al
             * llegar se deja a propósito: es la única señal de que el salto
             * ocurrió.
             */}
            <main id="contenido" tabIndex={-1} className="flex-1 overflow-auto">
              {children}
            </main>
          </div>
        </div>
      </ThemeProvider>
    </LocaleProvider>
  );
}
