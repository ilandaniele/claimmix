/**
 * Clientes page — Server Component.
 *
 * Lists customers for the authenticated user's tenant (RLS-enforced).
 * Supports search by full_name, DNI, or email.
 *
 * Protected by proxy.ts — unauthenticated access redirects to /login.
 */

import { Suspense } from "react";
import { getSessionContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { users } from "@/lib/db/schema";
import { CUSTOMER_PII_ROLES } from "@/lib/auth/require-role";
import { redirect } from "next/navigation";
import { getT } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";
import Link from "next/link";
import { formatDate } from "@/lib/utils";
import { listCustomers } from "@/server/customers/list";

/*
 * La fila la define `listCustomers`, no esta pantalla.
 *
 * Había una interfaz `Customer` escrita acá que declaraba `created_at: string`
 * cuando la columna vuelve como `Date | null`, y un `as Customer[]` más abajo
 * que hacía pasar la mentira. `formatDate` acepta las dos formas, así que nunca
 * se rompió — pero un cast que tapa una diferencia real es cómo se rompe el día
 * que alguien le haga `.slice()` a esa fecha creyendo que es un texto.
 */

interface ClientesPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

async function ClientesContent({ searchParams }: ClientesPageProps) {
  const locale = await getServerLocale();
  const t = getT(locale);
  const params = await searchParams;

  const searchParam = params["search"];
  const pageParam = params["page"];

  const search =
    typeof searchParam === "string" && searchParam.trim()
      ? searchParam.trim()
      : undefined;

  const page =
    typeof pageParam === "string"
      ? Math.max(1, parseInt(pageParam, 10) || 1)
      : 1;

  const PER_PAGE = 25;

  const session = await getSessionContext();
  if (!session?.user) redirect("/login");
  // sin-inquilino: Ésta es la consulta que AVERIGUA de qué inquilino es la sesión.
  // No puede pasar por una capa que necesita el dato que ella busca.
  const [userRow] = await db
    .select({ tenant_id: users.tenant_id, role: users.role })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  if (!userRow) redirect("/login");

  /*
   * Quién puede ver esto: el mismo rol que exige /api/customers.
   *
   * Esta pantalla no chequeaba rol. Leía el inquilino y listaba nombre, DNI,
   * correo y teléfono de todos los clientes — o sea que un analista veía por
   * acá exactamente los datos que la API que los sirve le niega con un 403.
   * El enlace además está en la barra lateral sin condición de rol.
   *
   * El propio repo lo dice en (app)/layout.tsx: esconder un enlace no es una
   * guarda. Acá no estaba escondido ni guardado.
   */
  if (!(CUSTOMER_PII_ROLES as string[]).includes(userRow.role)) redirect("/bandeja");

  const tenantId = userRow.tenant_id;

  /*
   * La búsqueda la hace `listCustomers`, que es de donde también sale
   * `/api/customers`.
   *
   * Acá vivía una segunda implementación, escrita a mano en el componente
   * —`or(ilike(full_name), ilike(email), …)` más su propio conteo—. Es la que
   * se arregló el día que la caja prometía «nombre, DNI o email» y se buscaba
   * sólo por nombre; el módulo extraído, que se había extraído justamente para
   * poder probar el filtro sin fabricar una petición HTTP, quedó atrás.
   *
   * Dos implementaciones de la misma búsqueda no se quedan iguales, y éstas ya
   * habían divergido en dos cosas:
   *
   *   · la API seguía buscando sólo por nombre;
   *   · y esta pantalla armaba el patrón LIKE sin escapar, así que un `%` o un
   *     `_` en lo que escribe la persona son comodines. Buscar «_» devolvía el
   *     padrón entero. `ilikeAny` —que usa el módulo— escapa los tres.
   *
   * De paso, el conteo y la página dejan de ser dos viajes: `listCustomers`
   * los manda en un solo lote, con el MISMO `where` para los dos —que es lo que
   * evita que el paginador prometa páginas que no existen—.
   */
  const { data: customersData, meta } = await listCustomers(
    { tenantId },
    { search, page, per_page: PER_PAGE }
  );

  const total = meta.total;
  const totalPages = Math.max(1, meta.pages);

  return (
    <div className="flex flex-col h-full">
      {/* Page header */}
      <div className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-semibold text-slate-900">
              {t("clientes.title")}
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {t("clientes.subtitle")}
            </p>
          </div>
        </div>

        {/* Search bar */}
        <form method="GET" className="flex items-center gap-2">
          <div className="relative flex-1 max-w-sm">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z"
                clipRule="evenodd"
              />
            </svg>
            <input
              type="search"
              name="search"
              defaultValue={search}
              placeholder={t("clientes.search")}
              className="w-full rounded-md border border-slate-300 bg-white pl-9 pr-3 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-400"
              aria-label={t("clientes.search")}
            />
          </div>
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 transition-colors"
          >
            Buscar
          </button>
          {search && (
            <Link
              href="/clientes"
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              Limpiar
            </Link>
          )}
        </form>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {!customersData || customersData.length === 0 ? (
          <div
            className="py-16 text-center text-sm text-slate-500"
            role="status"
          >
            {t("clientes.empty")}
          </div>
        ) : (
          <div className="overflow-x-auto" role="region" aria-label="Tabla de clientes">
            <table
              className="w-full table-auto text-left"
              aria-label="Clientes"
            >
              <thead>
                <tr>
                  {[
                    t("clientes.col.name"),
                    t("clientes.col.dni"),
                    t("clientes.col.email"),
                    t("clientes.col.phone"),
                    t("clientes.col.createdAt"),
                  ].map((col) => (
                    <th
                      key={col}
                      scope="col"
                      className="border-b border-slate-200 pb-3 pt-2 text-xs font-semibold uppercase tracking-wide text-slate-500 px-3 first:pl-0 last:pr-0"
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {customersData.map((customer) => (
                  <tr
                    key={customer.id}
                    className="border-b border-slate-100 hover:bg-slate-50 transition-colors"
                  >
                    <td className="py-3 px-3 first:pl-0">
                      <Link
                        href={`/clientes/${customer.id}`}
                        className="text-sm font-medium text-blue-600 hover:underline"
                      >
                        {customer.full_name}
                      </Link>
                    </td>
                    <td className="py-3 px-3 text-sm text-slate-600 font-mono">
                      {customer.dni ?? "—"}
                    </td>
                    <td className="py-3 px-3 text-sm text-slate-600">
                      {customer.email ?? "—"}
                    </td>
                    <td className="py-3 px-3 text-sm text-slate-600">
                      {customer.phone ?? "—"}
                    </td>
                    <td className="py-3 px-3 text-sm text-slate-500 whitespace-nowrap last:pr-0">
                      {customer.created_at
                        ? formatDate(customer.created_at)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {Number(total) > 0 && (
          <div className="flex items-center justify-between pt-4 border-t border-slate-100">
            <p className="text-sm text-slate-500">
              Mostrando {Math.min((page - 1) * PER_PAGE + 1, Number(total))}–
              {Math.min(page * PER_PAGE, Number(total))} de {Number(total)} clientes
            </p>
            <div className="flex items-center gap-2">
              {page > 1 && (
                <Link
                  href={`/clientes?${new URLSearchParams({ ...(search ? { search } : {}), page: String(page - 1) }).toString()}`}
                  className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
                >
                  {t("pagination.previous")}
                </Link>
              )}
              <span className="text-sm text-slate-500">
                {page} / {totalPages}
              </span>
              {page < totalPages && (
                <Link
                  href={`/clientes?${new URLSearchParams({ ...(search ? { search } : {}), page: String(page + 1) }).toString()}`}
                  className="rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
                >
                  {t("pagination.next")}
                </Link>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ClientesLoading() {
  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-slate-200 bg-white px-6 py-4">
        <div className="h-7 w-32 bg-slate-200 rounded animate-pulse mb-4" />
        <div className="h-8 w-64 bg-slate-100 rounded animate-pulse" />
      </div>
      <div className="px-6 py-4 space-y-3">
        {[...Array(8)].map((_, i) => (
          <div key={i} className="h-12 bg-slate-50 rounded animate-pulse" />
        ))}
      </div>
    </div>
  );
}

export default function ClientesPage(props: ClientesPageProps) {
  return (
    <Suspense fallback={<ClientesLoading />}>
      <ClientesContent {...props} />
    </Suspense>
  );
}
