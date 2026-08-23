/**
 * Cartera — todos los clientes, para quien opera el producto.
 *
 * Cruza tenants, así que no es una pantalla del asegurador: mostrarle a un
 * admin de un cliente quiénes son los otros y cuánto pagan sería contarle
 * exactamente lo que no le corresponde. Va detrás de requireOperator, que pide
 * sesión de admin Y dirección del operador.
 *
 * Es de sólo lectura, y es una decisión, no una etapa a medio hacer: dar de
 * alta un cliente ya está escrito y ensayado en `pnpm onboard` → create-tenant,
 * que aplica los términos del plan y avisa qué falta configurar a mano. Repetir
 * ese flujo en un formulario duplicaría la lógica comercial en dos lugares para
 * una operación que pasa una vez por cliente. Lo que faltaba no era darlos de
 * alta: era poder mirarlos sin abrir una consola.
 */

import { redirect } from "next/navigation";

import { requireOperator } from "@/lib/auth/require-operator";
import { AppError } from "@/lib/errors";
import { listTenantSummaries } from "@/server/billing/tenant-summary";

export const dynamic = "force-dynamic";

const money = (n: number) =>
  n.toLocaleString("es-AR", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  trial: "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
  suspended: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  churned: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const STATUS_LABELS: Record<string, string> = {
  active: "Activo",
  trial: "Prueba",
  suspended: "Suspendido",
  churned: "Se fue",
};

export default async function CarteraPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  try {
    await requireOperator();
  } catch (e) {
    if (e instanceof AppError && e.code === "MISSING_SESSION") redirect("/login");
    // Un admin de un asegurador que llega acá por la URL ve su bandeja, no un
    // 403: que la pantalla exista no es algo que le tenga que constar.
    redirect("/bandeja");
  }

  const raw = (await searchParams).month;
  const { month, tenants } = await listTenantSummaries(typeof raw === "string" ? raw : null);

  const totals = tenants.reduce(
    (acc, t) => ({
      revenue: acc.revenue + t.invoice_total_usd,
      cost: acc.cost + t.ai_cost_usd,
      claims: acc.claims + t.billable_claims,
    }),
    { revenue: 0, cost: 0, claims: 0 }
  );

  return (
    <div className="px-6 py-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Cartera</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          La cartera y sus números de {month}. Sólo la ve quien opera ClaimMix.
        </p>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <Stat label="Clientes" value={String(tenants.length)} />
        <Stat label="Denuncias facturables" value={totals.claims.toLocaleString("es-AR")} />
        <Stat label="A facturar" value={money(totals.revenue)} />
        <Stat
          label="Costo de IA"
          value={money(totals.cost)}
          hint={
            totals.revenue > 0
              ? `${Math.round(((totals.revenue - totals.cost) / totals.revenue) * 1000) / 10}% de margen`
              : "sin ingresos todavía"
          }
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
            <tr>
              <th className="px-4 py-2.5 font-medium">Cliente</th>
              <th className="px-4 py-2.5 font-medium">Plan</th>
              <th className="px-4 py-2.5 font-medium">Estado</th>
              <th className="px-4 py-2.5 text-right font-medium">Denuncias</th>
              <th className="px-4 py-2.5 text-right font-medium">A facturar</th>
              <th className="px-4 py-2.5 text-right font-medium">Costo IA</th>
              <th className="px-4 py-2.5 text-right font-medium">Margen</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {tenants.map((t) => (
              <tr key={t.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-900 dark:text-slate-100">{t.name}</p>
                  {t.contact_email && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">{t.contact_email}</p>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                  {t.plan_label}
                  <span className="block text-xs text-slate-400">
                    {money(t.monthly_fee_usd)} · {t.included_claims.toLocaleString("es-AR")} incl.
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      STATUS_STYLES[t.billing_status] ?? STATUS_STYLES.churned
                    }`}
                  >
                    {STATUS_LABELS[t.billing_status] ?? t.billing_status}
                  </span>
                  {t.billing_status === "trial" && t.trial_ends_at && (
                    <span className="block text-xs text-slate-400">
                      hasta {new Date(t.trial_ends_at).toLocaleDateString("es-AR")}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-900 dark:text-slate-100">
                  {t.billable_claims.toLocaleString("es-AR")}
                  {t.total_cases > t.billable_claims && (
                    <span className="block text-xs text-slate-400">
                      de {t.total_cases.toLocaleString("es-AR")} mensajes
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-900 dark:text-slate-100">
                  {money(t.invoice_total_usd)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                  {money(t.ai_cost_usd)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                  {t.margin_pct === null ? "—" : `${t.margin_pct}%`}
                </td>
              </tr>
            ))}

            {tenants.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
                  Todavía no hay clientes.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        Un cliente nuevo se da de alta con{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5 dark:bg-slate-800">
          node scripts/create-tenant.mjs --name &quot;…&quot; --plan operativo --apply
        </code>
        , que aplica los términos del plan e imprime lo que queda por configurar a mano. El alta
        entera se ensaya sobre un tenant descartable con{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5 dark:bg-slate-800">pnpm onboard</code>.
      </p>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900">
      <p className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
        {value}
      </p>
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{hint}</p>}
    </div>
  );
}
