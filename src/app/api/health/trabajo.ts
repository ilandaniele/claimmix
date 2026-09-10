/**
 * Los chequeos que preguntan si el producto está HACIENDO su trabajo.
 *
 * Los otros nueve preguntan «¿alcanzo a X?» — la base, la capa, el esquema, el
 * almacenamiento, el modelo, WhatsApp, Gmail, la configuración del agente, el
 * presupuesto. Todos son de dependencias, y todos pueden estar en verde con el
 * producto sin hacer nada.
 *
 * El 09/09, con 80 timeouts del modelo y 189 adjuntos que R2 nunca recibió,
 * `/api/health` estuvo verde todo el día. Se consulta cada quince minutos y no
 * había nada que mirar.
 *
 * Estos cuatro son las consultas más baratas que contestan «¿se está perdiendo
 * trabajo?». Van sobre índices que ya existen y son lo que convierte al job
 * `salud` de `barrer-trabados.yml` —que ya pone el workflow en rojo cuando algo
 * está `down`, y avisa por mail— en una alarma de producto y no de plomería.
 *
 * Sin Sentry esto es lo más cerca que se llega gratis: se pasa de «me entero el
 * jueves» a «me entero en la próxima corrida del cron».
 */

import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

export type EstadoDeTrabajo = "ok" | "degraded" | "down";

export interface ChequeoDeTrabajo {
  name: string;
  status: EstadoDeTrabajo;
  detail: string;
}

/** Cuántos minutos puede estar un caso sin que nadie lo tome. Ver `reap-stuck`. */
const MINUTOS_TRABADO = 20;

/**
 * Qué proporción de llamadas al modelo puede fallar antes de que sea un
 * problema.
 *
 * Medido: entre el 4 y el 9 de septiembre el peor día tuvo un 9,5 % de fallos y
 * el mejor un 1 %. Quince por ciento deja pasar un día malo del proveedor y
 * salta cuando algo se rompió de verdad — una clave vencida, un modelo que ya no
 * existe, el cupo agotado.
 */
const TOPE_FALLOS_DEL_MODELO = 0.15;

function bien(name: string, detail: string): ChequeoDeTrabajo {
  return { name, status: "ok", detail };
}
function flojo(name: string, detail: string): ChequeoDeTrabajo {
  return { name, status: "degraded", detail };
}
function caido(name: string, detail: string): ChequeoDeTrabajo {
  return { name, status: "down", detail };
}

/**
 * Un chequeo que no pudo consultar NO dice que está todo bien.
 *
 * Es el mismo error que el encabezado de `reap-stuck` describe haber cometido:
 * devolver cero y quedar en verde es peor que no tener red, porque el verde
 * convence.
 */
function noSePudo(name: string, err: unknown): ChequeoDeTrabajo {
  const code =
    (err as { code?: string })?.code ??
    (err instanceof Error ? err.name : "UnknownError");
  return flojo(name, `no se pudo medir (${code})`);
}

/** Casos que entraron y que nadie levantó. Cada uno es una denuncia sin leer. */
export async function chequearCasosTrabados(): Promise<ChequeoDeTrabajo> {
  const name = "casos trabados";
  try {
    // sin-inquilino: chequeo de salud del sistema entero; no corre en nombre de nadie.
    const filas = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from cases
       where status in ('recibido', 'procesando')
         and created_at < now() - interval '${sql.raw(String(MINUTOS_TRABADO))} minutes'
    `);
    const n = Number(filas.rows?.[0]?.n ?? 0);
    return n === 0
      ? bien(name, "ninguno")
      : caido(name, `${n} caso(s) sin tomar hace más de ${MINUTOS_TRABADO} min`);
  } catch (err) {
    return noSePudo(name, err);
  }
}

/** Qué proporción de las llamadas al modelo falló en la última hora. */
export async function chequearExtraccion(): Promise<ChequeoDeTrabajo> {
  const name = "extracción";
  try {
    // sin-inquilino: idem, salud del sistema.
    const filas = await db.execute<{ malas: number; total: number }>(sql`
      select count(*) filter (where status <> 'success')::int as malas,
             count(*)::int as total
        from provider_usage_events
       where created_at > now() - interval '1 hour'
    `);
    const malas = Number(filas.rows?.[0]?.malas ?? 0);
    const total = Number(filas.rows?.[0]?.total ?? 0);
    // Sin llamadas no hay proporción que calcular, y eso no es una falla: de
    // madrugada no entra nada.
    if (total === 0) return bien(name, "sin llamadas en la última hora");

    const proporcion = malas / total;
    const pct = Math.round(proporcion * 100);
    return proporcion > TOPE_FALLOS_DEL_MODELO
      ? flojo(name, `${pct}% de ${total} llamadas falló`)
      : bien(name, `${pct}% de ${total} llamadas falló`);
  } catch (err) {
    return noSePudo(name, err);
  }
}

/** Mensajes al denunciante que no salieron. Cada uno es alguien esperando. */
export async function chequearEnvios(): Promise<ChequeoDeTrabajo> {
  const name = "envíos al denunciante";
  try {
    // sin-inquilino: idem, salud del sistema.
    const filas = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from outbound_messages
       where status = 'failed' and created_at > now() - interval '24 hours'
    `);
    const n = Number(filas.rows?.[0]?.n ?? 0);
    return n === 0 ? bien(name, "ninguno falló") : flojo(name, `${n} sin salir en 24 h`);
  } catch (err) {
    return noSePudo(name, err);
  }
}

/**
 * Adjuntos que la persona mandó y que nunca llegaron al bucket.
 *
 * En producción hay 189 con `storage_upload_failed`: 189 fotos de daños que el
 * asegurado creyó haber mandado. Ninguna dejó una línea en stderr.
 */
export async function chequearAdjuntos(): Promise<ChequeoDeTrabajo> {
  const name = "adjuntos";
  try {
    // sin-inquilino: idem, salud del sistema.
    const filas = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from claim_attachments
       where rejected_reason = 'storage_upload_failed'
         and created_at > now() - interval '24 hours'
    `);
    const n = Number(filas.rows?.[0]?.n ?? 0);
    return n === 0 ? bien(name, "ninguno perdido") : flojo(name, `${n} no llegaron al bucket en 24 h`);
  } catch (err) {
    return noSePudo(name, err);
  }
}
