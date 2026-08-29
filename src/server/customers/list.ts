/**
 * El padrón de clientes, paginado y filtrado.
 *
 * Vivía adentro del route handler, que además hacía la sesión, la guarda de rol,
 * el límite de tráfico y el armado de la respuesta. Cinco responsabilidades en
 * un archivo significa que para probar el filtro por DNI había que fabricar una
 * petición HTTP con sesión.
 */

import "server-only";

import { and, desc, eq, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { TenantContext } from "@/data/scope";
import { ilikeAny } from "@/lib/db/helpers";
import { paginarEnTenant, type Pagina } from "@/lib/db/paginacion";
import { customers } from "@/lib/db/schema";

export const CustomerQuerySchema = z.object({
  search: z.string().max(200).optional(),
  dni: z.string().max(20).optional(),
  email: z.string().email().optional(),
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(100).default(25),
});

export type CustomerQuery = z.infer<typeof CustomerQuerySchema>;

export interface CustomerRow {
  id: string;
  full_name: string;
  dni: string | null;
  email: string | null;
  phone: string | null;
  created_at: Date | null;
}

/**
 * El filtro, aparte de la consulta: el conteo y la página tienen que usar
 * exactamente el mismo, o la paginación miente.
 */
function armarFiltro(query: CustomerQuery): SQL | undefined {
  const condiciones: SQL[] = [];

  if (query.search) {
    const porNombre = ilikeAny([customers.full_name], query.search);
    if (porNombre) condiciones.push(porNombre);
  }
  if (query.dni) condiciones.push(eq(customers.dni, query.dni));
  if (query.email) condiciones.push(eq(customers.email, query.email));

  return and(...condiciones);
}

export async function listCustomers(
  ctx: TenantContext,
  query: CustomerQuery
): Promise<Pagina<CustomerRow>> {
  // Sin `eq(customers.tenant_id, …)`: el aislamiento lo pone la base con el
  // contexto del lote. Repetirlo acá se lee como si fuera lo que protege.
  const where = armarFiltro(query);
  const offset = (query.page - 1) * query.per_page;

  return paginarEnTenant<CustomerRow>(
    ctx,
    { tabla: customers, where, page: query.page, per_page: query.per_page },
    (db) =>
      db
        .select({
          id: customers.id,
          full_name: customers.full_name,
          dni: customers.dni,
          email: customers.email,
          phone: customers.phone,
          created_at: customers.created_at,
        })
        .from(customers)
        .where(where)
        .orderBy(desc(customers.created_at))
        .limit(query.per_page)
        .offset(offset)
  );
}
