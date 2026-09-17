/**
 * Fila de `users` cacheada en memoria de proceso.
 *
 * La bandeja sondea `GET /api/cases` cada 5 s (con backoff a 30 s), y cada
 * sondeo pasaba por dos caminos que leían la MISMA fila de `users` sin
 * compartir consulta: `requireRole` con su propio `select`, y `getUserRow`
 * con otro. Esa fila casi nunca cambia. Este módulo unifica la lectura en
 * una sola consulta — el superconjunto de las dos — y la cachea acá.
 *
 * Honestidad sobre lo que esto compra: las instancias de Vercel no comparten
 * memoria entre sí. Esto ayuda sólo adentro de UNA instancia ya caliente; un
 * cold start no gana nada acá. Con un sondeo cada 5–30 s por pestaña abierta,
 * la misma persona suele volver a cachear en la misma instancia caliente
 * entre un sondeo y el siguiente. Eso no es una tasa de aciertos garantizada
 * — no se promete ninguna — es sólo lo que hace plausible que esto sirva de
 * algo. Por la misma razón no se usa `unstable_cache` ni `"use cache"`: esos
 * guardan en un store compartido entre instancias y persiste entre
 * peticiones, y eso convierte un error momentáneo entre inquilinos en uno
 * durable.
 *
 * NUNCA se cachea un `null`: un usuario recién dado de alta, o uno recién
 * borrado, no puede quedar mal durante 30 s. Dos misses seguidos hacen dos
 * consultas.
 */
import "server-only";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { users } from "@/lib/db/schema";

export interface FilaUsuario {
  id: string;
  tenant_id: string;
  role: string;
  full_name: string;
  locale: string | null;
}

/**
 * 30 s. El costo en el peor caso: a quien se le baja el rol le queda el rol
 * viejo hasta 30 s más en cada instancia caliente que ya lo tenía cacheado.
 * La invalidación explícita en el PATCH que cambia el rol sólo limpia la
 * instancia que atendió esa petición — las demás instancias calientes siguen
 * sirviendo la fila vieja hasta que el `vence` de su propia entrada expira.
 */
export const TTL_FILA_MS = 30_000;

const MAX_FILAS = 5_000;

interface EntradaFila {
  fila: FilaUsuario;
  vence: number;
}

// Mismo esquema que `rate-limit/memory.ts`: Map a nivel de módulo, tope duro
// de entradas, se destierra la más vieja al llegar al tope.
const filas = new Map<string, EntradaFila>();

function guardar(userId: string, fila: FilaUsuario): void {
  if (filas.size >= MAX_FILAS) {
    const masVieja = filas.keys().next().value;
    if (masVieja !== undefined) filas.delete(masVieja);
  }
  filas.set(userId, { fila, vence: Date.now() + TTL_FILA_MS });
}

/** Fila de `users` para `userId`, de la caché de proceso o de la base. */
export async function filaDeUsuario(userId: string): Promise<FilaUsuario | null> {
  const entrada = filas.get(userId);
  if (entrada && entrada.vence > Date.now()) {
    return entrada.fila;
  }

  /*
   * El arranque de toda petición: de acá sale el `tenant_id` que después usa
   * `enTenant`. Por definición no puede pasar por una capa que necesita el
   * dato que ella misma busca.
   */
  // sin-inquilino: esta consulta AVERIGUA el inquilino de la sesión.
  const fila = firstRow(
    await db
      .select({
        id: users.id,
        tenant_id: users.tenant_id,
        role: users.role,
        full_name: users.full_name,
        locale: users.locale,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  );

  if (!fila) return null;

  guardar(userId, fila);
  return fila;
}

/** Sin argumento: borra toda la caché. Con uno: sólo esa fila. */
export function olvidarFilaDeUsuario(userId?: string): void {
  if (userId === undefined) {
    filas.clear();
    return;
  }
  filas.delete(userId);
}
