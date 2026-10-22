/**
 * /conectar-whatsapp — donde el cliente conecta el WhatsApp de su empresa con su propia
 * cuenta de Meta (Embedded Signup).
 *
 * Vive fuera de `(app)` como /preparando: el número y la WABA están en control y no
 * necesitan la base del cliente, así que se puede conectar mientras ésta se arma. El
 * proxy la trata como cualquier ruta privada y es la única donde la CSP deja pasar
 * el SDK de Facebook.
 *
 * Lo lee todo `leerWabaPublica`, en una sola consulta que no trae secretos. Quien no
 * es admin de un espacio del alta automática, o a quien le toca el camino del código,
 * vuelve a /configuracion: la pantalla no existe para esa persona.
 *
 * `maxDuration` es el de las acciones de esta página: conectar encadena varias
 * llamadas a Graph y el tope por omisión no alcanza.
 */

import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Tarjeta } from "@/app/alta/Tarjeta";
import { filaDeUsuario } from "@/lib/auth/fila-de-usuario-cacheada";
import { ADMIN_ROLES } from "@/lib/auth/roles";
import { getSessionContext } from "@/lib/auth/session";
import { getT, textosDePagina } from "@/lib/i18n";
import { resolveAccountLocale } from "@/lib/i18n/locale";
import { enlaceDeAyuda, leerWabaPublica, metodoDelEspacio } from "@/server/alta/waba-publica";

import { estadoDelNombre, vistaInicial } from "./vista";
import { WabaPropiaPanel } from "./WabaPropiaPanel";

export const maxDuration = 60;

export async function generateMetadata(): Promise<Metadata> {
  const usuario = (await getSessionContext())?.user;
  const fila = usuario ? await filaDeUsuario(usuario.id) : null;
  const locale = await resolveAccountLocale(fila?.locale);
  return { title: `${getT(locale)("waba.titulo")} — ClaimMix` };
}

export default async function ConectarWhatsappPage() {
  const usuario = (await getSessionContext())?.user;
  if (!usuario) redirect("/login");
  const fila = await filaDeUsuario(usuario.id);
  if (!fila) redirect("/pendiente");

  const w = await leerWabaPublica(fila.tenant_id);
  const metodo = metodoDelEspacio({
    conWaba: w?.conWaba ?? false,
    idEnLaPlataforma: w?.idEnLaPlataforma ?? false,
    esAdmin: (ADMIN_ROLES as string[]).includes(fila.role),
    autoalta: fila.autoalta === true,
    yaConectado: w?.numero === "conectado",
    origen: w?.origen,
  });
  // Quien ya empezó con su propia app, o sólo tiene esa vía, sigue en su asistente.
  if (metodo === "app") redirect("/conectar-whatsapp/app");
  if (metodo !== "propia") redirect("/configuracion");

  const locale = await resolveAccountLocale(fila.locale);
  const t = getT(locale);

  return (
    <Tarjeta titulo={t("waba.titulo")} locale={locale} etiquetaSalir={t("alta.salir")}>
      <WabaPropiaPanel
        locale={locale}
        textos={textosDePagina(locale)}
        nombre={w?.nombre ?? ""}
        numeroTipeado={w?.numeroTipeado ?? null}
        inicial={vistaInicial(w)}
        conectado={{
          numero: w?.numeroMeta ?? w?.numeroTipeado ?? null,
          nombre: estadoDelNombre(w?.nombreEstado ?? null),
          plantilla: w?.plantilla ?? false,
        }}
        ayuda={enlaceDeAyuda(t, { tenantId: fila.tenant_id, wabaId: w?.wabaId ?? null })}
      />
    </Tarjeta>
  );
}
