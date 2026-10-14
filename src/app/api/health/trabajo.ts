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
 * `barrer` de `barrer-trabados.yml` —que ya pone el workflow en rojo cuando algo
 * está `down`, y avisa por mail— en una alarma de producto y no de plomería.
 *
 * Sin Sentry esto es lo más cerca que se llega gratis: se pasa de «me entero el
 * jueves» a «me entero en la próxima corrida del cron».
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { DbDueno } from "@/lib/db";
import { errorCode } from "@/lib/observability/error-code";
import { paraCadaBase } from "@/server/bases/cada-base";

export type EstadoDeTrabajo = "ok" | "degraded" | "down";

export interface ChequeoDeTrabajo {
  name: string;
  status: EstadoDeTrabajo;
  detail: string;
}

/**
 * Cuánto se tarda como máximo en pasar por las bases de los clientes.
 *
 * La ruta dura 60 s y los cuatro chequeos recorren a la vez: con 30 s alcanza para
 * decenas de bases, a unos 50 ms cada una, y deja el resto para los otros nueve.
 */
const MS_PARA_RECORRER = 30_000;

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
  return flojo(name, `no se pudo medir (${errorCode(err)})`);
}

/**
 * La consulta en cada base de cliente, o una sola vez si no hay base por cliente.
 *
 * Con `BASE_POR_CLIENTE=1` los casos, los envíos y los adjuntos viven en la base de
 * cada inquilino: mirar sólo control daría cero y verde, que es el error de arriba.
 * `sinMedir` cuenta las bases que no se pudieron leer o que no entraron en el tiempo.
 */
async function enCadaBase<T>(consulta: (db: DbDueno) => Promise<T>): Promise<{ filas: T[]; sinMedir: number }> {
  const corrida = await paraCadaBase((db) => consulta(db), { hasta: Date.now() + MS_PARA_RECORRER });
  return { filas: corrida.resultados, sinMedir: corrida.pendientes + corrida.fallas };
}

/** Un «ok» con bases sin leer no es un «ok»: baja a `degraded` y dice cuántas faltaron. */
function conLoQueFalto(chequeo: ChequeoDeTrabajo, sinMedir: number): ChequeoDeTrabajo {
  if (sinMedir === 0 || chequeo.status !== "ok") return chequeo;
  return flojo(chequeo.name, `${chequeo.detail}; sin medir en ${sinMedir} base(s)`);
}

const sumar = (numeros: number[]) => numeros.reduce((total, n) => total + n, 0);

/**
 * Casos que entraron y que nadie levantó. Cada uno es una denuncia sin leer.
 *
 * Los `recibido` marcados «Para responder» no cuentan: pasado el tope por
 * formulario o por remitente el caso se guarda así a propósito, sin agente, y ya
 * lo tiene una persona. Contarlos pondría la salud en rojo cada vez que alguien
 * pasa el tope. Un `procesando` marcado sí cuenta: el worker pudo caerse.
 */
export async function chequearCasosTrabados(): Promise<ChequeoDeTrabajo> {
  const name = "casos trabados";
  try {
    const { filas, sinMedir } = await enCadaBase(async (db) => {
      // sin-inquilino: chequeo de salud del sistema entero; no corre en nombre de nadie.
      const hallados = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from cases
         where status in ('recibido', 'procesando')
           and created_at < now() - interval '${sql.raw(String(MINUTOS_TRABADO))} minutes'
           and (status = 'procesando' or para_responder_desde is null)
      `);
      return Number(hallados.rows?.[0]?.n ?? 0);
    });
    const n = sumar(filas);
    return n === 0
      ? conLoQueFalto(bien(name, "ninguno"), sinMedir)
      : caido(name, `${n} caso(s) sin tomar hace más de ${MINUTOS_TRABADO} min`);
  } catch (err) {
    return noSePudo(name, err);
  }
}

/** Qué proporción de las llamadas al modelo falló en la última hora. */
export async function chequearExtraccion(): Promise<ChequeoDeTrabajo> {
  const name = "extracción";
  try {
    const { filas, sinMedir } = await enCadaBase(async (db) => {
      // sin-inquilino: idem, salud del sistema.
      const hallados = await db.execute<{ malas: number; total: number }>(sql`
        select count(*) filter (where status <> 'success')::int as malas,
               count(*)::int as total
          from provider_usage_events
         where created_at > now() - interval '1 hour'
      `);
      return {
        malas: Number(hallados.rows?.[0]?.malas ?? 0),
        total: Number(hallados.rows?.[0]?.total ?? 0),
      };
    });
    const malas = sumar(filas.map((f) => f.malas));
    const total = sumar(filas.map((f) => f.total));
    // Sin llamadas no hay proporción que calcular, y eso no es una falla: de
    // madrugada no entra nada.
    if (total === 0) return conLoQueFalto(bien(name, "sin llamadas en la última hora"), sinMedir);

    const proporcion = malas / total;
    const pct = Math.round(proporcion * 100);
    return proporcion > TOPE_FALLOS_DEL_MODELO
      ? flojo(name, `${pct}% de ${total} llamadas falló`)
      : conLoQueFalto(bien(name, `${pct}% de ${total} llamadas falló`), sinMedir);
  } catch (err) {
    return noSePudo(name, err);
  }
}

/** Mensajes al denunciante que no salieron. Cada uno es alguien esperando. */
export async function chequearEnvios(): Promise<ChequeoDeTrabajo> {
  const name = "envíos al denunciante";
  try {
    const { filas, sinMedir } = await enCadaBase(async (db) => {
      // sin-inquilino: idem, salud del sistema.
      const hallados = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from outbound_messages
         where status = 'failed' and created_at > now() - interval '24 hours'
      `);
      return Number(hallados.rows?.[0]?.n ?? 0);
    });
    const n = sumar(filas);
    return n === 0
      ? conLoQueFalto(bien(name, "ninguno falló"), sinMedir)
      : flojo(name, `${n} sin salir en 24 h`);
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
    const { filas, sinMedir } = await enCadaBase(async (db) => {
      // sin-inquilino: idem, salud del sistema.
      const hallados = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from claim_attachments
         where rejected_reason = 'storage_upload_failed'
           and created_at > now() - interval '24 hours'
      `);
      return Number(hallados.rows?.[0]?.n ?? 0);
    });
    const n = sumar(filas);
    return n === 0
      ? conLoQueFalto(bien(name, "ninguno perdido"), sinMedir)
      : flojo(name, `${n} no llegaron al bucket en 24 h`);
  } catch (err) {
    return noSePudo(name, err);
  }
}
