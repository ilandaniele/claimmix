/**
 * La fila de `users` de quien está entrando, una sola vez por pedido.
 *
 * Cada página autenticada arrancaba igual: `getSessionContext()` y después un
 * `select ... from users where id = session.user.id` para saber el inquilino y
 * el rol. Y el layout, que envuelve a todas, hacía EL MISMO select para dibujar
 * la barra —nombre, rol, idioma—. Dos viajes al pooler por render, para leer
 * la misma fila.
 *
 * Con quinientos casos ninguna consulta es cara; lo que domina el tiempo de
 * una pantalla es cuántas veces va y vuelve a la base antes de pintar. Este
 * helper es la regla `server-cache-react` de las guías de rendimiento de
 * Vercel: `cache()` de React dedupe por pedido, así que layout y página piden
 * la fila y la base la entrega una vez.
 *
 * `cache()` y no un caché entre pedidos: la fila puede cambiar —rol, idioma— y
 * un caché LRU la serviría vieja a otro pedido. Lo que se quiere deduplicar es
 * DENTRO del mismo render, y para eso es exactamente `cache()`.
 *
 * Sin `enTenant` a propósito: ésta es la consulta que AVERIGUA de qué
 * inquilino es la sesión, así que no puede pasar por una capa que necesita el
 * dato que ella busca. Es la misma nota que estaba repetida en cada página.
 */

import "server-only";
import { cache } from "react";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { firstRow } from "@/lib/db/helpers";
import { users } from "@/lib/db/schema";

export interface UserRow {
  tenant_id: string;
  role: string;
  full_name: string;
  locale: string | null;
}

/**
 * La fila de `users` del usuario, o `null` si no tiene perfil.
 *
 * Nunca tira: una fila que falta —cuenta creada y perfil no provisto— es un
 * `null` que la página traduce a un `redirect`, no un error de servidor.
 */
export const getUserRow = cache(async (userId: string): Promise<UserRow | null> => {
  try {
    // sin-inquilino: ver el comentario de arriba.
    return firstRow(
      await db
        .select({
          tenant_id: users.tenant_id,
          role: users.role,
          full_name: users.full_name,
          locale: users.locale,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
    );
  } catch {
    return null;
  }
});
