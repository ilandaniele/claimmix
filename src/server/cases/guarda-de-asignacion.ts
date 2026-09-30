/**
 * La condición de un UPDATE que reasigna un caso.
 *
 * La FK `cases.assigned_to -> users.id` ignora RLS: sin esto un uuid de otro
 * inquilino se guardaba con 200 y uno inexistente daba 23503, o sea un oráculo
 * de qué usuarios existen. Con la guarda en el WHERE las tres respuestas
 * (ajeno, inexistente, sin rol de editor) son la misma: cero filas. El EXISTS
 * corre bajo RLS, así que `users` sólo muestra al inquilino del contexto.
 *
 * `IS NOT DISTINCT FROM` sobre el asignado que se leyó cubre la carrera: si
 * otro tomó el caso en el medio, el UPDATE no pega.
 */

import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { cases, users } from "@/lib/db/schema";
import { CASE_EDITOR_ROLES } from "@/lib/auth/roles";

export function guardaDeAsignacion(actual: string | null, destino: string | null) {
  return and(
    sql`${cases.assigned_to} IS NOT DISTINCT FROM ${actual}::uuid`,
    destino === null
      ? undefined
      : sql`EXISTS (SELECT 1 FROM ${users} WHERE ${and(eq(users.id, destino), inArray(users.role, CASE_EDITOR_ROLES))})`
  );
}
