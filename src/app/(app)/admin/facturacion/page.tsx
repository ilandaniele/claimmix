/**
 * Facturación — qué se le cobra a este cliente por un mes, y qué costó.
 *
 * La cifra ya existía en /api/admin/billing y no la miraba nadie, porque para
 * verla había que armar un curl con una cookie de sesión. Una factura que sólo
 * se puede consultar por API es una factura que se emite de memoria.
 *
 * Server Component: llama a getStatement directo, sin dar la vuelta por HTTP a
 * su propio deploy. La navegación entre meses son enlaces, no estado de
 * cliente — así cada mes tiene su URL y se puede compartir.
 *
 * Muestra las cuatro categorías y no sólo el total, que es lo mismo que
 * devuelve la API y por el mismo motivo: una factura hay que poder defenderla
 * línea por línea cuando el cliente pregunta por qué le llegó ese número.
 */

import Link from "next/link";
import { formatUsd } from "@/lib/utils";
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth/require-admin";
import { AppError } from "@/lib/errors";
import { resolveBillingPeriod } from "@/lib/billing/period";
import { getStatement } from "@/server/billing/statement";
import { getT, type Locale } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";

export const dynamic = "force-dynamic";

// Uno solo para todo el producto: ver formatUsd en lib/utils.
const money = (n: number) => formatUsd(n);

/**
 * `2026-03` → `marzo de 2026`, para que el encabezado se lea como una fecha.
 *
 * El nombre del mes sigue al idioma, así que el locale entra por parámetro: es
 * una función de módulo y acá no hay `t`. `nombreDelMesArgentino` no sirve
 * porque recibe una fecha y fija `es-AR` adentro. La zona sigue siendo UTC — el
 * `Date` se arma en UTC en la línea de abajo, y formatearlo en otra zona lo
 * correría al mes anterior.
 */
function monthLabel(month: string, locale: Locale): string {
  const [year, m] = month.split("-");
  const date = new Date(Date.UTC(Number(year), Number(m) - 1, 1));
  return date.toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
}

