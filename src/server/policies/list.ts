/**
 * Las pólizas de una aseguradora, paginadas y filtradas.
 *
 * Gemela de `customers/list.ts` y por el mismo motivo: estaba adentro del route
 * handler, mezclada con la sesión, la guarda de rol y el límite de tráfico.
 */

import "server-only";

import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { normalizarNumeroPoliza } from "@/core/matching/normalizar";
import type { TenantContext } from "@/data/scope";
import { paginarEnTenant, type Pagina } from "@/lib/db/paginacion";
import { customers, policies } from "@/lib/db/schema";

export const PolicyQuerySchema = z.object({
  customer_id: z.string().uuid().optional(),
  policy_number: z.string().max(100).optional(),
  status: z.enum(["active", "expired", "cancelled"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

export type PolicyQuery = z.infer<typeof PolicyQuerySchema>;

export interface PolicyRow {
  id: string;
  policy_number: string;
  policy_type: string | null;
  status: string | null;
  customer_id: string | null;
  customer_name: string | null;
  valid_from: string | null;
  valid_to: string | null;
  created_at: Date | null;
}

/**
 * El filtro, exportado para poder mirarle el SQL sin fabricar una petición.
 *
 * Es la misma razón por la que `customers/list.ts` exporta el suyo: el defecto
 * que tenía —comparar el número de póliza crudo— sólo se ve en el SQL que sale,
 * y probarlo contra un db de mentira no comprueba nada.
 */
export function armarFiltroDePolizas(query: PolicyQuery): SQL | undefined {
  const condiciones: SQL[] = [];

  if (query.customer_id) condiciones.push(eq(policies.customer_id, query.customer_id));
  /*
   * El número de póliza, normalizado como en los otros tres buscadores.
   *
   * Era `eq(policies.policy_number, query.policy_number)`, comparación cruda,
   * así que `?policy_number=pol-4471-a` no encontraba nada mientras el agente sí
   * lo encuentra — y los números de póliza los tipea una persona.
   *
   * El SQL es idéntico al de `policy-matcher.ts:125`, `customer-matcher.ts:213`
   * y `agent-tools.ts:136`, que es lo que pide el encabezado de `normalizar.ts`:
   * el guion viaja de los dos lados o de ninguno. Sacar el espacio y subir a
   * mayúsculas, nada más — `POL-8812-R` y `POL8812R` pueden ser dos contratos
   * distintos del mismo inquilino, y `(tenant_id, policy_number)` es único sobre
   * el texto crudo.
   */
  if (query.policy_number)
    condiciones.push(
      sql`upper(replace(${policies.policy_number}, ' ', '')) = ${normalizarNumeroPoliza(query.policy_number)}`
    );
  if (query.status) condiciones.push(eq(policies.status, query.status));

  return and(...condiciones);
}

export async function listPolicies(
  ctx: TenantContext,
  query: PolicyQuery
): Promise<Pagina<PolicyRow>> {
  const where = armarFiltroDePolizas(query);
  const offset = (query.page - 1) * query.per_page;

  // En el esquema las fechas se llaman `start_date` / `end_date`; el contrato
  // de la API las expone como `valid_from` / `valid_to` desde antes y se
  // mantiene, así que el renombre se hace acá, en el `select`, y no recorriendo
  // las filas después.
  return paginarEnTenant<PolicyRow>(
    ctx,
    { tabla: policies, where, page: query.page, per_page: query.per_page },
    (db) =>
      db
        .select({
          id: policies.id,
          policy_number: policies.policy_number,
          policy_type: policies.policy_type,
          status: policies.status,
          customer_id: policies.customer_id,
          customer_name: customers.full_name,
          valid_from: policies.start_date,
          valid_to: policies.end_date,
          created_at: policies.created_at,
        })
        .from(policies)
        .leftJoin(customers, eq(customers.id, policies.customer_id))
        .where(where)
        .orderBy(desc(policies.created_at))
        .limit(query.per_page)
        .offset(offset)
  );
}
