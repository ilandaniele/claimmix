/**
 * Lo que /conectar-whatsapp, /preparando y /configuracion saben de la WABA propia de
 * un espacio, para pintarlo.
 *
 * `waba-propia.ts` lee la fila entera para seguir hablando con Graph, con el token y el
 * PIN abiertos. Una pantalla no necesita nada de eso, y un secreto que no se lee no se
 * puede filtrar: esta lectura es otra, trae sólo estados y el número, y de la fila del
 * número sólo pregunta si hay token (`is not null`), nunca lo trae.
 *
 * También decide qué camino le toca a cada espacio (`metodoDelEspacio`) y arma el
 * enlace de ayuda, que van juntos porque los tres usan lo mismo: de dónde viene el número.
 */

import "server-only";

import { and, eq, ne, sql } from "drizzle-orm";

import { enControl } from "@/data/scope";
import { operatorEmails } from "@/lib/auth/operator-emails";
import { tenants, whatsappNumeros, whatsappWabas } from "@/lib/db/schema";
import type { TranslationKey } from "@/lib/i18n";
import { errorCode } from "@/lib/observability/error-code";
import { logger } from "@/lib/observability/logger";
import { numeroAutomatico } from "@/server/alta/numero-automatico-activo";
import { mismoNumero } from "@/server/alta/validar";
import { appPropia, wabaPropia } from "@/server/alta/waba-propia-activa";
import { metodoDelNumero, type MetodoDelNumero, type OrigenDeWaba } from "@/server/alta/waba-resultados";
import { wabaDeLaPlataforma } from "@/server/whatsapp/numeros";

/** Qué es el número de un espacio según los ids que tiene guardados. */
export interface OrigenDelNumero {
  /** Tiene una WABA que no es la de la plataforma y el token de esa WABA: la conectó por esta ruta. */
  conWaba: boolean;
  /** Tiene un número en la WABA de la plataforma (el camino del código), conectado o a medias. */
  idEnLaPlataforma: boolean;
}

/**
 * Los ids salen de la fila del número y no se muestran: sólo se compara con la WABA de la
 * plataforma, que vive en el entorno y no está en ninguna tabla. Un número de la plataforma
 * que quedó en otra WABA (la de prueba, una anterior) no es de esta ruta: eso lo dice el
 * token propio, que el camino de la plataforma nunca guarda.
 */
export function origenDelNumero(fila: { phoneNumberId: string | null; wabaId: string | null; conToken: boolean }): OrigenDelNumero {
  const conWaba = fila.conToken && fila.wabaId !== null && fila.wabaId !== wabaDeLaPlataforma();
  return { conWaba, idEnLaPlataforma: fila.phoneNumberId !== null && !conWaba };
}

/**
 * Qué panel le toca a un espacio: el de la WABA propia, el de su app de Meta, el del código,
 * o ninguno. Sobre `metodoDelNumero` suma una regla: quien ya anda por la WABA de la
 * plataforma sigue ahí, aunque la bandera de una vía propia se prenda después.
 * `origen` es el de la fila viva de WABA; sin él, una WABA propia cuenta como la del popup.
 */
export function metodoDelEspacio(
  p: OrigenDelNumero & { esAdmin: boolean; autoalta: boolean; yaConectado: boolean; origen?: OrigenDeWaba | null }
): MetodoDelNumero {
  const metodo = metodoDelNumero({
    wabaPropia: wabaPropia(),
    appPropia: appPropia(),
    numeroAutomatico: numeroAutomatico(),
    esAdmin: p.esAdmin,
    autoalta: p.autoalta,
    idEnLaPlataforma: p.idEnLaPlataforma,
    origen: p.origen !== undefined ? p.origen : p.conWaba ? "embedded_signup" : null,
  });
  return (metodo === "propia" || metodo === "app") && p.yaConectado && !p.conWaba ? null : metodo;
}

export interface WabaPublica extends OrigenDelNumero {
  /** El nombre del espacio: precarga el nombre visible del número. */
  nombre: string;
  /** Estado de la fila de la WABA propia; null si no hay. */
  estado: string | null;
  /** Cómo nació la fila viva (popup de Meta o app propia); null si no hay fila viva. */
  origen: OrigenDeWaba | null;
  falla: string | null;
  /** El paso del popup en el que se canceló (en minúsculas, ya acotado por la base). */
  paso: string | null;
  wabaId: string | null;
  /** El número que informó Meta. */
  numeroMeta: string | null;
  /** El número que la persona tipeó al darse de alta. */
  numeroTipeado: string | null;
  /** Meta informó otro número que el tipeado y la persona todavía no lo aceptó. */
  numeroDistinto: boolean;
  nombreEstado: string | null;
  plantilla: boolean;
  /** Hay un token guardado: el servidor puede seguir sin abrir el popup otra vez. */
  conToken: boolean;
  /** Estado de la fila viva de `whatsapp_numeros`; null si no hay. */
  numero: "pedido" | "conectado" | "suspendido" | null;
}

