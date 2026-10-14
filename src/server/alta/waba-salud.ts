/**
 * La revisión nocturna de las WABAs propias de los clientes: lo que ningún mensaje ni
 * ningún evento de Meta va a avisar. Cuelga de la tarea que barre lo trabado
 * (`/api/cron/reap-stuck`) y es de mejor esfuerzo: si no alcanza el tiempo, lo que
 * falta se mira en la próxima vuelta.
 *
 * Por cada WABA de Embedded Signup:
 * - conectada: Graph tiene que seguir diciendo que el token sirve y que autoriza esta WABA;
 *   si el token murió queda en falla (reconecta con el mismo número), y si vive pero la
 *   WABA ya no figura (se sacó la app o el permiso) se da de baja como revocada;
 * - conectada y sin la plantilla de reapertura: se pide de nuevo y se anota la fecha;
 * - a medias hace más de dos días: la persona se fue en medio del trámite y Meta sigue
 *   con la app vinculada, así que se avisa para que el operador la desvincule.
 *
 * Por cada WABA de la app propia (el cliente es dueño de la app, así que cada llamada va firmada):
 * - conectada: el token y la app (`debug_token`). Un secreto que Graph rechaza dos veces seguidas es
 *   `secreto_invalido`; un token vencido, o que perdió un permiso o la WABA, es `token_vencido`. En los
 *   dos el cliente lo arregla en su asistente y el operador recibe un aviso. Después, si Meta deja
 *   enviar (`health_status`): se guarda para el panel, y `BLOCKED` es `waba_bloqueada`. Por último, la
 *   plantilla de reapertura, como arriba;
 * - en falla por `nombre_rechazado`: se le pregunta a Meta por el nombre (R31), por si el aviso de
 *   aprobación no llegó; si ya está aprobado se registra el número de nuevo;
 * - en falla por `waba_restringida` o `waba_bloqueada`: ningún aviso de Meta dice que se levantó (E12 no
 *   tiene Reintentar), así que se mira el token (si murió, esa falla pasa a ser `token_vencido`) y la salud, y
 *   con `AVAILABLE` la WABA vuelve a conectada;
 * - a medias hace más de dos días: el mismo aviso de arriba.
 * Y, al final, el recordatorio de las altas de la app propia que quedaron en `armando` (C13).
 */

import "server-only";
import { sql } from "drizzle-orm";
import { nombreDelError } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { avisarNumeroEnRevision } from "@/server/alta/aviso-operador";
import { nombreAprobado, recordarAltasAMedias, veredictoDelNombre } from "@/server/alta/app-propia";
import { plantillaCreada, restriccionLevantada, saludDeApp, wabaEnFalla, wabaRevocada } from "@/server/alta/panel-operador";
import { leerWabasDelCliente, type WabaDelCliente } from "@/server/alta/wabas-del-cliente";
import { codigoPg } from "@/server/core-sync/config";
import {
  leerApp,
  leerEstadoDelNombre,
  leerSalud,
  pruebaDelSecreto,
  revisarTokenDeApp,
  type AppDelCliente,
  type RevisionDeToken,
} from "@/server/whatsapp/app-del-cliente";
import { crearPlantillaReabrir, revisarToken } from "@/server/whatsapp/embedded-signup";
import { sinLaWaba, TOKEN_INVALIDO } from "@/server/whatsapp/errores-de-graph";

/** Cuánto puede tardar la revisión entera: la tarea que la lleva tiene otras cosas que hacer. */
const PRESUPUESTO_DE_SALUD_MS = 20_000;
/** Lo último del presupuesto se guarda para los recordatorios: con muchas WABAs, la salud no los deja sin lugar. */
const RESERVA_DE_RECORDATORIOS_MS = 5_000;
/** Cuántas WABAs se miran por vuelta. */
const WABAS_POR_VUELTA = 50;
/** Cuánto puede estar una WABA a medias antes de avisar. */
const HORAS_A_MEDIAS = 48;

