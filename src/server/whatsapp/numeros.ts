/**
 * Qué número de WhatsApp es de quién: el ruteo de lo que entra y la credencial
 * de lo que sale.
 *
 * Es el único archivo que lee WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN,
 * WHATSAPP_BUSINESS_ACCOUNT_ID y WHATSAPP_TENANT_ID (más el sondeo de
 * /api/health, que sólo mira la plataforma); lo vigila `pnpm arquitectura`.
 * Hay una sola app de Meta y una sola WABA: lo que cambia de un inquilino a
 * otro es el `phone_number_id`, y su fila en `whatsapp_numeros` (migración
 * 0048) dice a quién pertenece y en qué estado está.
 *
 * Una fila en CUALQUIER estado gana sobre el .env: suspender o dar de baja el
 * número de la plataforma tiene que cortarlo de verdad. Y nada cae en un
 * inquilino por omisión: el único id que entra al de la plataforma sin fila es
 * exactamente el de WHATSAPP_PHONE_NUMBER_ID.
 */

import "server-only";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { enControl } from "@/data/scope";
import { tenants, whatsappNumeros } from "@/lib/db/schema";
import { enPrueba, pruebaVencida, SIN_SERVICIO } from "@/lib/billing/plans";
import { descifrar } from "@/lib/security/cifrado";
import { logger } from "@/lib/observability/logger";
import { codigoPg } from "@/server/core-sync/config";
import type { CredencialesMeta } from "@/server/whatsapp/cloud-api";

/** El inquilino de la plataforma: el del número que está en el .env. Sin él, el ensayo y el timbre no tienen a dónde entrar. */
export function inquilinoDeLaPlataforma(): string | null {
  const id = process.env.WHATSAPP_TENANT_ID ?? process.env.GMAIL_TENANT_ID;
  return id?.trim() || null;
}

/** El `phone_number_id` del .env: el único que entra al inquilino de la plataforma sin fila. */
export function idDeLaPlataforma(): string | null {
  return process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || null;
}

/** El token y la WABA del .env, o null si falta alguno de los dos del número. */
export function credencialDelEntorno(): CredencialesMeta | null {
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = idDeLaPlataforma();
  if (!accessToken || !phoneNumberId) return null;
  return {
    accessToken,
    phoneNumberId,
    wabaId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID?.trim() || null,
  };
}

/**
 * A qué inquilino va cada `phone_number_id` del lote: id -> tenant_id. Un id
 * que no está en el mapa se descarta.
 *
 * Una sola consulta por POST. Va con `db` y sin inquilino porque todavía no lo
 * hay: es justo lo que se está buscando.
 *
 * - fila 'conectado' de un inquilino activo: va a ese inquilino;
 * - fila en cualquier otro estado: se descarta;
 * - sin fila y el id es el de la plataforma: va al inquilino de la plataforma;
 * - sin fila y cualquier otro id: se descarta.
 *
 * Sin la 0048 (42P01) queda sólo la regla de la plataforma. Cualquier otro
 * error de la base se tira: el webhook responde 500 y Meta reintenta, en vez
 * de resolver "por las dudas".
 */
export async function resolverNumeros(ids: string[]): Promise<Map<string, string>> {
  const ruta = new Map<string, string>();
  const unicos = [...new Set(ids)];
  if (unicos.length === 0) return ruta;

  const conFila = new Set<string>();
  try {
    // sin-inquilino: Todavía no hay inquilino, es lo que se busca: el dueño del
    // phone_number_id con que Meta firmó el evento, en todos los estados.
    const filas = await db
      .select({
        phone_number_id: whatsappNumeros.phone_number_id,
        tenant_id: whatsappNumeros.tenant_id,
        estado: whatsappNumeros.estado,
        billing_status: tenants.billing_status,
      })
      .from(whatsappNumeros)
      .innerJoin(tenants, eq(tenants.id, whatsappNumeros.tenant_id))
      .where(inArray(whatsappNumeros.phone_number_id, unicos));
    for (const f of filas) {
      if (!f.phone_number_id) continue;
      conFila.add(f.phone_number_id);
      if (f.estado === "conectado" && !SIN_SERVICIO.has(f.billing_status)) {
        ruta.set(f.phone_number_id, f.tenant_id);
      }
    }
  } catch (e) {
    if (codigoPg(e) !== "42P01") throw e;
  }

  const propio = idDeLaPlataforma();
  const plataforma = inquilinoDeLaPlataforma();
  if (propio && plataforma && unicos.includes(propio) && !conFila.has(propio)) {
    ruta.set(propio, plataforma);
  }
  return ruta;
}

