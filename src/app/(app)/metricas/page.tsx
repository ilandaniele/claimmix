/**
 * Métricas page — AC16 supplemental pages (W7).
 *
 * Server Component that fetches KPI data and renders:
 *   - 8 summary cards: las del período y las del ciclo (B14, B15)
 *   - Dónde se quedan los casos (cuellos de botella)
 *   - Cases by status (visual bar chart — HTML/CSS only, no chart library)
 *   - Cases by type (donut-style percentage bars)
 *   - Top 5 analysts table
 *   - Actividad por día, mes o año (`?serie=`)
 *   - `?periodo=` elige el rango de las tarjetas y las distribuciones
 *   - `?vista=historial`: los últimos doce meses mes a mes, con su CSV
 *
 * Los textos salen del diccionario; los números y la moneda quedan en formato
 * es-AR en todo el producto a propósito (ver `formatUsd` en lib/utils.ts).
 */

import Link from "next/link";
import { nombreDelMesArgentino } from "@/core/fecha/dia-argentino";
import { mesDeCalendario } from "@/core/fecha/mes-calendario";
import { COLUMNAS_DEL_HISTORIAL, porcentaje, unDecimal, type FilaDeHistorial } from "@/core/metricas/ciclo";
import { hrefDeMetricas, VISTAS, vistaDe, type Vista } from "@/core/metricas/enlaces";
import { PERIODOS_DEL_TABLERO, periodoDe, type Periodo, type PeriodoDelTablero } from "@/core/metricas/periodo";
import {
  CLAVES_DE_ESTADO,
  contarPorOpcion,
  type ClaveDeEstado,
} from "@/core/case/filtro-de-estado";
import { unidadDe, type Unidad } from "@/core/metricas/serie";
import { getSessionContext } from "@/lib/auth/session";
import { getUserRow } from "@/lib/auth/user-row";
import { getT, type Locale, type TranslationKey } from "@/lib/i18n";
import { getAccountLocale } from "@/server/i18n/idioma-de-la-cuenta";
import { formatUsd as formatUsdShared } from "@/lib/utils";
import { getHistorialDeMetricas } from "@/server/metrics/historial";
import {
  getTenantKpis,
  type MetricasData,
} from "@/server/metrics/kpis";
import { ClaimTypeSchema } from "@/lib/schemas/cases";
import { esRamoNativo, type RamoDelInquilino } from "@/core/case/ramos";
import { nombreDeTipo } from "@/lib/i18n/tipos-de-siniestro";
import { cargarRamosDelInquilino } from "@/server/cases/ramos-del-inquilino";
import { AppError } from "@/lib/errors";
import { redirect, unstable_rethrow } from "next/navigation";
import { connection } from "next/server";
import { anchoDeBarra } from "@/lib/ui/ancho-de-barra";
import { logger } from "@/lib/observability/logger";
import { SerieDeActividad } from "./_components/SerieDeActividad";
import { ResumenDeAyer } from "./_components/ResumenDeAyer";

/*
 * Los números salen de `getTenantKpis`, que también usa /api/metricas, y el
 * historial de `getHistorialDeMetricas`, que también usa el CSV.
 *
 * Estaban escritos acá y otra vez en la ruta, con las mismas nueve consultas
 * y la misma agregación, y las dos copias ya habían divergido en cómo tratan
 * un `claim_type` nulo.
 *
 * Lo que queda acá es lo que de verdad es de la pantalla: resolver quién está
 * mirando, y dibujar.
 */
type Metricas = {
  data: MetricasData | null;
  historial: FilaDeHistorial[] | null;
  /** Los ramos propios de la aseguradora con casos en el período: sólo para ponerles nombre. */
  ramos: RamoDelInquilino[];
};

const SIN_METRICAS: Metricas = { data: null, historial: null, ramos: [] };

/** Los tipos de `by_type` que el código no trae, ordenados por clave. */
const tiposPropios = (porTipo: Record<string, number>) => Object.keys(porTipo).filter((k) => !esRamoNativo(k)).sort();

