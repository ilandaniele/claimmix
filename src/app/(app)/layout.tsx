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

import { Suspense } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { esPlanPro } from "@/core/billing/plan-pro";
import { basePorCliente } from "@/data/bases";
import { olvidarFilaDeUsuario } from "@/lib/auth/fila-de-usuario-cacheada";
import { getSessionContext } from "@/lib/auth/session";
import { esOperadorDe } from "@/lib/auth/require-operator";
import { ADMIN_ROLES } from "@/lib/auth/roles";
import { getUserRowOrThrow, type UserRow } from "@/lib/auth/user-row";
import { Sidebar } from "./_components/Sidebar";
import { TopBar } from "./_components/TopBar";
import { AsistenteFlotante } from "./_components/AsistenteFlotante";
import { EstadoDelAgente } from "./_components/EstadoDelAgente";
import { getT } from "@/lib/i18n";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";
import { resolveAccountLocale } from "@/lib/i18n/locale";
import { ThemeProvider } from "@/lib/theme/ThemeContext";

/** Cada pantalla pone su nombre y el layout le suma la marca: «Bandeja — ClaimMix». */
export const metadata: Metadata = { title: { template: "%s — ClaimMix", default: "ClaimMix" } };

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSessionContext();
  const user = session?.user ?? null;

  // Direct lookup by PK — graceful null handling: a missing/failed profile row
  // must never crash the shell (falls back to session email / defaults).
  let userRow: UserRow | null = null;
  // La misma fila que despues pide la pagina: `getUserRowOrThrow` la dedupe
  // por pedido, asi que entre el layout y la pagina la base la entrega una vez.
  let filaLeida = false;
  if (user?.id) {
    try {
      userRow = await getUserRowOrThrow(user.id);
      filaLeida = true;
    } catch {
      // La base no respondió: el shell sigue con valores por defecto, como antes.
    }
  }
  // Sesión sin fila de `users`: cuenta creada sin acceso. Fuera del try.
  if (filaLeida && !userRow) redirect("/pendiente");
  // Con una base por cliente el espacio no sirve hasta que su base está lista. Se olvida la fila de
  // esta instancia: si ya estaba lista y la copia era vieja, /preparando la devuelve y no rebota.
  if (userRow && basePorCliente() && userRow.base !== "lista") {
    olvidarFilaDeUsuario(userRow.id);
    redirect("/preparando");
  }

  // El nombre en el idioma del usuario, así que se resuelve DESPUÉS del
  // locale — ver más abajo, donde la preferencia de la cuenta le gana a la
  // cookie del dispositivo.
  const role: string = userRow?.role ?? "analyst";
  // Sólo para decidir si los enlaces del operador (cartera, altas) aparecen.
  // Las pantallas se defienden solas con requireOperator: esconder un enlace
  // no es una guarda. La regla es la de la guarda (mail verificado, de la lista
  // y del espacio de la casa, con rol de admin): con sólo el mail, la barra
  // ofrecía pantallas que rebotaban. Sin la fila no hay espacio ni rol que
  // comparar, y falla cerrado.
  const isOperator =
    user && userRow && (ADMIN_ROLES as string[]).includes(userRow.role)
      ? esOperadorDe(user, userRow.tenant_id)
      : false;
  // Account preference wins over the device cookie (so the saved language
  // follows the user to any device); cookie/default covers the rest.
  const locale = await resolveAccountLocale(userRow?.locale);
  const t = getT(locale);
  const fullName: string = userRow?.full_name ?? user?.email ?? t("layout.nombreFallback");
  const esPro = esPlanPro(userRow?.plan);

  return (
    <LocaleProvider locale={locale}>
      <ThemeProvider>
        {/*
         * `lienzo` en vez del gris plano: el lavado lavanda que hace que las
         * tarjetas se lean como si flotaran. Va como clase porque la CSP no
         * acepta `style=` — ver `globals.css`.
         */}
        {/*
          El idioma de ESTA parte, que no es el del documento.

          El layout raíz escribe `lang="es-AR"` fijo, y está bien: `/login`,
          `/registro` y `/recuperar` tienen el texto en castellano escrito a
          mano. Pero acá adentro la interfaz puede estar en inglés —la
          preferencia de la cuenta le gana a la cookie, unas líneas arriba— y
          con el idioma equivocado un lector de pantalla lee todo con fonemas
          castellanos.

          Es SC 3.1.2, «Language of Parts»: la parte que cambia lo declara.
        */}
        <div lang={locale} className="lienzo flex h-screen overflow-hidden">
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

          {/*
           * Sólo el booleano: el nombre del plan es dato de admin, y todo lo
           * que recibe la barra viaja al navegador de cualquier rol.
           */}
          <Sidebar
            role={role}
            isOperator={isOperator}
            esPro={esPro}
            estadoDelAgente={
              userRow?.tenant_id ? (
                <Suspense fallback={null}>
                  <EstadoDelAgente tenantId={userRow.tenant_id} locale={locale} />
                </Suspense>
              ) : null
            }
          />

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

          {esPro && <AsistenteFlotante />}
        </div>
      </ThemeProvider>
    </LocaleProvider>
  );
}
