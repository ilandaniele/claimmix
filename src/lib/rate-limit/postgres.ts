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

export interface Counted {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Cuenta un intento y dice si entra.
 *
 * @param key      Identificador de quien pide (IP, usuario, o la combinación).
 * @param limit    Cuántos entran por ventana.
 * @param windowMs Cuánto dura la ventana.
 */
export async function checkRateLimitPostgres(
  key: string,
  limit: number,
  windowMs: number
): Promise<Counted> {
  const now = Date.now();
  // Todas las instancias tienen que caer en la misma ventana para contar
  // juntas, así que se deriva del reloj y no de cuándo llegó el primer pedido.
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs);
  const resetAt = windowStart.getTime() + windowMs;

  try {
    const result = await db.execute(sql`
      insert into rate_limit_counters (bucket_key, window_start, hits)
      values (${key}, ${windowStart.toISOString()}, 1)
      on conflict (bucket_key, window_start)
        do update set hits = rate_limit_counters.hits + 1
      returning hits
    `);

    // db.execute devuelve { rows: [...] }, no un arreglo.
    const rows = (result as unknown as { rows: { hits: number | string }[] }).rows ?? [];
    const hits = Number(rows[0]?.hits ?? 1);

    return {
      allowed: hits <= limit,
      remaining: Math.max(0, limit - hits),
      resetAt,
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
    console.warn("[rate-limit] la base no contestó; el intento pasa sin contar"); // crew-debug-ok
    return { allowed: true, remaining: limit, resetAt };
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
    const result = await db.execute(
      sql`delete from rate_limit_counters where window_start < ${cutoff}`
    );
    return (result as unknown as { rowCount?: number }).rowCount ?? 0;
  } catch {
    return 0;
  }
}