async function fetchMetricas(unidad: Unidad, periodo: Periodo, vista: Vista): Promise<Metricas> {
  try {
    await connection();
    const session = await getSessionContext();
    if (!session?.user) return SIN_METRICAS;

    // Deduplicada con la del layout: ver lib/auth/user-row.ts.
    const userRow = await getUserRow(session.user.id);
    // El chequeo va ANTES de leerle un campo: estaba al revés, así que una
    // sesión sin perfil reventaba en la línea de abajo en vez de devolver null.
    if (!userRow) return SIN_METRICAS;

    // El historial recorre la auditoría de todo el año y en su vista no se
    // dibuja nada del tablero: cada vista pide sólo lo suyo.
    const tenantCtx = { tenantId: userRow.tenant_id };
    if (vista === "historial") return { ...SIN_METRICAS, historial: await getHistorialDeMetricas(tenantCtx) };
    const data = await getTenantKpis(tenantCtx, { periodo, serie: unidad, ayer: true });
    // Los nombres de los ramos propios se leen sólo si alguno tiene casos: los del sistema no pagan la consulta.
    const ramos = tiposPropios(data.by_type).length > 0 ? await cargarRamosDelInquilino(userRow.tenant_id) : [];
    return { data, historial: null, ramos };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof AppError) throw e;
    logger.error(
      { error_name: e instanceof Error ? e.name : "unknown" },
      "metricas.fetch_error"
    );
    return SIN_METRICAS;
  }
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return `${h}h ${m}min`;
}

// El encabezado nombra el mismo mes que la ventana de `kpis.ts`, y por lo tanto
// también tiene que decir la zona. Sin ella, en Vercel la última noche de agosto
// el título dice «septiembre» sobre datos de agosto.
function formatCurrentMonth(locale: Locale): string {
  return nombreDelMesArgentino(locale);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("es-AR").format(Math.round(value));
}

const UN_DECIMAL = new Intl.NumberFormat("es-AR", { maximumFractionDigits: 1 });

const formatDecimal = (value: number | null) => (value === null ? "—" : UN_DECIMAL.format(value));

/** Minutos bajo la hora, horas hasta los dos días y días de ahí en adelante. */
function formatHoras(horas: number | null): string {
  if (horas === null) return "—";
  if (horas < 1) return `${Math.round(horas * 60)} min`;
  if (horas < 48) return `${formatDecimal(horas)} h`;
  return `${formatDecimal(horas / 24)} d`;
}

const ROTULO_PERIODO: Record<PeriodoDelTablero, TranslationKey> = {
  esta_semana: "metricas.periodo.esta_semana",
  este_mes: "metricas.periodo.este_mes",
  mes_pasado: "metricas.periodo.mes_pasado",
  ultimos_30_dias: "metricas.periodo.ultimos_30_dias",
  este_anio: "metricas.periodo.este_anio",
};

/** Cuántos estados se dibujan en «dónde se quedan los casos»: los demás son cola. */
const CUELLOS_A_MOSTRAR = 6;

// El costo de IA por llamada es de milésimas: con dos decimales todo se ve
// $0,01. De ahí el 4.
const formatUsd = (value: number) => formatUsdShared(value, 4);

// ── Status bar chart ──────────────────────────────────────────────────────────

/*
 * Los mismos seis grupos de `filtro-de-estado.ts`, no los estados crudos: el
 * canal real escribe `requiere_especialista`, `listo_para_core`, `recibido`,
 * que este gráfico dibujaba sin barra por no tener una clave que los cubra. El
 * orden es el de `CLAVES_DE_ESTADO`, el mismo recorrido que ya usa la bandeja.
 */
const STATUS_COLORS: Record<ClaveDeEstado, string> = {
  procesando: "bg-blue-400",
  esperando: "bg-yellow-400",
  confirmacion_pendiente: "bg-amber-500",
  escalado: "bg-red-400",
  listo: "bg-green-500",
  cerrado: "bg-slate-400",
};

/*
 * Los rótulos no viven más acá: estos mapas guardan la CLAVE del diccionario y
 * el texto se resuelve adentro del componente, que es el único lugar donde se
 * sabe en qué idioma está mirando quien pidió la página. El orden de las
 * entradas sigue siendo el orden en que se dibujan las barras.
 */
const STATUS_LABEL_KEYS: Record<ClaveDeEstado, TranslationKey> = {
  procesando: "tabs.procesando",
  esperando: "tabs.esperando",
  confirmacion_pendiente: "status.confirmacion_pendiente",
  escalado: "tabs.escalado",
  listo: "tabs.listo",
  cerrado: "tabs.cerrado",
};

const TYPE_COLORS: Record<string, string> = {
  choque: "bg-blue-500",
  robo: "bg-purple-500",
  granizo: "bg-cyan-500",
  incendio: "bg-orange-500",
};

// ── Page component ────────────────────────────────────────────────────────────