async function revisarConectada(w: WabaDelCliente): Promise<void> {
  if (!w.token) {
    logger.warn({ tenantId: w.tenantId }, "whatsapp.salud_sin_token");
    return;
  }
  const r = await revisarToken(w.token);
  if (!r.ok) {
    if (r.codigo === TOKEN_INVALIDO) {
      await wabaEnFalla(w.tenantId, "token_vencido");
      await avisarNumeroEnRevision("token_vencido", w.tenantId);
    } else {
      logger.warn({ tenantId: w.tenantId, falla: r.falla }, "whatsapp.salud_token_dudoso");
    }
    return;
  }
  // Un token vivo que ya no lista esta WABA es la misma baja que el aviso de Meta: ese aviso puede no llegar.
  if (sinLaWaba(r, w.wabaId)) {
    await wabaRevocada(w.wabaId);
    await avisarNumeroEnRevision("revocada", w.tenantId);
    return;
  }
  if (w.plantillaEnviada) return;
  const creada = await crearPlantillaReabrir(w.token, w.wabaId);
  if (creada.ok) await plantillaCreada(w.tenantId);
  else await avisarNumeroEnRevision("plantilla", w.tenantId);
}

/** La falla la arregla el cliente en su asistente: queda anotada y el operador se entera. */
async function caer(w: WabaDelCliente, falla: "token_vencido" | "secreto_invalido" | "waba_bloqueada"): Promise<void> {
  await wabaEnFalla(w.tenantId, falla);
  await avisarNumeroEnRevision(falla, w.tenantId);
}

/** Lo que el token del cliente dijo de sí mismo cuando no sirve. */
async function caidaDeApp(w: WabaDelCliente, app: AppDelCliente, r: Extract<RevisionDeToken, { ok: false }>): Promise<void> {
  switch (r.motivo) {
    // Un token que perdió un permiso no manda: se genera uno nuevo, como si hubiera vencido (M9).
    case "token_vencido":
    case "falta_permiso":
      return caer(w, "token_vencido");
    case "app_invalida": {
      // Un 4xx con el token de la app puede ser un corte de Meta: la falla se declara si otra llamada también lo rechaza.
      // Sólo importa si Graph acepta o rechaza; la dirección que se compara no cambia eso.
      const otra = await leerApp(app, "");
      if (otra.ok || otra.falla !== "rechazo") {
        logger.warn({ tenantId: w.tenantId }, "whatsapp.salud_app_dudosa");
        return;
      }
      return caer(w, "secreto_invalido");
    }
    default:
      logger.warn({ tenantId: w.tenantId, motivo: r.motivo }, "whatsapp.salud_token_dudoso");
  }
}

/**
 * El token y la app del cliente de una WABA propia. Devuelve con qué seguir mirando, o null si no hay más que mirar:
 * falta algo para abrir, o el token no sirve y la falla ya quedó anotada (o la duda, en el log).
 */
async function credencialesVivas(w: WabaDelCliente) {
  const { token, appId, secreto, phoneNumberId } = w;
  if (!token || !appId || !secreto || !phoneNumberId) {
    logger.warn({ tenantId: w.tenantId }, "whatsapp.salud_sin_token");
    return null;
  }
  const app: AppDelCliente = { appId, secreto };
  const revision = await revisarTokenDeApp(token, app);
  if (!revision.ok) {
    await caidaDeApp(w, app, revision);
    return null;
  }
  // Si Meta informó a qué WABAs llega el token y ya no está ésta, el cliente la sacó del usuario del sistema: se pide uno nuevo.
  if (revision.wabaIds && !revision.wabaIds.includes(w.wabaId)) {
    await caer(w, "token_vencido");
    return null;
  }
  return { token, phoneNumberId, cred: { accessToken: token, wabaId: w.wabaId, prueba: pruebaDelSecreto(token, secreto) } };
}

/** La app propia conectada: el token, la salud del número y la plantilla. */
async function revisarDeApp(w: WabaDelCliente): Promise<void> {
  const vivas = await credencialesVivas(w);
  if (!vivas) return;
  const { token, phoneNumberId, cred } = vivas;
  const salud = await leerSalud(cred, phoneNumberId);
  if (salud.ok) {
    await saludDeApp(w.tenantId, salud.valor.puedeEnviar);
    if (salud.valor.puedeEnviar === "BLOCKED") return caer(w, "waba_bloqueada");
  } else {
    logger.warn({ tenantId: w.tenantId, falla: salud.falla }, "whatsapp.salud_dudosa");
  }

  if (w.plantillaEnviada) return;
  const creada = await crearPlantillaReabrir(token, w.wabaId, cred.prueba);
  if (creada.ok) await plantillaCreada(w.tenantId);
  else await avisarNumeroEnRevision("plantilla", w.tenantId);
}

