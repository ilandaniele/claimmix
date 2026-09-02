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
import { formatDate, formatUsd } from "@/lib/utils";

import { getT, type TranslationKey } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";
import { requireOperator } from "@/lib/auth/require-operator";
import { AppError } from "@/lib/errors";
import { listTenantSummaries } from "@/server/billing/tenant-summary";

export const dynamic = "force-dynamic";

// Uno solo para todo el producto: ver formatUsd en lib/utils.
const money = (n: number) => formatUsd(n);

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  trial: "bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300",
  suspended: "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  churned: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

// El mapa guarda claves del diccionario, no textos: el rótulo lo resuelve `t`
// adentro del componente, que es el único lugar donde se sabe el idioma.
const STATUS_LABELS: Record<string, TranslationKey> = {
  active: "cartera.estado.active",
  trial: "cartera.estado.trial",
  suspended: "cartera.estado.suspended",
  churned: "cartera.estado.churned",
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

  const locale = await getServerLocale();
  const t = getT(locale);

  const raw = (await searchParams).month;
  const { month, tenants } = await listTenantSummaries(typeof raw === "string" ? raw : null);

  const totals = tenants.reduce(
    (acc, fila) => ({
      revenue: acc.revenue + fila.invoice_total_usd,
      cost: acc.cost + fila.ai_cost_usd,
      claims: acc.claims + fila.billable_claims,
    }),
    { revenue: 0, cost: 0, claims: 0 }
  );

  return (
    <div className="px-6 py-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          {t("cartera.title")}
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {t("cartera.subtitle")} {month}. {t("cartera.subtitleOperator")}
        </p>
      </div>

      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <Stat label={t("cartera.stat.clientes")} value={String(tenants.length)} />
        <Stat label={t("cartera.stat.denuncias")} value={totals.claims.toLocaleString("es-AR")} />
        <Stat label={t("cartera.aFacturar")} value={money(totals.revenue)} />
        <Stat
          label={t("cartera.stat.costoIa")}
          value={money(totals.cost)}
          hint={
            totals.revenue > 0
              ? `${Math.round(((totals.revenue - totals.cost) / totals.revenue) * 1000) / 10}% ${t("cartera.deMargen")}`
              : t("cartera.sinIngresos")
          }
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
            <tr>
              <th className="px-4 py-2.5 font-medium">{t("cartera.col.cliente")}</th>
              <th className="px-4 py-2.5 font-medium">{t("cartera.col.plan")}</th>
              <th className="px-4 py-2.5 font-medium">{t("table.col.status")}</th>
              <th className="px-4 py-2.5 text-right font-medium">{t("cartera.col.denuncias")}</th>
              <th className="px-4 py-2.5 text-right font-medium">{t("cartera.aFacturar")}</th>
              <th className="px-4 py-2.5 text-right font-medium">{t("cartera.col.costoIa")}</th>
              <th className="px-4 py-2.5 text-right font-medium">{t("cartera.col.margen")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {tenants.map((fila) => (
              <tr key={fila.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                <td className="px-4 py-3">
                  <p className="font-medium text-slate-900 dark:text-slate-100">{fila.name}</p>
                  {fila.contact_email && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      {fila.contact_email}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                  {fila.plan_label}
                  <span className="block text-xs text-slate-400">
                    {money(fila.monthly_fee_usd)} · {fila.included_claims.toLocaleString("es-AR")}{" "}
                    {t("cartera.incluidas")}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                      STATUS_STYLES[fila.billing_status] ?? STATUS_STYLES.churned
                    }`}
                  >
                    {STATUS_LABELS[fila.billing_status]
                      ? t(STATUS_LABELS[fila.billing_status])
                      : fila.billing_status}
                  </span>
                  {fila.billing_status === "trial" && fila.trial_ends_at && (
                    <span className="block text-xs text-slate-400">
                      {t("cartera.hasta")}{" "}
                      {formatDate(fila.trial_ends_at, locale, {
                        hour: undefined,
                        minute: undefined,
                      })}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-900 dark:text-slate-100">
                  {fila.billable_claims.toLocaleString("es-AR")}
                  {fila.total_cases > fila.billable_claims && (
                    <span className="block text-xs text-slate-400">
                      {t("pagination.of")} {fila.total_cases.toLocaleString("es-AR")}{" "}
                      {t("cartera.mensajes")}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-900 dark:text-slate-100">
                  {money(fila.invoice_total_usd)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                  {money(fila.ai_cost_usd)}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-600 dark:text-slate-300">
                  {fila.margin_pct === null ? "—" : `${fila.margin_pct}%`}
                </td>
              </tr>
            ))}

            {tenants.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-slate-500 dark:text-slate-400">
                  {t("cartera.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
        {t("cartera.ayuda.alta")}{" "}
        <code className="rounded bg-slate-100 px-1 py-0.5 dark:bg-slate-800">
          node scripts/create-tenant.mjs --name &quot;…&quot; --plan operativo --apply
        </code>
        {t("cartera.ayuda.aplica")}{" "}
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