export default async function MetricasPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const locale = await getAccountLocale();
  const t = getT(locale);
  const params = await searchParams;
  const unidad = unidadDe(params.serie);
  const periodo = periodoDe(params.periodo);
  const vista = vistaDe(params.vista);
  const tablero = vista === "tablero";
  let { data, historial, ramos } = SIN_METRICAS;

  try {
    ({ data, historial, ramos } = await fetchMetricas(unidad, periodo, vista));
  } catch (e) {
    if (e instanceof AppError && e.code === "MISSING_SESSION") {
      redirect("/login");
    }
  }

  const hasData =
    tablero &&
    data &&
    (data.summary.total_cases_month > 0 ||
      Object.values(data.by_status).some((v) => v > 0) ||
      data.ai_usage.all_time.total_tokens > 0);

  // Sólo los seis grupos de la bandeja: `no_relevante` y `error_core` quedan
  // afuera de la partición, y sumarlos acá volvía a romper el 100% del gráfico.
  const porGrupoDeEstado = contarPorOpcion(
    Object.entries(data?.by_status ?? {}).map(([status, n]) => ({ status, count: n }))
  );
  const totalByStatus = CLAVES_DE_ESTADO.reduce(
    (a, clave) => a + porGrupoDeEstado[clave],
    0
  );
  const totalByType = Object.values(data?.by_type ?? {}).reduce(
    (a, b) => a + b,
    0
  );
  const cuellos = (data?.summary.cuellos ?? []).slice(0, CUELLOS_A_MOSTRAR);
  const cuelloMayor = Math.max(0, ...cuellos.map((c) => c.horas_promedio));

  return (
    <div className="px-6 py-8 max-w-6xl">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-slate-900">
          {t("metricas.title")}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {t("metricas.subtitle")} —{" "}
          {!tablero
            ? t("metricas.historial.titulo")
            : periodo === "este_mes"
              ? formatCurrentMonth(locale)
              : t(ROTULO_PERIODO[periodo])}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Opciones
            rotulo={t("metricas.title")}
            actual={vista}
            opciones={VISTAS.map((v) => ({
              clave: v,
              href: hrefDeMetricas({ serie: unidad, periodo, vista: v }),
              texto: t(`metricas.vista.${v}`),
            }))}
          />
          {tablero && (
            <Opciones
              rotulo={t("metricas.periodo.titulo")}
              actual={periodo}
              opciones={PERIODOS_DEL_TABLERO.map((p) => ({
                clave: p,
                href: hrefDeMetricas({ serie: unidad, periodo: p }),
                texto: t(ROTULO_PERIODO[p]),
              }))}
            />
          )}
        </div>
      </div>

      {tablero && !hasData && (
        <div className="mb-8 rounded-lg border border-slate-200 bg-slate-50 px-6 py-12 text-center">
          <p className="text-sm text-slate-500">
            {t("metricas.emptyPeriod")}
          </p>
        </div>
      )}

      {hasData && (
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard
            label={t("metricas.card.totalMes")}
            value={`${data!.summary.total_cases_month} ${t("bandeja.claims")}`}
            accent="blue"
          />
          <SummaryCard
            label={t("metricas.card.primeraRespuesta")}
            value={formatMinutes(data!.summary.avg_first_response_minutes)}
            accent="slate"
          />
          <SummaryCard
            label={t("metricas.card.completadoConfirmado")}
            value={`${data!.summary.completado_confirmado_rate}%`}
            accent="green"
          />
          <SummaryCard
            label={t("metricas.card.escalados")}
            value={`${data!.summary.escalated_count} ${t("bandeja.claims")}`}
            accent="red"
          />
        </div>
      )}

      {hasData && (
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryCard
            label={t("metricas.card.sinIntervencion")}
            value={
              data!.summary.sin_intervencion_rate === null
                ? "—"
                : `${data!.summary.sin_intervencion_rate}%`
            }
            helper={t("metricas.card.sinIntervencionNota")}
            accent="green"
          />
          <SummaryCard
            label={t("metricas.card.medianaListo")}
            value={formatHoras(data!.summary.ciclo.mediana_horas_listo)}
            helper={t("metricas.card.casosMedidos").replace("{n}", String(data!.summary.ciclo.casos_listo))}
            accent="blue"
          />
          <SummaryCard
            label={t("metricas.card.medianaCierre")}
            value={formatHoras(data!.summary.ciclo.mediana_horas_cierre)}
            helper={t("metricas.card.casosMedidos").replace("{n}", String(data!.summary.ciclo.casos_cierre))}
            accent="slate"
          />
          <SummaryCard
            label={t("metricas.card.mensajesPorCaso")}
            value={formatDecimal(data!.summary.mensajes_por_caso)}
            accent="slate"
          />
        </div>
      )}

      {data?.ayer && (
        <div className="mb-8">
          <ResumenDeAyer resumen={data.ayer} locale={locale} />
        </div>
      )}

      {/* La actividad va arriba, antes del uso de IA: es lo primero que alguien
          quiere ver, y sale aunque el tenant no tenga historial todavía. */}
      {data?.serie && (
        <div className="mb-8">
          <SerieDeActividad
            serie={data.serie}
            unidad={unidad}
            locale={locale}
            periodo={periodo}
          />
        </div>
      )}

      {historial && (
        <div className="mb-8">
          <TablaDeHistorial filas={historial} locale={locale} />
        </div>
      )}

      {hasData && (
        <>
          {/* ── Dónde se quedan los casos ────────────────────────────────────── */}
          <section
            data-testid="cuellos"
            className="mb-8 rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/70"
          >
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-100">
              {t("metricas.cuellos.titulo")}
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {t("metricas.cuellos.nota")}
            </p>
            {cuellos.length === 0 ? (
              <p className="mt-4 text-sm text-slate-500">{t("metricas.cuellos.vacio")}</p>
            ) : (
              <ul className="mt-4 space-y-3">
                {cuellos.map((c) => {
                  const label = t(`status.${c.estado}` as TranslationKey);
                  const pct = cuelloMayor > 0 ? (c.horas_promedio / cuelloMayor) * 100 : 0;
                  return (
                    <li key={c.estado}>
                      <div className="mb-1 flex justify-between text-xs text-slate-600 dark:text-slate-300">
                        <span>{label}</span>
                        <span>
                          {formatHoras(c.horas_promedio)} ·{" "}
                          {t("metricas.cuellos.estadias").replace("{n}", String(c.estancias))}
                        </span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                        <div
                          className={`h-full rounded-full bg-amber-500 ${anchoDeBarra(pct)}`}
                          role="progressbar"
                          aria-valuenow={Math.round(pct)}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-label={label}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ── Charts row ───────────────────────────────────────────────────── */}
          <section className="mb-8">
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                {t("metricas.ia.titulo")}
              </h2>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {t("metricas.ia.subtitulo")}
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <UsageStat
                label={t("metricas.ia.tokensMes")}
                value={formatNumber(data!.ai_usage.month.total_tokens)}
                helper={`${formatNumber(data!.ai_usage.month.prompt_tokens)} ${t("metricas.ia.prompt")} / ${formatNumber(data!.ai_usage.month.completion_tokens)} ${t("metricas.ia.respuesta")}`}
              />
              <UsageStat
                label={t("metricas.ia.costoMes")}
                value={formatUsd(data!.ai_usage.month.cost_usd)}
                helper={`${formatNumber(data!.ai_usage.month.calls)} ${t("metricas.ia.ejecuciones")}`}
              />
              <UsageStat
                label={t("metricas.ia.tokensTotal")}
                value={formatNumber(data!.ai_usage.all_time.total_tokens)}
                helper={`${formatNumber(data!.ai_usage.all_time.prompt_tokens)} ${t("metricas.ia.prompt")} / ${formatNumber(data!.ai_usage.all_time.completion_tokens)} ${t("metricas.ia.respuesta")}`}
              />
              <UsageStat
                label={t("metricas.ia.costoTotal")}
                value={formatUsd(data!.ai_usage.all_time.cost_usd)}
                helper={`${formatNumber(data!.ai_usage.all_time.calls)} ${t("metricas.ia.ejecuciones")}`}
              />
            </div>

            <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div className="rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/70">
                <div className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
                  <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-100">
                    {t("metricas.ia.porUsuario")}
                  </h3>
                </div>
                {data!.ai_usage.by_user.length === 0 ? (
                  <div className="px-5 py-8 text-center text-sm text-slate-500">
                    {t("metricas.ia.vacio")}
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-400">
                        <th className="px-5 py-3 text-left">
                          {t("metricas.col.usuario")}
                        </th>
                        <th className="px-5 py-3 text-right">
                          {t("metricas.col.tokens")}
                        </th>
                        <th className="px-5 py-3 text-right">
                          {t("metricas.col.costo")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data!.ai_usage.by_user.map((row) => (
                        <tr
                          key={row.user_id ?? "system"}
                          className="border-b border-slate-50 last:border-0 dark:border-slate-800"
                        >
                          <td className="px-5 py-3">
                            <div className="font-medium text-slate-800 dark:text-slate-100">
                              {row.full_name}
                            </div>
                            {row.email && (
                              <div className="text-xs text-slate-500 dark:text-slate-400">
                                {row.email}
                              </div>
                            )}
                          </td>
                          <td className="px-5 py-3 text-right text-slate-700 dark:text-slate-200">
                            {formatNumber(row.total_tokens)}
                            <div className="text-xs text-slate-500">
                              {formatNumber(row.calls)} {t("metricas.ia.ejecAbrev")}
                            </div>
                          </td>
                          <td className="px-5 py-3 text-right text-slate-700 dark:text-slate-200">
                            {formatUsd(row.cost_usd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/70">
                <div className="border-b border-slate-100 px-5 py-3 dark:border-slate-800">
                  <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-100">
                    {t("metricas.ia.porModelo")}
                  </h3>
                </div>
                {data!.ai_usage.by_model.length === 0 ? (
                  <div className="px-5 py-8 text-center text-sm text-slate-500">
                    {t("metricas.ia.vacio")}
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-400">
                        <th className="px-5 py-3 text-left">
                          {t("metricas.col.modelo")}
                        </th>
                        <th className="px-5 py-3 text-right">
                          {t("metricas.col.tokens")}
                        </th>
                        <th className="px-5 py-3 text-right">
                          {t("metricas.col.costo")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data!.ai_usage.by_model.map((row) => (
                        <tr
                          key={row.model}
                          className="border-b border-slate-50 last:border-0 dark:border-slate-800"
                        >
                          <td className="px-5 py-3 font-mono text-xs text-slate-700 dark:text-slate-200">
                            {row.model}
                          </td>
                          <td className="px-5 py-3 text-right text-slate-700 dark:text-slate-200">
                            {formatNumber(row.total_tokens)}
                            <div className="text-xs text-slate-500">
                              {formatNumber(row.calls)} {t("metricas.ia.ejecAbrev")}
                            </div>
                          </td>
                          <td className="px-5 py-3 text-right text-slate-700 dark:text-slate-200">
                            {formatUsd(row.cost_usd)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </section>

          <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
            {/* Cases by status */}
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <h2 className="mb-4 text-sm font-semibold text-slate-700">
                {t("metricas.porEstado")}
              </h2>
              {totalByStatus === 0 ? (
                <p className="text-sm text-slate-500">{t("metricas.sinDatos")}</p>
              ) : (
                <div className="space-y-3">
                  {CLAVES_DE_ESTADO.map((clave) => {
                    const label = t(STATUS_LABEL_KEYS[clave]);
                    const count = porGrupoDeEstado[clave];
                    const pct =
                      totalByStatus > 0
                        ? Math.round((count / totalByStatus) * 100)
                        : 0;
                    return (
                      <div key={clave}>
                        <div className="mb-1 flex justify-between text-xs text-slate-600">
                          <span>{label}</span>
                          <span>
                            {count} ({pct}%)
                          </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                          <div
                            className={`h-full rounded-full transition-all ${STATUS_COLORS[clave]} ${anchoDeBarra(pct)}`}
                                                        aria-valuenow={pct}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            role="progressbar"
                            aria-label={label}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Cases by type */}
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <h2 className="mb-4 text-sm font-semibold text-slate-700">
                {t("metricas.porTipo")}
              </h2>
              {totalByType === 0 ? (
                <p className="text-sm text-slate-500">{t("metricas.sinDatos")}</p>
              ) : (
                <div className="space-y-3">
                  {[...ClaimTypeSchema.options, ...tiposPropios(data!.by_type)].map((key) => {
                    const label = nombreDeTipo(key, t, ramos, locale);
                    const count = data!.by_type[key] ?? 0;
                    const pct =
                      totalByType > 0
                        ? Math.round((count / totalByType) * 100)
                        : 0;
                    return (
                      <div key={key}>
                        <div className="mb-1 flex justify-between text-xs text-slate-600">
                          <span>{label}</span>
                          <span>
                            {count} ({pct}%)
                          </span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                          <div
                            className={`h-full rounded-full transition-all ${(Object.hasOwn(TYPE_COLORS, key) && TYPE_COLORS[key]) || "bg-slate-400"} ${anchoDeBarra(pct)}`}
                                                        aria-valuenow={pct}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            role="progressbar"
                            aria-label={label}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* ── Top analysts table ───────────────────────────────────────────── */}
          <div className="rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-5 py-3">
              <h2 className="text-sm font-semibold text-slate-700">
                {t("metricas.topAnalistas")}
              </h2>
            </div>
            {data!.top_analysts.length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-slate-500">
                {t("metricas.sinCasosCerrados")}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-500">
                    <th className="px-5 py-3 text-left">#</th>
                    <th className="px-5 py-3 text-left">{t("role.analyst")}</th>
                    <th className="px-5 py-3 text-right">
                      {t("metricas.col.casosCerrados")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data!.top_analysts.map((analyst, index) => (
                    <tr
                      key={analyst.full_name}
                      className="border-b border-slate-50 last:border-0"
                    >
                      <td className="px-5 py-3 text-slate-500">
                        {index + 1}
                      </td>
                      <td className="px-5 py-3 font-medium text-slate-800">
                        {analyst.full_name}
                      </td>
                      <td className="px-5 py-3 text-right text-slate-700">
                        {analyst.closed_count}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Summary card sub-component ────────────────────────────────────────────────

type Accent = "blue" | "green" | "red" | "slate";

const ACCENT_CLASSES: Record<Accent, string> = {
  blue: "border-blue-200 bg-blue-50",
  green: "border-emerald-200 bg-emerald-50",
  red: "border-red-200 bg-red-50",
  slate: "border-slate-200 bg-slate-50",
};

function SummaryCard({
  label,
  value,
  accent,
  helper,
}: {
  label: string;
  value: string;
  accent: Accent;
  helper?: string;
}) {
  return (
    <div
      className={`rounded-lg border p-5 ${ACCENT_CLASSES[accent]}`}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="mt-2 text-2xl font-bold text-slate-900">{value}</p>
      {helper && <p className="mt-1 text-xs text-slate-500">{helper}</p>}
    </div>
  );
}

/** Enlaces de una fila de opciones: elegir una es navegar, sin estado en el navegador. */
function Opciones({
  rotulo,
  actual,
  opciones,
}: {
  rotulo: string;
  actual: string;
  opciones: Array<{ clave: string; href: string; texto: string }>;
}) {
  return (
    <nav aria-label={rotulo} className="flex flex-wrap gap-1">
      {opciones.map((o) => (
        <Link
          key={o.clave}
          href={o.href}
          aria-current={o.clave === actual ? "page" : undefined}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            o.clave === actual
              ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
              : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          }`}
        >
          {o.texto}
        </Link>
      ))}
    </nav>
  );
}

/** Los doce meses, el más nuevo arriba. Los mismos números que baja el CSV. */
function TablaDeHistorial({
  filas,
  locale,
}: {
  filas: FilaDeHistorial[];
  locale: Locale;
}) {
  const t = getT(locale);
  return (
    <section data-testid="historial">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">{t("metricas.historial.nota")}</p>
        <a
          href="/api/metricas/export.csv"
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
        >
          {t("metricas.historial.csv")}
        </a>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/70">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50 text-xs font-medium uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-950/40 dark:text-slate-400">
              {COLUMNAS_DEL_HISTORIAL.map((c, i) => (
                <th key={c} className={`px-4 py-3 ${i === 0 ? "text-left" : "text-right"}`}>
                  {t(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...filas].reverse().map((f) => {
              const sinIntervencion = porcentaje(f.sin_intervencion, f.reclamos);
              return (
                <tr
                  key={f.mes}
                  className="border-b border-slate-50 text-right tabular-nums text-slate-700 last:border-0 dark:border-slate-800 dark:text-slate-200"
                >
                  <td className="px-4 py-3 text-left font-medium">{mesDeCalendario(f.mes, locale)}</td>
                  <td className="px-4 py-3">{f.reclamos}</td>
                  <td className="px-4 py-3">{f.completados}</td>
                  <td className="px-4 py-3">{sinIntervencion === null ? "—" : `${sinIntervencion}%`}</td>
                  <td className="px-4 py-3">{formatDecimal(unDecimal(f.mediana_horas_listo))}</td>
                  <td className="px-4 py-3">{formatDecimal(unDecimal(f.mediana_horas_cierre))}</td>
                  <td className="px-4 py-3">{formatDecimal(unDecimal(f.mensajes_por_caso))}</td>
                  <td className="px-4 py-3">{f.escalados}</td>
                  <td className="px-4 py-3">{f.cerrados}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UsageStat({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/70">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <p className="mt-2 text-2xl font-bold text-slate-900 dark:text-slate-100">
        {value}
      </p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{helper}</p>
    </div>
  );
}
