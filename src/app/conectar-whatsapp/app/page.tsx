/**
 * /conectar-whatsapp/app — donde el cliente conecta el WhatsApp de su empresa con la app de Meta
 * que creó él mismo (la vía «app propia»).
 *
 * Vive fuera de `(app)` como /conectar-whatsapp, por lo mismo: el número y la WABA están en control.
 * Lo lee todo `almacenDelInquilino(...).leer()`, en una sola consulta; los secretos de la fila
 * (token, PIN, secreto de la app) se abren ahí pero nunca salen de esta página: al panel sólo
 * llega `estadoPublico`.
 *
 * Quien ya conectó por el popup de Meta vuelve a /conectar-whatsapp con una carga completa (ver
 * `CargaCompleta`: la CSP del popup es de esa ruta), y quien no es admin de un
 * espacio del alta automática, o no tiene la vía prendida y todavía no empezó, a /configuracion#whatsapp.
 * Una fila viva de esta vía se muestra aunque la bandera se apague: la persona ve lo que ya tiene.
 *
 * `maxDuration` es el de las acciones de la página: conectar encadena varias llamadas a Graph.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { Tarjeta } from "@/app/alta/Tarjeta";
import { ipValida } from "@/lib/audit/log";
import { filaDeUsuario } from "@/lib/auth/fila-de-usuario-cacheada";
import { ADMIN_ROLES } from "@/lib/auth/roles";
import { getSessionContext } from "@/lib/auth/session";
import { getT, textosDePagina } from "@/lib/i18n";
import { resolveAccountLocale } from "@/lib/i18n/locale";
import { clientIpFromHeaders } from "@/lib/rate-limit/index";
import { estadoPublico, legalesDeApp, pasoDelAsistente, webhookDeLaFila } from "@/server/alta/app-propia";
import { almacenDelInquilino, esDeApp, yaConectada } from "@/server/alta/waba-propia";
import { appPropia } from "@/server/alta/waba-propia-activa";
import { enlaceDeAyuda } from "@/server/alta/waba-publica";

import { AppPropiaPanel } from "./AppPropiaPanel";
import { CargaCompleta } from "./CargaCompleta";

const VUELTA = "/configuracion#whatsapp";

export const maxDuration = 60;

export const metadata = { title: "Conectar WhatsApp — ClaimMix" };

export default async function ConectarWhatsappAppPage() {
  const usuario = (await getSessionContext())?.user;
  if (!usuario) redirect("/login");
  const fila = await filaDeUsuario(usuario.id);
  if (!fila) redirect("/pendiente");
  if (!(ADMIN_ROLES as string[]).includes(fila.role) || fila.autoalta !== true) redirect(VUELTA);

  const locale = await resolveAccountLocale(fila.locale);
  const w = await almacenDelInquilino({
    tenantId: fila.tenant_id,
    userId: fila.id,
    ip: ipValida(clientIpFromHeaders(await headers())),
    idioma: locale,
  }).leer();

  const viva = w !== null && w.estado !== null && w.estado !== "cancelada" && w.estado !== "revocada";
  if (!viva && (!appPropia() || (w !== null && yaConectada(w)))) redirect(VUELTA);

  const t = getT(locale);
  // Un `redirect()` acá, llegado por `router.refresh()`, es una navegación del lado del cliente y se queda
  // con la CSP de esta ruta, que no deja cargar el SDK de Meta de /conectar-whatsapp: hace falta documento nuevo.
  if (viva && !esDeApp(w)) {
    return (
      <Tarjeta titulo={t("waba.titulo")} locale={locale} etiquetaSalir={t("alta.salir")}>
        <CargaCompleta destino="/conectar-whatsapp" texto={t("waba.continuar")} />
      </Tarjeta>
    );
  }

  const paso = pasoDelAsistente(w);
  const empresa = w?.nombreDelEspacio ?? "";
  const webhook = w && (paso === "P1B" || paso === "E14" || paso === "seguir") ? webhookDeLaFila(w) : null;

  return (
    <Tarjeta titulo={t("appPropia.titulo")} locale={locale} etiquetaSalir={t("alta.salir")}>
      <AppPropiaPanel
        paso={paso}
        estado={estadoPublico(w)}
        numeroTipeado={w?.numeroTipeado ?? null}
        empresa={empresa}
        locale={locale}
        textos={textosDePagina(locale)}
        ayuda={enlaceDeAyuda(t, {
          tenantId: fila.tenant_id,
          wabaId: w?.wabaId ?? null,
          asunto: t("waba.ayuda.asuntoApp").replace("{empresa}", empresa),
        })}
        legales={w && paso === "P1B" ? legalesDeApp(w) : undefined}
        webhook={webhook ?? undefined}
      />
    </Tarjeta>
  );
}
