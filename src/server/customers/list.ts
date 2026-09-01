/**
 * El padrón de clientes, paginado y filtrado.
 *
 * Vivía adentro del route handler, que además hacía la sesión, la guarda de rol,
 * el límite de tráfico y el armado de la respuesta. Cinco responsabilidades en
 * un archivo significa que para probar el filtro por DNI había que fabricar una
 * petición HTTP con sesión.
 */

import "server-only";

import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { interpretarBusqueda } from "@/core/matching/busqueda-libre";
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
 *
 * ── `search` busca por lo mismo que dice la caja ────────────────────────────
 *
 * Buscaba sólo por `full_name`. La pantalla de `/clientes` —cuya caja promete
 * «nombre, DNI o email»— se arregló en su momento, pero lo hizo armando SU
 * PROPIA consulta en el componente, sin tocar esto. Con lo cual el defecto
 * siguió vivo un piso más abajo: `GET /api/customers?search=27654321` contesta
 * «no hay clientes», que es indistinguible de que esa persona no esté en el
 * padrón.
 *
 * Ahora las dos entran por acá, y la interpretación del término la hace
 * `interpretarBusqueda`, que es la misma que usa el buscador de casos: decide
 * si lo que escribieron parece un DNI o un correo, con las guardas que eso
 * necesita —«Ana» no puede normalizar a la cadena vacía y devolver a todo el
 * que tenga el documento en blanco—.
 *
 * `dni` y `email` siguen existiendo como filtros exactos aparte: un cliente de
 * la API que sabe cuál de los dos tiene no debería pagar el OR.
 */
export function armarFiltroDeBusqueda(
  query: CustomerQuery
): SQL | undefined {
  const condiciones: SQL[] = [];

  if (query.search) {
    const termino = interpretarBusqueda(query.search);
    if (termino) {
      /*
       * `ilikeAny` y no un `ilike` a mano: escapa la barra invertida, el `%` y
       * el `_`, que en un patrón LIKE son comodines. Sin eso, buscar «_»
       * devuelve el padrón entero —cada guión bajo empareja cualquier
       * carácter— y quien busca no tiene forma de saber que le contestaron
       * cualquier cosa. Es justo lo que hacía la copia de esta consulta que
       * vivía en la pantalla.
       */
      const porTexto = ilikeAny(
        [customers.full_name, customers.email],
        termino.nombre
      );
      const alternativas: SQL[] = porTexto ? [porTexto] : [];

      // El padrón guarda `27654321` y la persona escribe `27.654.321`: se
      // comparan los dígitos pelados de los dos lados.
      if (termino.dni) {
        alternativas.push(
          sql`regexp_replace(coalesce(${customers.dni}, ''), '[^0-9]', '', 'g') = ${termino.dni}`
        );
      }
      // Para cuando pegan la dirección entera. El `ilike` de arriba ya cubre
      // las parciales.
      if (termino.email) {
        alternativas.push(sql`lower(${customers.email}) = ${termino.email}`);
      }

      const libre = or(...alternativas);
      if (libre) condiciones.push(libre);
    }
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
  const where = armarFiltroDeBusqueda(query);
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