/**
 * Una sola consulta que parte del espacio (siempre hay fila) y le cuelga la WABA y el
 * número vivo. Nunca rechaza: sin la 0051 o con la base caída vuelve null, y cada
 * pantalla sigue con lo que tenía.
 */
export async function leerWabaPublica(tenantId: string): Promise<WabaPublica | null> {
  try {
    const filas = await enControl({ tenantId }, (db) =>
      db
        .select({
          nombre: tenants.name,
          estado: whatsappWabas.estado,
          origenDeWaba: whatsappWabas.origen,
          falla: whatsappWabas.falla,
          paso: whatsappWabas.paso_cancelado,
          wabaId: whatsappWabas.waba_id,
          numeroMeta: whatsappWabas.numero_meta,
          numeroAceptado: whatsappWabas.numero_aceptado,
          nombreEstado: whatsappWabas.nombre_estado,
          plantilla: whatsappWabas.plantilla_enviada_en,
          numero: whatsappNumeros.estado,
          phoneNumberId: whatsappNumeros.phone_number_id,
          numeroTipeado: whatsappNumeros.numero_e164,
          wabaDelNumero: whatsappNumeros.waba_id,
          conToken: sql<boolean>`${whatsappNumeros.token_cifrado} is not null`,
        })
        .from(tenants)
        .leftJoin(whatsappWabas, eq(whatsappWabas.tenant_id, tenants.id))
        .leftJoin(whatsappNumeros, and(eq(whatsappNumeros.tenant_id, tenants.id), ne(whatsappNumeros.estado, "baja")))
        .where(eq(tenants.id, tenantId))
        .limit(1)
    );
    const f = filas[0];
    if (!f) return null;
    const origen = origenDelNumero({ phoneNumberId: f.phoneNumberId, wabaId: f.wabaDelNumero, conToken: f.conToken === true });
    // Una fila de WABA propia cuenta aunque el número todavía no exista (cancelada, a medias).
    const conWaba = origen.conWaba || f.estado !== null;
    const viva = f.estado !== null && f.estado !== "cancelada" && f.estado !== "revocada";
    return {
      conWaba,
      origen: viva ? (f.origenDeWaba === "app_propia" ? "app_propia" : "embedded_signup") : null,
      idEnLaPlataforma: origen.idEnLaPlataforma && !conWaba,
      nombre: f.nombre,
      estado: f.estado,
      falla: f.falla,
      paso: f.paso,
      wabaId: f.wabaId,
      numeroMeta: f.numeroMeta,
      numeroTipeado: f.numeroTipeado,
      numeroDistinto: f.numeroAceptado !== true && f.numeroMeta !== null && !mismoNumero(f.numeroMeta, f.numeroTipeado),
      nombreEstado: f.nombreEstado,
      plantilla: f.plantilla !== null,
      conToken: f.conToken === true && f.wabaId !== null && f.wabaDelNumero === f.wabaId,
      numero: f.numero === "pedido" || f.numero === "conectado" || f.numero === "suspendido" ? f.numero : null,
    };
  } catch (e) {
    logger.warn({ code: errorCode(e) }, "conectar_whatsapp.lectura_no_se_hizo");
    return null;
  }
}

/**
 * El «Ayuda» de la pantalla: un correo a la dirección que ya recibe los avisos del alta,
 * con el espacio y la WABA en el cuerpo para que no haya que preguntarlos. Sin dirección
 * cargada no hay enlace.
 */
export function enlaceDeAyuda(
  t: (clave: TranslationKey) => string,
  ids: { tenantId: string; wabaId: string | null; asunto?: string }
): string | null {
  const para = operatorEmails()[0];
  if (!para) return null;
  const cuerpo = t("waba.ayuda.cuerpo").replace("{espacio}", ids.tenantId).replace("{waba}", ids.wabaId ?? "-");
  return `mailto:${para}?subject=${encodeURIComponent(ids.asunto ?? t("waba.ayuda.asunto"))}&body=${encodeURIComponent(cuerpo)}`;
}