/**
 * Una restricción o un bloqueo de Meta: sólo Meta los levanta y no avisa. Antes que la salud se mira el token, porque si
 * murió bajo la restricción el problema de verdad es ése y el cliente tiene que saberlo (`wabaEnFalla` lo deja pisar la vieja).
 */
async function revisarLaRestriccion(w: WabaDelCliente): Promise<void> {
  const vivas = await credencialesVivas(w);
  if (!vivas) return;
  const salud = await leerSalud(vivas.cred, vivas.phoneNumberId);
  if (!salud.ok) {
    logger.warn({ tenantId: w.tenantId, falla: salud.falla }, "whatsapp.salud_dudosa");
    return;
  }
  await saludDeApp(w.tenantId, salud.valor.puedeEnviar);
  if (salud.valor.puedeEnviar === "AVAILABLE") await restriccionLevantada(w.tenantId);
}

/** El nombre rechazado, de respaldo para el aviso de Meta que puede no llegar (R31): sólo se mira, y si ya está aprobado se registra. */
async function revisarElNombre(w: WabaDelCliente): Promise<void> {
  const { token, secreto, phoneNumberId } = w;
  if (!token || !secreto || !phoneNumberId) {
    logger.warn({ tenantId: w.tenantId }, "whatsapp.salud_sin_token");
    return;
  }
  const cred = { accessToken: token, wabaId: w.wabaId, prueba: pruebaDelSecreto(token, secreto) };
  const nombre = await leerEstadoDelNombre(cred, phoneNumberId);
  if (!nombre.ok) {
    logger.warn({ tenantId: w.tenantId, falla: nombre.falla }, "whatsapp.salud_nombre_dudoso");
    return;
  }
  if (veredictoDelNombre(nombre.valor.estado, nombre.valor.estadoNuevo) === "aprobado") await nombreAprobado(w.tenantId, w.wabaId);
}

function revisarUna(w: WabaDelCliente): Promise<void> {
  if (w.estado === "conectada") return w.origen === "app_propia" ? revisarDeApp(w) : revisarConectada(w);
  if (w.estado === "falla") return w.falla === "nombre_rechazado" ? revisarElNombre(w) : revisarLaRestriccion(w);
  return avisarNumeroEnRevision("waba_huerfana", w.tenantId);
}

/** Devuelve false sólo si todavía no está la 0051: sin ella no hay nada más que mirar. */
async function revisarLasWabas(hasta: number): Promise<boolean> {
  try {
    // Al azar: con más de WABAS_POR_VUELTA conectadas, las de siempre taparían al resto.
    const wabas = await leerWabasDelCliente(
      sql`(b.estado = 'conectada'
        or (b.origen = 'app_propia' and b.estado = 'falla' and b.falla in ('nombre_rechazado', 'waba_restringida', 'waba_bloqueada'))
        or (b.estado in ('vinculada', 'suscripta', 'falta_codigo', 'falta_pin') and b.actualizado_en < now() - make_interval(hours => ${HORAS_A_MEDIAS}::int)))`,
      WABAS_POR_VUELTA,
      sql`random()`
    );
    for (const w of wabas) {
      if (Date.now() >= hasta - RESERVA_DE_RECORDATORIOS_MS) {
        logger.warn({ revisadas: wabas.indexOf(w), total: wabas.length }, "whatsapp.salud_sin_tiempo");
        return true;
      }
      try {
        await revisarUna(w);
      } catch (e) {
        logger.error({ error: nombreDelError(e), tenantId: w.tenantId }, "whatsapp.salud_fallo");
      }
    }
  } catch (e) {
    // Sin la 0051 no hay WABAs propias que mirar: no es un fallo, y la tarea corre todas las noches.
    if (codigoPg(e) === "42P01") return false;
    logger.error({ error: nombreDelError(e) }, "whatsapp.salud_consulta_fallo");
  }
  return true;
}

/** No tira nunca: un fallo se anota y la revisión sigue con la próxima WABA. */
export async function revisarWabas(): Promise<void> {
  const hasta = Date.now() + PRESUPUESTO_DE_SALUD_MS;
  if (await revisarLasWabas(hasta)) await recordarAltasAMedias(hasta);
}
