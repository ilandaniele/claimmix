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
 * consultas. Un usuario dado de baja (`dado_de_baja_en`) no tiene fila: para
 * `requireRole` y el layout es lo mismo que no existir.
 */
import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { tenantBases, tenants, users } from "@/lib/db/schema";

export interface FilaUsuario {
  id: string;
  tenant_id: string;
  role: string;
  full_name: string;
  locale: string | null;
  /** `tenants.plan` del inquilino de la sesión; decide lo del Plan Pro. */
  plan: string;
  /** `tenants.billing_status`; con `autoalta` dice si el espacio está en prueba. */
  billing_status: string;
  /** `tenants.autoalta`; null si la 0048 todavía no está aplicada. */
  autoalta: boolean | null;
  /** `tenant_bases.estado` de su inquilino; null si todavía no tiene fila. */
  base: "creando" | "lista" | "fallida" | "borrada" | null;
  /** Desde cuándo: `tenant_bases.creada_at`, o `tenants.created_at` si no hay fila. */
  baseDesde: Date | null;
}

/**
 * 30 s. El costo en el peor caso: a quien se le baja el rol le queda el rol
 * viejo hasta 30 s más en cada instancia caliente que ya lo tenía cacheado.
 * La invalidación explícita en el PATCH que cambia el rol sólo limpia la
 * instancia que atendió esa petición — las demás instancias calientes siguen
 * sirviendo la fila vieja hasta que el `vence` de su propia entrada expira.
 * Lo mismo con el plan: un cambio de `tenants.plan` por SQL tarda hasta 30 s
 * en cada instancia caliente, y nada lo invalida.
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
  const leida = firstRow(
    await db
      .select({
        id: users.id,
        tenant_id: users.tenant_id,
        role: users.role,
        full_name: users.full_name,
        locale: users.locale,
        plan: tenants.plan,
        billing_status: tenants.billing_status,
        // `to_jsonb` y no la columna: antes de la 0048 `tenants.autoalta` tira 42703 y deja afuera a todos.
        autoalta: sql<boolean | null>`(to_jsonb(${tenants}.*) ->> 'autoalta')::boolean`,
        base: tenantBases.estado,
        baseDesde: sql<string | Date | null>`coalesce(${tenantBases.creada_at}, ${tenants.created_at})`,
      })
      .from(users)
      // El plan viaja en la misma consulta: sin un segundo viaje por pedido.
      // Inner y no left: `users.tenant_id` es NOT NULL con FK a `tenants`, así
      // que no se pierde ninguna fila y `plan` nunca llega nulo.
      .innerJoin(tenants, eq(tenants.id, users.tenant_id))
      // Left: un inquilino sin base propia no tiene fila. `tenants.id` va primero:
      // `pnpm arquitectura` cuenta los `eq(x.tenant_id, …)` y esto no es un filtro.
      .leftJoin(tenantBases, eq(tenants.id, tenantBases.tenant_id))
      .where(and(eq(users.id, userId), isNull(users.dado_de_baja_en)))
      .limit(1)
  );

  if (!leida) return null;
  const fila: FilaUsuario = { ...leida, baseDesde: leida.baseDesde == null ? null : new Date(leida.baseDesde) };

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
