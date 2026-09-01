/**
 * Bandeja page — Server Component.
 *
 * AC11: Fetches initial case data, status counts, and scenarios server-side.
 *       Passes to DashboardClient which handles realtime, filters, and interactivity.
 *
 * URL search params supported:
 *   status: CaseStatus (filter tab)
 *   type:   ClaimType  (filter chip)
 *   page:     number   (pagination)
 *   per_page: number   (page size — must be one of PER_PAGE_OPTIONS)
 *
 * Protected by proxy.ts — unauthenticated access redirects to /login.
 */

import { Suspense } from "react";
import { redirect } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { getSessionContext } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { enTenant } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import { cases, users } from "@/lib/db/schema";
import { listCases } from "@/server/cases/list";
import { SCENARIOS } from "@/server/intake/scenarios";
import { DashboardClient, PER_PAGE_OPTIONS } from "./DashboardClient";
import { ClaimTypeSchema } from "@/lib/schemas/cases";
import type { CaseStatus, ClaimType, Severity } from "@/lib/schemas/cases";
import { Card, KpiTile } from "../_components/ui";
import { getT } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n/locale";

const VALID_STATUSES: CaseStatus[] = [
  "procesando",
  "listo",
  "esperando",
  "escalado",
  "cerrado",
  "recibido",
  "info_faltante",
  "confirmacion_pendiente",
  "requiere_especialista",
  "listo_para_core",
  "enviado_a_core",
  "error_core",
  "no_relevante",
];
/*
 * Los tipos que este filtro acepta salen del esquema, no de una lista a mano.
 *
 * Eran cuatro de nueve, y los chips de la pantalla ofrecen ocho. Tocar
 * "Cristales", "Resp. Civil", "Robo de contenido" o "Accidente personal"
 * mandaba el parametro, este whitelist lo descartaba, y el servidor devolvia la
 * pagina SIN filtrar. El cliente despues la recortaba, asi que se veia una
 * lista casi vacia con un paginador prometiendo paginas que no existian.
 *
 * Cuatro filtros que no filtraban, y ninguno fallaba en voz alta.
 */
const VALID_TYPES: ClaimType[] = ClaimTypeSchema.options;
const VALID_SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];
const VALID_CHANNELS = ["email_sim", "email", "whatsapp_sim", "whatsapp"] as const;

interface BandejaPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