function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split("-");
  const date = new Date(Date.UTC(Number(year), Number(m) - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function FacturacionPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  let ctx: Awaited<ReturnType<typeof requireAdmin>>;
  try {
    ctx = await requireAdmin();
  } catch (e) {
    if (e instanceof AppError && e.code === "MISSING_SESSION") redirect("/login");
    redirect("/bandeja");
  }

  const locale = await getServerLocale();
  const t = getT(locale);

  const raw = (await searchParams).month;
  const requested = typeof raw === "string" ? raw : null;

  // Un mes mal escrito no puede caer al mes actual sin decirlo: el número que
  // saldría es perfectamente plausible y sería de otro período.
  const range = resolveBillingPeriod(requested);
  if (!range) {
    return (
      <div className="px-6 py-8 max-w-3xl">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
          {t("nav.facturacion")}
        </h1>
        <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          <strong>{String(requested)}</strong> {t("facturacion.periodoInvalido")}{" "}
          {t("facturacion.periodoEsperado")} <code>{t("facturacion.formatoPeriodo")}</code>.{" "}
          <Link href="/admin/facturacion" className="underline">
            {t("facturacion.verMesEnCurso")}
          </Link>
        </p>
      </div>
    );
  }

  const statement = await getStatement(ctx.userRow.tenant_id, range);
  if (!statement) redirect("/bandeja");

  const { volume, invoice, ai_cost: cost, margin, tenant } = statement;
  const current = resolveBillingPeriod(null)!.month;

  return (
    <div className="px-6 py-8 max-w-5xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            {t("nav.facturacion")}
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {tenant.name} · {t("facturacion.plan").replace("{n}", tenant.plan_label)} ·{" "}
            {monthLabel(statement.month, locale)}
          </p>
        </div>

        <nav className="flex items-center gap-1 text-sm" aria-label={t("facturacion.cambiarMes")}>
          <Link
            href={`/admin/facturacion?month=${shiftMonth(statement.month, -1)}`}
            className="rounded-md border border-slate-200 px-2.5 py-1.5 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            ← {t("facturacion.mesAnterior")}
          </Link>
          {statement.month !== current && (
            <Link
              href={`/admin/facturacion?month=${shiftMonth(statement.month, 1)}`}
              className="rounded-md border border-slate-200 px-2.5 py-1.5 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              {t("facturacion.mesSiguiente")} →
            </Link>
          )}
        </nav>
      </div>

      {/*
        Que el número pueda moverse o no es parte de la respuesta: un mes en
        curso sube con cada denuncia que entra, y uno cerrado ya no cambia
        nunca. Sin decirlo, las dos cifras se ven iguales.
      */}
      <p
        className={`mb-6 rounded-md border px-4 py-2.5 text-sm ${
          statement.frozen
            ? "border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300"
            : "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-900/40 dark:bg-blue-950/30 dark:text-blue-200"
        }`}
      >
        {statement.frozen ? (
          <>
            <strong>{t("facturacion.periodoCerrado")}</strong>{" "}
            {t("facturacion.cerradoAntesDeLaFecha")}{" "}
            {new Date(statement.frozen_at!).toLocaleDateString(locale, { timeZone: "UTC" })}{" "}
            {t("facturacion.cerradoDespuesDeLaFecha")}
          </>
        ) : (
          <>
            <strong>{t("facturacion.mesEnCurso")}</strong> {t("facturacion.mesEnCursoDetalle")}
          </>
        )}
      </p>

      <div className="grid gap-6 md:grid-cols-2">
        {/* ── Lo que se cobra ─────────────────────────────────────────────── */}
        <section className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t("facturacion.aFacturar")}
          </h2>

          <dl className="mt-4 space-y-2.5 text-sm">
            {/*
              El único `{n}` de la pantalla: el nombre del plan va detrás en
              castellano («Abono Profesional») y delante en inglés, así que acá
              no alcanza con pegar dos claves sueltas.
            */}
            <Row
              label={t("facturacion.abonoPlan").replace("{n}", tenant.plan_label)}
              value={money(invoice.monthly_fee_usd)}
            />
            <Row
              label={t("facturacion.denunciasIncluidas")}
              value={`${invoice.claims.toLocaleString("es-AR")} ${t("pagination.of")} ${invoice.included_claims.toLocaleString("es-AR")}`}
            />
            <Row
              label={`${t("facturacion.excedente")} (${invoice.overage_claims} × ${money(invoice.overage_price_usd)})`}
              value={money(invoice.overage_total_usd)}
            />
            <div className="!mt-4 flex items-center justify-between border-t border-slate-200 pt-3 dark:border-slate-700">
              <dt className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {t("facturacion.total")}
              </dt>
              <dd className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                {money(invoice.total_usd)}
              </dd>
            </div>
          </dl>
        </section>

        {/* ── Lo que costó ────────────────────────────────────────────────── */}
        <section className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t("facturacion.loQueCosto")}
          </h2>

          <dl className="mt-4 space-y-2.5 text-sm">
            <Row
              label={t("facturacion.llamadasAlModelo")}
              value={cost.calls.toLocaleString("es-AR")}
            />
            <Row label={t("facturacion.costoDeIa")} value={money(cost.cost_usd)} />
            <Row
              label={t("facturacion.porDenunciaFacturable")}
              value={money(cost.cost_per_billable_claim_usd)}
            />
            <div className="!mt-4 flex items-center justify-between border-t border-slate-200 pt-3 dark:border-slate-700">
              <dt className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {t("facturacion.margen")}
              </dt>
              <dd className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                {margin.margin_pct === null ? (
                  <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
                    {t("facturacion.sinIngresos")}
                  </span>
                ) : (
                  <>
                    {money(margin.margin_usd)}{" "}
                    <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
                      ({margin.margin_pct}%)
                    </span>
                  </>
                )}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      {/* ── De dónde sale el número ───────────────────────────────────────── */}
      <section className="mt-6 rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          {t("facturacion.deDondeSale")}
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          {t("facturacion.deDondeSaleDetalle")}
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <Bucket
            label={t("facturacion.bucket.facturables")}
            value={volume.billable_claims}
            accent
          />
          <Bucket
            label={t("facturacion.bucket.noEranDenuncias")}
            value={volume.rejected_not_a_claim}
          />
          <Bucket label={t("facturacion.bucket.sinResolver")} value={volume.unresolved} />
          <Bucket label={t("facturacion.bucket.mensajesEnTotal")} value={volume.total_cases} />
        </div>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-slate-600 dark:text-slate-400">{label}</dt>
      <dd className="tabular-nums text-slate-900 dark:text-slate-100">{value}</dd>
    </div>
  );
}

function Bucket({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div
      className={`rounded-md border px-3 py-2.5 ${
        accent
          ? "border-indigo-200 bg-indigo-50 dark:border-indigo-900/40 dark:bg-indigo-950/30"
          : "border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50"
      }`}
    >
      <p className="text-lg font-semibold tabular-nums text-slate-900 dark:text-slate-100">
        {value.toLocaleString("es-AR")}
      </p>
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
    </div>
  );
}
