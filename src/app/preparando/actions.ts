"use server";

import { redirect } from "next/navigation";

import { basePorCliente } from "@/data/bases";
import { filaDeUsuario, olvidarFilaDeUsuario } from "@/lib/auth/fila-de-usuario-cacheada";
import { getSessionContext } from "@/lib/auth/session";
import { logger } from "@/lib/observability/logger";
import { rateLimit } from "@/lib/rate-limit";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { vistaDeBase } from "@/server/bases/espera";
import { iniciarBase } from "@/server/bases/iniciar";

const CUPO_DE_REINTENTOS = { limit: 3, windowMs: 10 * 60_000, fallaCerrada: true };

/**
 * «Reintentar» de /preparando: vuelve a lanzar la preparación de la base.
 *
 * No recibe nada del formulario: el inquilino sale de la fila de quien tiene la
 * sesión, nunca de un campo ni de la URL. Sólo reintenta si la base está
 * `fallida` o lleva más de 15 minutos `creando`; en cualquier otro caso, o si se
 * pasó del cupo, no hace nada. Siempre termina en /preparando, que muestra lo que corresponde.
 */
export async function reintentarMiBase(): Promise<void> {
  const usuario = (await getSessionContext())?.user;
  if (!usuario) redirect("/login");
  if (!basePorCliente()) redirect("/bandeja");

  const cupo = await rateLimit(claveDeCupo("user", usuario.id, "reintentar-base"), CUPO_DE_REINTENTOS);
  if (cupo.allowed) {
    // La copia de 30 s puede ser anterior al fin del intento que se está mirando.
    olvidarFilaDeUsuario(usuario.id);
    const fila = await filaDeUsuario(usuario.id);
    if (!fila) redirect("/pendiente");
    if (vistaDeBase(fila) === "reintentable") {
      try {
        await iniciarBase(fila.tenant_id);
      } catch (e) {
        logger.error({ error: e instanceof Error ? e.name : "UnknownError", tenantId: fila.tenant_id }, "preparando.reintento_fallo");
      }
    }
  }
  redirect("/preparando");
}
