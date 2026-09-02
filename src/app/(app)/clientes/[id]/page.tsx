/**
 * Customer detail page — Server Component.
 *
 * Shows customer personal info, list of policies, and list of cases.
 * Explicit tenant_id filter on every query (RLS removed).
 *
 * Protected by proxy.ts — unauthenticated access redirects to /login.
 * IDOR: tenant_id check enforced explicitly in every query.
 */

import { notFound, redirect } from "next/navigation";
import { getSessionContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { eq, and, desc, count } from "drizzle-orm";
import { cases, customers, policies, users } from "@/lib/db/schema";
import { CUSTOMER_PII_ROLES } from "@/lib/auth/require-role";
import { getT } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";
import { StatusBadge } from "@/app/(app)/bandeja/components/StatusBadge";
import { SeverityBadge } from "@/app/(app)/bandeja/components/SeverityBadge";
import { formatDate, formatDateOnly, formatAge } from "@/lib/utils";
import Link from "next/link";
import type { CaseStatus, ClaimType } from "@/lib/schemas/cases";

interface CustomerDetailPageProps {
  params: Promise<{ id: string }>;
}

interface Policy {
  id: string;
  policy_number: string;
  policy_type: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
}

interface CustomerCase {
  id: string;
  created_at: string;
  status: string;
  severity: string | null;
  claim_type: string | null;
}

interface Customer {
  id: string;
  full_name: string;
  dni: string | null;
  email: string | null;
  phone: string | null;
  created_at: string;
}

/*
 * Los tres estados, en la paleta que el modo oscuro sabe pintar.
 *
 * «Activa» era `bg-green-100 text-green-800`, y la familia `green` es la única
 * que `globals.css` no pisa en oscuro —la palabra no aparece en el archivo—.
 * O sea que de los tres estados, los dos problemáticos se oscurecían y el bueno
 * quedaba verde menta sobre una tarjeta oscura: la codificación al revés, el
 * estado normal gritando y los que importan apagados.
 *
 * `emerald` es el par de «éxito» que ya usa StatusBadge y que sí está pisado.
 */
const POLICY_STATUS_CLASSES: Record<string, string> = {
  active: "bg-emerald-50 text-emerald-700",
  expired: "bg-slate-100 text-slate-600",
  cancelled: "bg-red-100 text-red-700",
};

/** Cuántos siniestros se dibujan. El total se cuenta aparte y se muestra igual. */
const MAX_CASOS = 50;

/** Format case UUID to short SIN-XXXX-XXXX display string */
function formatCaseNumber(id: string): string {
  const suffix = id.replace(/-/g, "").slice(-8).toUpperCase();
  return `SIN-${suffix.slice(0, 4)}-${suffix.slice(4)}`;
}

export default async function CustomerDetailPage({
  params,
}: CustomerDetailPageProps) {
  const { id } = await params;
  const locale = await getServerLocale();
  const t = getT(locale);

  /*
   * Los tipos y estados de póliza, que estaban en castellano en duro.
   *
   * Con la interfaz en inglés la tabla quedaba «Policy number / Type / Status»
   * con celdas «Automóvil» y «Activa». El botón EN está a un clic en la barra
   * de arriba.
   */
  const POLICY_TYPE_LABELS: Record<string, string> = {
    auto: t("clientes.policyType.auto"),
    home: t("clientes.policyType.home"),
    life: t("clientes.policyType.life"),
    business: t("clientes.policyType.business"),
    other: t("clientes.policyType.other"),
  };

  const POLICY_STATUS_LABELS: Record<string, string> = {
    active: t("clientes.policyStatus.active"),
    expired: t("clientes.policyStatus.expired"),
    cancelled: t("clientes.policyStatus.cancelled"),
  };

  /*
   * Los tipos de siniestro traducidos, como en todas las demás pantallas.
   *
   * Acá la celda era `{c.claim_type}` con `capitalize`: el mismo caso que en la
   * bandeja dice «Resp. Civil» decía «Rc», y el que dice «Robo de contenido»
   * decía «Robo_contenido». Alguien que abre la ficha de un cliente para ver su
   * historial leía claves de base de datos.
   */
  const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
    choque: t("type.choque"),
    robo: t("type.robo"),
    granizo: t("type.granizo"),
    incendio: t("type.incendio"),
    cristales: t("type.cristales"),
    rc: t("type.rc"),
    robo_contenido: t("type.robo_contenido"),
    accidente_personal: t("type.accidente_personal"),
    other: t("type.other"),
  };

  const session = await getSessionContext();
  if (!session?.user) notFound();
  // sin-inquilino: Ésta es la consulta que AVERIGUA de qué inquilino es la sesión.
  // No puede pasar por una capa que necesita el dato que ella busca.
  const [userRow] = await db
    .select({ tenant_id: users.tenant_id, role: users.role })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  // Este contexto es lo único que le dice de quién son los datos.
  // El chequeo va ANTES de leerle un campo: estaba al revés, así que una
  // sesión sin perfil reventaba en la línea de arriba en vez de caer acá.
  if (!userRow) notFound();

  /*
   * Y el mismo rol que exige /api/customers.
   *
   * Esta pantalla muestra DNI, correo y teléfono de un cliente y no chequeaba
   * rol: un analista los veía por acá y recibía 403 pidiéndolos por la API.
   */
  if (!(CUSTOMER_PII_ROLES as string[]).includes(userRow.role)) redirect("/bandeja");

  const tenantCtx: TenantContext = { tenantId: userRow.tenant_id };

  /*
   * El id de la URL contra una columna `uuid`, sin creerle a la URL.
   *
   * Esto era `await enTenant(...)` pelado, y `id` viaja crudo desde la barra de
   * direcciones a un `eq()` contra una columna `uuid`. Una letra de más y
   * Postgres tira «invalid input syntax for type uuid», que sube hasta el
   * componente y sale como «Application error» — la pantalla entera en blanco
   * por una URL mal tipeada.
   *
   * `/casos/[id]` ya resuelve esto igual, y por eso contesta 404 en el mismo
   * caso: envuelve la consulta y devuelve null (src/server/cases/get.ts:77).
   * Un id que no existe y un id que no puede existir son la misma respuesta.
   */
  const customer = await enTenant(tenantCtx, (db) =>
    db
      .select({ id: customers.id, full_name: customers.full_name, dni: customers.dni, email: customers.email, phone: customers.phone, created_at: customers.created_at })
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1)
  )
    .then((filas) => filas[0])
    .catch(() => undefined);

  if (!customer) notFound();

  // Fetch policies + cases in parallel
  const [policiesData, casesData, [casesCountRow]] = await Promise.all([
    enTenant(tenantCtx, (db) =>
      db
        .select({ id: policies.id, policy_number: policies.policy_number, policy_type: policies.policy_type, status: policies.status, start_date: policies.start_date, end_date: policies.end_date })
        .from(policies)
        .where(eq(policies.customer_id, id))
        .orderBy(desc(policies.created_at))
    ),
    enTenant(tenantCtx, (db) =>
      db
        .select({ id: cases.id, created_at: cases.created_at, status: cases.status, severity: cases.severity, claim_type: cases.claim_type })
        .from(cases)
        .where(eq(cases.customer_id, id))
        .orderBy(desc(cases.created_at))
        .limit(MAX_CASOS)
    ),
    /*
     * El total de siniestros, que no es lo mismo que los que se dibujan.
     *
     * El encabezado decía `({customerCases.length})` sobre una consulta con
     * `.limit(50)`: un cliente con 63 siniestros leía «Siniestros (50)» y se
     * quedaba sin trece, sin que nada en la pantalla lo dijera. Un conteo que
     * copia el largo de la página no es un conteo, es el largo de la página.
     */
    enTenant(tenantCtx, (db) =>
      db.select({ n: count() }).from(cases).where(eq(cases.customer_id, id))
    ),
  ]);

  const customerPolicies: Policy[] = policiesData;
  const customerCases: CustomerCase[] = casesData;
  const totalCasos = casesCountRow?.n ?? customerCases.length;
  const casosRecortados = totalCasos > customerCases.length;

  return (
    <div className="px-6 py-6 max-w-5xl mx-auto">
      {/* Back button */}
      <div className="mb-4">
        <Link
          href="/clientes"
          className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 transition-colors"
          aria-label={t("clientes.back")}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-4 h-4"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M17 10a.75.75 0 0 1-.75.75H5.612l4.158 3.96a.75.75 0 1 1-1.04 1.08l-5.5-5.25a.75.75 0 0 1 0-1.08l5.5-5.25a.75.75 0 1 1 1.04 1.08L5.612 9.25H16.25A.75.75 0 0 1 17 10Z"
              clipRule="evenodd"
            />
          </svg>
          {t("clientes.back")}
        </Link>
      </div>

      {/* Header card — personal info */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 mb-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900 mb-4">
          {customer.full_name}
        </h1>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
          <div>
            <dt className="text-slate-500">{t("clientes.col.dni")}</dt>
            <dd className="mt-0.5 font-mono font-medium text-slate-900">
              {customer.dni ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("clientes.col.email")}</dt>
            <dd className="mt-0.5 text-slate-900">{customer.email ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("clientes.col.phone")}</dt>
            <dd className="mt-0.5 text-slate-900">{customer.phone ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-slate-500">{t("clientes.col.createdAt")}</dt>
            <dd className="mt-0.5 text-slate-900">
              {customer.created_at ? formatDate(customer.created_at) : "—"}
            </dd>
          </div>
        </dl>
      </div>

      {/* Two-section layout */}
      <div className="flex flex-col gap-6">
        {/* Policies */}
        <section
          aria-labelledby="policies-heading"
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <h2
            id="policies-heading"
            className="text-sm font-semibold text-slate-900 mb-4"
          >
            {t("clientes.detail.policies")}
            <span className="ml-2 text-slate-400 font-normal">
              ({customerPolicies.length})
            </span>
          </h2>
          {customerPolicies.length === 0 ? (
            <p className="text-sm text-slate-400">
              {t("clientes.detail.noPolicies")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table
                className="w-full table-auto text-left"
                aria-label={t("clientes.detail.policies")}
              >
                <thead>
                  <tr>
                    {[
                      t("clientes.detail.policyNumber"),
                      t("clientes.detail.policyType"),
                      t("clientes.detail.policyStatus"),
                      t("clientes.detail.validFrom"),
                      t("clientes.detail.validTo"),
                    ].map((col) => (
                      <th
                        key={col}
                        scope="col"
                        className="border-b border-slate-200 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500 px-3 first:pl-0 last:pr-0"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {customerPolicies.map((policy) => (
                    <tr
                      key={policy.id}
                      className="border-b border-slate-100 last:border-0"
                    >
                      <td className="py-2.5 px-3 first:pl-0 font-mono text-sm text-slate-800">
                        {policy.policy_number}
                      </td>
                      <td className="py-2.5 px-3 text-sm text-slate-700">
                        {POLICY_TYPE_LABELS[policy.policy_type] ??
                          policy.policy_type}
                      </td>
                      <td className="py-2.5 px-3">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                            POLICY_STATUS_CLASSES[policy.status] ??
                            "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {POLICY_STATUS_LABELS[policy.status] ??
                            policy.status}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-sm text-slate-600 whitespace-nowrap">
                        {policy.start_date
                          ? formatDateOnly(policy.start_date)
                          : "—"}
                      </td>
                      <td className="py-2.5 px-3 text-sm text-slate-600 whitespace-nowrap last:pr-0">
                        {policy.end_date ? formatDateOnly(policy.end_date) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Cases */}
        <section
          aria-labelledby="cases-heading"
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        >
          <h2
            id="cases-heading"
            className="text-sm font-semibold text-slate-900 mb-4"
          >
            {t("clientes.detail.cases")}
            <span className="ml-2 text-slate-400 font-normal">
              ({totalCasos})
            </span>
          </h2>
          {/* Y si no entran todos, que la pantalla lo diga en vez de recortar
              trece en silencio. */}
          {casosRecortados && (
            <p className="-mt-2 mb-4 text-xs text-slate-500">
              {t("bandeja.showing")} {customerCases.length}{" "}
              {t("pagination.of")} {totalCasos} {t("bandeja.claims")}
            </p>
          )}
          {customerCases.length === 0 ? (
            <p className="text-sm text-slate-400">
              {t("clientes.detail.noCases")}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table
                className="w-full table-auto text-left"
                aria-label={t("clientes.detail.cases")}
              >
                <thead>
                  <tr>
                    {[
                      t("table.col.id"),
                      t("table.col.received"),
                      t("table.col.status"),
                      t("case.detail.severity"),
                      t("table.col.type"),
                    ].map((col) => (
                      <th
                        key={col}
                        scope="col"
                        className="border-b border-slate-200 pb-2 pt-1 text-xs font-semibold uppercase tracking-wide text-slate-500 px-3 first:pl-0 last:pr-0"
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {customerCases.map((c) => (
                    <tr
                      key={c.id}
                      className="border-b border-slate-100 last:border-0"
                    >
                      <td className="py-2.5 px-3 first:pl-0">
                        <Link
                          href={`/casos/${c.id}`}
                          className="font-mono text-xs text-blue-600 hover:underline"
                        >
                          {formatCaseNumber(c.id)}
                        </Link>
                      </td>
                      {/* La columna decía «Fecha» y dibujaba «Hace 63d»: la
                          fecha del siniestro no estaba en la pantalla. Van las
                          dos, apiladas como en el detalle del caso — arriba lo
                          que se lee de un vistazo, abajo el dato exacto. */}
                      <td className="py-2.5 px-3 text-sm text-slate-600 whitespace-nowrap">
                        <span className="whitespace-nowrap">
                          {formatAge(c.created_at)}
                        </span>
                        <span className="mt-0.5 block whitespace-nowrap text-[12.5px] text-slate-500">
                          {formatDate(c.created_at)}
                        </span>
                      </td>
                      <td className="py-2.5 px-3">
                        <StatusBadge status={c.status as CaseStatus} />
                      </td>
                      <td className="py-2.5 px-3">
                        {c.severity ? (
                          <SeverityBadge severity={c.severity} />
                        ) : (
                          <span className="text-slate-300 text-xs">—</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-sm text-slate-700 last:pr-0">
                        {c.claim_type ? (
                          CLAIM_TYPE_LABELS[c.claim_type as ClaimType] ??
                          c.claim_type
                        ) : (
                          <span className="text-slate-300 text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
