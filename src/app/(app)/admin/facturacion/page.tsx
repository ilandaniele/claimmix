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
import { redirect } from "next/navigation";

import { requireAdmin } from "@/lib/auth/require-admin";
import { AppError } from "@/lib/errors";
import { resolveBillingPeriod } from "@/lib/billing/period";
import { getStatement } from "@/server/billing/statement";

export const dynamic = "force-dynamic";

const money = (n: number) =>
  n.toLocaleString("es-AR", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

/** `2026-03` → `marzo de 2026`, para que el encabezado se lea como una fecha. */
function monthLabel(month: string): string {
  const [year, m] = month.split("-");
  const date = new Date(Date.UTC(Number(year), Number(m) - 1, 1));
  return date.toLocaleDateString("es-AR", { month: "long", year: "numeric", timeZone: "UTC" });
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

  const raw = (await searchParams).month;
  const requested = typeof raw === "string" ? raw : null;

  // Un mes mal escrito no puede caer al mes actual sin decirlo: el número que
  // saldría es perfectamente plausible y sería de otro período.
  const range = resolveBillingPeriod(requested);
  if (!range) {
    return (
      <div className="px-6 py-8 max-w-3xl">
        <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Facturación</h1>
        <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
          <strong>{String(requested)}</strong> no es un período válido. Se espera{" "}
          <code>AAAA-MM</code>.{" "}
          <Link href="/admin/facturacion" className="underline">
            Ver el mes en curso
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
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">Facturación</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {tenant.name} · plan {tenant.plan_label} · {monthLabel(statement.month)}
          </p>
        </div>

        <nav className="flex items-center gap-1 text-sm" aria-label="Cambiar de mes">
          <Link
            href={`/admin/facturacion?month=${shiftMonth(statement.month, -1)}`}
            className="rounded-md border border-slate-200 px-2.5 py-1.5 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
          >
            ← Mes anterior
          </Link>
          {statement.month !== current && (
            <Link
              href={`/admin/facturacion?month=${shiftMonth(statement.month, 1)}`}
              className="rounded-md border border-slate-200 px-2.5 py-1.5 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            >
              Mes siguiente →
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
            <strong>Período cerrado.</strong> Esta liquidación quedó guardada el{" "}
            {new Date(statement.frozen_at!).toLocaleDateString("es-AR", { timeZone: "UTC" })} y ya
            no cambia, aunque después se editen o se borren casos de ese mes.
          </>
        ) : (
          <>
            <strong>Mes en curso.</strong> El número sube con cada denuncia que entra. Se cierra
            solo cuando termine el mes, y a partir de ahí no se mueve.
          </>
        )}
      </p>

      <div className="grid gap-6 md:grid-cols-2">
        {/* ── Lo que se cobra ─────────────────────────────────────────────── */}
        <section className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">A facturar</h2>

          <dl className="mt-4 space-y-2.5 text-sm">
            <Row label={`Abono ${tenant.plan_label}`} value={money(invoice.monthly_fee_usd)} />
            <Row
              label={`Denuncias incluidas`}
              value={`${invoice.claims.toLocaleString("es-AR")} de ${invoice.included_claims.toLocaleString("es-AR")}`}
            />
            <Row
              label={`Excedente (${invoice.overage_claims} × ${money(invoice.overage_price_usd)})`}
              value={money(invoice.overage_total_usd)}
            />
            <div className="!mt-4 flex items-center justify-between border-t border-slate-200 pt-3 dark:border-slate-700">
              <dt className="text-sm font-semibold text-slate-900 dark:text-slate-100">Total</dt>
              <dd className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                {money(invoice.total_usd)}
              </dd>
            </div>
          </dl>
        </section>

        {/* ── Lo que costó ────────────────────────────────────────────────── */}
        <section className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Lo que costó atenderlo
          </h2>

          <dl className="mt-4 space-y-2.5 text-sm">
            <Row label="Llamadas al modelo" value={cost.calls.toLocaleString("es-AR")} />
            <Row label="Costo de IA" value={money(cost.cost_usd)} />
            <Row label="Por denuncia facturable" value={money(cost.cost_per_billable_claim_usd)} />
            <div className="!mt-4 flex items-center justify-between border-t border-slate-200 pt-3 dark:border-slate-700">
              <dt className="text-sm font-semibold text-slate-900 dark:text-slate-100">Margen</dt>
              <dd className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                {margin.margin_pct === null ? (
                  <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
                    sin ingresos este mes
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
          De dónde sale ese número
        </h2>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Se factura la denuncia que el agente reconoció como denuncia. Lo que descartó por no
          serlo no se cobra: cobrar el spam filtrado convertiría al filtro en una fuente de
          ingresos.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <Bucket label="Facturables" value={volume.billable_claims} accent />
          <Bucket label="No eran denuncias" value={volume.rejected_not_a_claim} />
          <Bucket label="Sin resolver" value={volume.unresolved} />
          <Bucket label="Mensajes en total" value={volume.total_cases} />
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
