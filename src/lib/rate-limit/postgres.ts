/**
 * Limitador de intentos respaldado por Postgres.
 *
 * El de memoria cuenta por instancia, y en serverless eso es contar por
 * atacante: Vercel levanta instancias cuando llegan pedidos en paralelo, cada
 * una arranca su cuenta en cero, y quien manda los pedidos en paralelo es
 * justamente el que uno quiere frenar. La prueba de carga lo dejó a la vista —
 * cien pedidos simultáneos atendidos sin que ninguna instancia viera más que
 * unos pocos.
 *
 * La base es lo único que todas las instancias comparten, y ya está ahí. No
 * hace falta un proveedor nuevo, ni una credencial más para rotar, ni una
 * cuenta más que pueda vencerse sin que nadie mire.
 *
 * Ventana fija, no deslizante. Justo en el borde entre dos ventanas puede
 * dejar pasar hasta el doble del límite; a cambio es una sola sentencia
 * atómica en vez de leer-contar-escribir, que con instancias compitiendo es
 * una carrera que se pierde en silencio. Para frenar fuerza bruta la
 * diferencia entre 5 y 10 intentos no existe: la que importa es entre 10 y
 * cien mil.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { logger } from "@/lib/observability/logger";

export interface Counted {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  /**
   * El contador ya cargado en la base, lote incluido. Lo necesita quien
   * reserva créditos de a lotes (ver `credito-local.ts`) para saber, sin
   * volver a preguntarle a la base, cuánto de ese lote ya está gastado.
   */
  hits: number;
}

/**
 * Cuenta un intento y dice si entra.
 *
 * @param key      Identificador de quien pide (IP, usuario, o la combinación).
 * @param limit    Cuántos entran por ventana.
 * @param windowMs Cuánto dura la ventana.
 * @param lote     Cuántos sumar de una vez (default 1, o sea el intento de
 *                 siempre). Lo usa `rateLimit` cuando el perfil reserva de a
 *                 lotes: en vez de escribir una vez por pedido, escribe una
 *                 vez por lote y el resto se resuelve en memoria.
 */
export async function checkRateLimitPostgres(
  key: string,
  limit: number,
  windowMs: number,
  lote = 1
): Promise<Counted> {
  const now = Date.now();
  // Todas las instancias tienen que caer en la misma ventana para contar
  // juntas, así que se deriva del reloj y no de cuándo llegó el primer pedido.
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const resetAt = windowStart.getTime() + windowMs;

  try {
    // sin-inquilino: `rate_limit_counters` se cuenta por IP o por usuario, no por
    // inquilino, y tiene que funcionar antes de saber quién es el que llama.
    const result = await db.execute(sql`
      insert into rate_limit_counters (bucket_key, window_start, hits)
      values (${key}, ${windowStart.toISOString()}, ${lote})
      on conflict (bucket_key, window_start)
        do update set hits = rate_limit_counters.hits + ${lote}
      returning hits
    `);

    // sin-inquilino: Idem: es el resultado del mismo insert de arriba.
    // db.execute devuelve { rows: [...] }, no un arreglo.
    const rows = (result as unknown as { rows: { hits: number | string }[] }).rows ?? [];
    const hits = Number(rows[0]?.hits ?? lote);

    return {
      allowed: hits <= limit,
      remaining: Math.max(0, limit - hits),
      resetAt,
      hits,
    };
  } catch {
    /*
     * Si la base no contesta, dejar pasar.
     *
     * Parece la decisión cobarde y no lo es. Nada de lo que este limitador
     * protege funciona sin la base: un login necesita leer el usuario, y una
     * denuncia necesita escribirse. Fallar cerrado convierte un hipo de la base
     * en una caída total del producto, y no compra nada, porque durante ese
     * hipo el ataque tampoco puede tener éxito.
     *
     * Lo que sí cuesta es no enterarse, así que queda anotado.
     */
    logger.warn({}, "rate_limit.la_base_no_contesto_el_intento");
    // hits: 0 — nada se cargó de verdad, así que quien reserva de a lotes no
    // le resta presupuesto a nadie por un intento que la base nunca vio.
    return { allowed: true, remaining: limit, resetAt, hits: 0 };
  }
}

/**
 * Borrar las ventanas que ya vencieron.
 *
 * Una fila por clave y por ventana crece rápido y no sirve de nada pasada la
 * ventana. Lo llama el cron diario; no hace falta que sea puntual, sólo que
 * ocurra.
 */
export async function purgeExpiredRateLimits(olderThanMs = 24 * 60 * 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  try {
    // sin-inquilino: La limpieza del contador, que tampoco es de nadie en particular.
    const result = await db.execute(
      sql`delete from rate_limit_counters where window_start < ${cutoff}`
    );
    return (result as unknown as { rowCount?: number }).rowCount ?? 0;
  } catch {
    return 0;
  }
}