async function BandejaContent({ searchParams }: BandejaPageProps) {
  const params = await searchParams;
  const t = getT(await getServerLocale());

  const statusParam = params["status"];
  const typeParam = params["type"];
  const pageParam = params["page"];
  const channelParam = params["channel"];
  const severityParam = params["severity"];
  const isClaimParam = params["is_claim"];

  const status =
    typeof statusParam === "string" &&
    VALID_STATUSES.includes(statusParam as CaseStatus)
      ? (statusParam as CaseStatus)
      : undefined;

  const type =
    typeof typeParam === "string" &&
    VALID_TYPES.includes(typeParam as ClaimType)
      ? (typeParam as ClaimType)
      : undefined;

  const page =
    typeof pageParam === "string" ? Math.max(1, parseInt(pageParam, 10) || 1) : 1;

  // Page size is user-selectable; only accept the sizes the picker offers so a
  // hand-edited URL can't ask for an unbounded page (listCases caps at 100).
  const perPageParam = params["per_page"];
  const per_page =
    typeof perPageParam === "string" &&
    (PER_PAGE_OPTIONS as readonly number[]).includes(parseInt(perPageParam, 10))
      ? parseInt(perPageParam, 10)
      : 20;

  const channel =
    typeof channelParam === "string" &&
    (VALID_CHANNELS as readonly string[]).includes(channelParam)
      ? (channelParam as typeof VALID_CHANNELS[number])
      : undefined;

  const severity =
    typeof severityParam === "string" &&
    VALID_SEVERITIES.includes(severityParam as Severity)
      ? (severityParam as Severity)
      : undefined;

  const is_claim =
    isClaimParam === "true" ? true : isClaimParam === "false" ? false : undefined;

  // Resolve the tenant boundary (RLS is gone — explicit tenant_id filter only).
  const session = await getSessionContext();
  if (!session?.user) redirect("/login");
  const userRow = firstRow(
    // sin-inquilino: Ésta es la consulta que AVERIGUA de qué inquilino es la sesión.
    // No puede pasar por una capa que necesita el dato que ella busca.
    await db
      .select({ tenant_id: users.tenant_id })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1)
  );
  if (!userRow) redirect("/login");
  const tenantId = userRow.tenant_id;

  // Fetch cases matching the current filter.
  const initialData = await listCases({ tenantId }, {
    status,
    type,
    page,
    per_page,
    sort: "created_at",
    order: "desc",
    // Email-intake filters (AC18)
    channel,
    severity,
    is_claim,
  });

  /*
   * Un solo viaje para los catorce contadores.
   *
   * Eran catorce `countRows` en un `Promise.all`: uno por estado más el total.
   * Estar en paralelo no los junta — cada `enTenant` abre su propio `batch()`
   * contra Neon con su `set_config` adelante, así que la pantalla principal
   * arrancaba con catorce transacciones HTTP en vez de una.
   *
   * No era lento por la base: hay índice `(tenant_id, status)` y cada COUNT era
   * un scan barato. Lo que se ahorra son trece viajes y trece transacciones.
   *
   * `count(*)::int` escrito a mano y no `db.$count`: eso último devuelve algo
   * que se puede esperar pero que `batch()` no puede armar, y rompió estos
   * mismos contadores en producción. Ver src/lib/db/helpers.ts.
   */
  const porEstado = await enTenant<Array<{ status: string; n: number }>>(
    { tenantId },
    (db) =>
      db
        .select({ status: cases.status, n: sql<number>`count(*)::int` })
        .from(cases)
        .groupBy(cases.status)
  );

  /*
   * El total suma TODAS las filas que devuelve el grupo, no sólo las de los
   * estados de la lista de arriba.
   *
   * Hoy da lo mismo: la base tiene `cases_status_check` con exactamente estos
   * trece valores, así que no puede haber una fila fuera. Se suma todo igual
   * porque `VALID_STATUSES` es una copia a mano de esa lista, y el día que el
   * CHECK sume un estado y esta copia no, la tarjeta «Total casos» bajaría sin
   * error visible. Sumar lo que vuelve no depende de que las dos listas estén
   * sincronizadas; sumar lo mapeado sí.
   */
  const cuenta = new Map(porEstado.map((r) => [r.status, r.n]));
  const totalCount = porEstado.reduce((acc, r) => acc + r.n, 0);

  const allStatusCounts: { status: CaseStatus | "todos"; count: number }[] = [
    { status: "todos", count: totalCount },
    // Se recorre VALID_STATUSES y no el resultado: un estado sin casos no
    // vuelve del GROUP BY, y su pestaña tiene que mostrar 0, no desaparecer.
    ...VALID_STATUSES.map((s) => ({ status: s, count: cuenta.get(s) ?? 0 })),
  ];

  const criticalCount = allStatusCounts.find(s => s.status === "escalado")?.count ?? 0;
  const pendingCount =
    (allStatusCounts.find(s => s.status === "esperando")?.count ?? 0) +
    (allStatusCounts.find(s => s.status === "info_faltante")?.count ?? 0);
  const resolvedCount =
    (allStatusCounts.find(s => s.status === "listo")?.count ?? 0) +
    (allStatusCounts.find(s => s.status === "cerrado")?.count ?? 0);

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pb-5 pt-1">
        {/*
         * El título de la pantalla, que antes no estaba.
         *
         * La barra de arriba sólo tiene los controles de la persona, así que la
         * bandeja empezaba directamente en los números, sin decir dónde estás.
         *
         * Sale del diccionario y no escrito a mano: puesto a mano decía
         * «Bandeja» en castellano incluso con la interfaz en inglés, y encima
         * `DashboardClient` repetía este mismo título adentro de la tarjeta.
         */}
        <h1 className="text-balance text-[26px] font-semibold tracking-tight text-slate-900">
          {t("bandeja.title")}
        </h1>
        <p className="mt-1 text-[13px] text-slate-500">{t("bandeja.subtitle")}</p>

        {/*
         * Los cuatro indicadores.
         *
         * Antes cada uno venía teñido de su color de fondo —rojo, ámbar, verde—
         * y la fila entera competía por la atención: cuatro bloques de color no
         * jerarquizan nada. Ahora la tarjeta es blanca como todas y el color
         * queda SÓLO en el número, que es el dato que dice si hay que hacer algo.
         */}
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiTile label={t("kpi.total")} value={totalCount} />
          <KpiTile
            label={t("tabs.escalado")}
            value={criticalCount}
            tone="critico"
            hint={criticalCount > 0 ? t("kpi.criticalHint") : t("kpi.criticalNone")}
          />
          <KpiTile
            label={t("tabs.esperando")}
            value={pendingCount}
            tone="espera"
            hint={t("kpi.pendingHint")}
          />
          <KpiTile label={t("tabs.listo")} value={resolvedCount} tone="listo" />
        </div>
      </div>

      {/* La lista, dentro de la misma tarjeta que todo lo demás. */}
      <div className="flex-1 overflow-hidden px-6 pb-6">
        <Card className="flex h-full flex-col overflow-hidden">
          <DashboardClient
            initialData={initialData}
            scenarios={SCENARIOS}
            allStatusCounts={allStatusCounts}
          />
        </Card>
      </div>
    </div>
  );
}

/**
 * El esqueleto de carga, con la forma de lo que va a aparecer.
 *
 * Tenía la forma VIEJA de la pantalla —tres franjas con borde duro, sin las
 * baldosas de indicador y sin tarjeta— así que al terminar de cargar el diseño
 * saltaba a otra cosa. Un esqueleto que no coincide con su destino es peor que
 * no tener esqueleto: promete un layout y entrega otro.
 */
function BandejaLoading() {
  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pb-5 pt-1">
        <div className="h-8 w-64 animate-pulse rounded-lg bg-slate-200" />
        <div className="mt-2 h-4 w-80 animate-pulse rounded bg-slate-100" />
        <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="h-[104px] animate-pulse rounded-2xl border border-slate-200 bg-white"
            />
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-hidden px-6 pb-6">
        <div className="h-full rounded-2xl border border-slate-200 bg-white p-5">
          <div className="flex gap-2">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="h-8 w-24 animate-pulse rounded-lg bg-slate-100" />
            ))}
          </div>
          <div className="mt-6 space-y-3">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="h-11 animate-pulse rounded-lg bg-slate-50" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function BandejaPage(props: BandejaPageProps) {
  return (
    <Suspense fallback={<BandejaLoading />}>
      <BandejaContent {...props} />
    </Suspense>
  );
}