export interface CredencialesDelNumero extends CredencialesMeta {
  /** De quién es el número: la clave de lo que se cuenta por inquilino, como el tope de plantillas. */
  tenantId: string;
  /** El espacio salió del alta automática. */
  autoalta: boolean;
  /** Salió del alta automática y sigue en prueba: `autoalta` solo no alcanza, un alta sola que ya paga deja de estar topeada. */
  enPrueba: boolean;
  /** Está en prueba y la fecha de fin ya pasó. */
  vencida: boolean;
}

/**
 * Con qué número y qué token habla este inquilino, o null si no tiene número
 * con el que mandar. Quien recibe null no envía nada y lo anota con
 * `avisarSinNumero`.
 *
 * - fila 'conectado': su número y, con `token_cifrado` NULL, el token de usuario
 *   de sistema de la plataforma (hoy siempre; con valor se descifra). Si el
 *   inquilino está suspendido o dado de baja, null: es lo que corta TODO envío
 *   saliente (texto, plantillas, recordatorios) de un solo lugar;
 * - fila en otro estado: null, aunque sea la plataforma;
 * - sin fila: la plataforma usa el .env; cualquier otro inquilino, null.
 *
 * Nunca tira. Ante un error de la base devuelve null y lo anota: no se cae al
 * .env, porque puede haber una fila suspendida que el error esconde.
 */
export async function credencialesWhatsApp(tenantId: string): Promise<CredencialesDelNumero | null> {
  try {
    const filas = await enControl({ tenantId }, (c) =>
      c
        .select({
          estado: whatsappNumeros.estado,
          phone_number_id: whatsappNumeros.phone_number_id,
          waba_id: whatsappNumeros.waba_id,
          token_cifrado: whatsappNumeros.token_cifrado,
          billing_status: tenants.billing_status,
          trial_ends_at: tenants.trial_ends_at,
          autoalta: tenants.autoalta,
        })
        .from(whatsappNumeros)
        .innerJoin(tenants, eq(tenants.id, whatsappNumeros.tenant_id))
    ).catch((e: unknown) => {
      if (codigoPg(e) !== "42P01") throw e;
      return [];
    });

    const viva = filas.find((f) => f.estado === "conectado");
    if (!viva) {
      if (filas.length > 0 || tenantId !== inquilinoDeLaPlataforma()) return null;
      const delEntorno = credencialDelEntorno();
      return delEntorno && { ...delEntorno, tenantId, autoalta: false, enPrueba: false, vencida: false };
    }

    if (SIN_SERVICIO.has(viva.billing_status)) return null;

    const accessToken = viva.token_cifrado
      ? descifrar(viva.token_cifrado, "Invalid WhatsApp token payload")
      : process.env.WHATSAPP_ACCESS_TOKEN;
    if (!accessToken || !viva.phone_number_id) return null;
    const prueba = enPrueba(viva);
    return {
      accessToken,
      phoneNumberId: viva.phone_number_id,
      wabaId: viva.waba_id,
      tenantId,
      autoalta: viva.autoalta === true,
      enPrueba: prueba,
      vencida: prueba && pruebaVencida(viva, new Date()),
    };
  } catch (e) {
    logger.error({ detalle: codigoPg(e) ?? (e instanceof Error ? e.message : "unknown") }, "whatsapp.credenciales_error");
    return null;
  }
}

/** Un envío o una descarga que no salió porque el inquilino no tiene número con el que hablar. */
export function avisarSinNumero(tenantId: string, donde: string): void {
  logger.warn({ tenantId, donde }, "whatsapp.sin_numero");
}
