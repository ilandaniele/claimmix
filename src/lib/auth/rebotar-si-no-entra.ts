/**
 * Qué hace una pantalla de /admin o /agente cuando su guarda tira.
 *
 * Antes cada pantalla atrapaba CUALQUIER error de la guarda y, salvo la falta de
 * sesión, mandaba a `/bandeja`. Pero la guarda lee la base: un corte de Neon o de
 * la base del cliente también caía ahí, y el admin terminaba en la bandeja de
 * siniestros sin un aviso, convencido de que «Facturación» lo llevaba para allá.
 *
 * Ahora sólo rebota lo que es un «no»: sin sesión va a `/login`, con sesión y sin
 * rol (o sin ser operador) a su bandeja —que la pantalla exista no tiene por qué
 * constarle—. Todo lo demás se vuelve a tirar, y lo muestra `(app)/error.tsx`
 * con su botón para reintentar.
 *
 * Uso, en el `catch` de la guarda:
 *
 *   try { ctx = await requireAdmin(); } catch (e) { rebotarSiNoEntra(e); }
 */

import { redirect, unstable_rethrow } from "next/navigation";

import { AppError } from "@/lib/errors";

export function rebotarSiNoEntra(e: unknown): never {
  // Lo que Next tira para cortar el render (un `redirect`, el pedido dinámico
  // que `headers()` marca) no es una falla de la guarda: sigue su camino.
  unstable_rethrow(e);
  if (e instanceof AppError) {
    if (e.code === "MISSING_SESSION") redirect("/login");
    if (e.code === "FORBIDDEN_ROLE") redirect("/bandeja");
  }
  throw e;
}
