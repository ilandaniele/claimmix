/**
 * /metricas con la serie de actividad, dibujada entera.
 *
 * El componente y `getTenantKpis` se prueban cada uno por su lado; esto prueba
 * la unión: que `?serie=` llegue a la consulta, y que la sección salga arriba
 * del todo, tenga o no el tenant otro historial que mostrar.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

const { mockKpis, mockHistorial } = vi.hoisted(() => ({ mockKpis: vi.fn(), mockHistorial: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), unstable_rethrow: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getSessionContext: vi.fn(async () => ({ user: { id: "u1" } })),
}));
vi.mock("@/lib/auth/user-row", () => ({
  getUserRow: vi.fn(async () => ({ tenant_id: "t1" })),
}));
vi.mock("@/lib/i18n/locale", () => ({ resolveAccountLocale: vi.fn(async () => "es-AR") }));
vi.mock("@/data/scope", () => ({ enTenant: vi.fn() }));
vi.mock("@/server/metrics/kpis", () => ({ getTenantKpis: mockKpis }));
vi.mock("@/server/metrics/historial", () => ({ getHistorialDeMetricas: mockHistorial }));

import MetricasPage from "@/app/(app)/metricas/page";
import { COLUMNAS_DEL_HISTORIAL } from "@/core/metricas/ciclo";
import { hrefDeMetricas, VISTAS } from "@/core/metricas/enlaces";
import { getT } from "@/lib/i18n";
import type { MetricasData } from "@/server/metrics/kpis";
import { PERIODO_DEL_MES, RESUMEN_DEL_CICLO, SITUACION_EN_CERO } from "../mocks/metricas-datos";

const SIN_USO = { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };

function datos(
  casos: number,
  ayer?: MetricasData["ayer"],
  resumen: Partial<MetricasData["summary"]> = {}
): MetricasData {
  return {
    summary: {
      total_cases_month: casos,
      avg_first_response_minutes: null,
      completado_confirmado_rate: 0,
      escalated_count: 0,
      ...RESUMEN_DEL_CICLO,
      ...resumen,
    },
    by_status: { listo: casos },
    by_type: {},
    top_analysts: [],
    ai_usage: { month: SIN_USO, all_time: SIN_USO, by_user: [], by_model: [] },
    period: { start: "", end: "" },
    periodo: PERIODO_DEL_MES,
    serie: [
      {
        clave: "2026-09-15",
        reclamos: casos,
        whatsapps: 0,
        mails: 0,
        reclamos_whatsapp: 0,
        reclamos_mail: 0,
        ...SITUACION_EN_CERO,
      },
    ],
    ...(ayer ? { ayer } : {}),
  };
}

async function dibujar(serie?: string, otros: Record<string, string> = {}) {
  render(await MetricasPage({ searchParams: Promise.resolve({ serie, ...otros }) }));
}

describe("/metricas — la serie de actividad", () => {
  beforeEach(() => mockKpis.mockReset());

  it("`?serie=dia` llega a la consulta y la serie sale en el tablero", async () => {
    mockKpis.mockResolvedValue(datos(3));

    await dibujar("dia");

    expect(mockKpis).toHaveBeenCalledWith({ tenantId: "t1" }, { periodo: "este_mes", serie: "dia", ayer: true });
    expect(screen.getByTestId("serie-actividad")).toBeInTheDocument();
    // El tablero tiene otras dos filas de enlaces (vista y período) con su propia página actual.
    expect(
      within(screen.getByTestId("serie-actividad")).getByRole("link", { current: "page" })
    ).toHaveTextContent("Por día");
  });

  it("sin `?serie=` pide la diaria", async () => {
    mockKpis.mockResolvedValue(datos(3));

    await dibujar();

    expect(mockKpis).toHaveBeenCalledWith({ tenantId: "t1" }, { periodo: "este_mes", serie: "dia", ayer: true });
  });

  it("sin ningún caso, la actividad reciente se muestra igual bajo el aviso", async () => {
    mockKpis.mockResolvedValue(datos(0));

    await dibujar("dia");

    expect(screen.getByText(/No hay datos disponibles/)).toBeInTheDocument();
    expect(screen.getByTestId("serie-actividad")).toBeInTheDocument();
  });

  it("sin ningún caso, el resumen de ayer se muestra igual junto al aviso", async () => {
    mockKpis.mockResolvedValue(
      datos(0, {
        reclamos: 0,
        whatsapps: 0,
        mails: 0,
        escalados: 0,
        cerrados: 0,
        para_responder: 0,
        confirmacion_pendiente: 0,
      })
    );

    await dibujar("dia");

    expect(screen.getByText(/No hay datos disponibles/)).toBeInTheDocument();
    expect(screen.getByTestId("resumen-de-ayer")).toBeInTheDocument();
  });

  it("`?periodo=` llega a la consulta, y el encabezado nombra ese período", async () => {
    mockKpis.mockResolvedValue(datos(3));

    await dibujar("dia", { periodo: "mes_pasado" });

    expect(mockKpis).toHaveBeenCalledWith(
      { tenantId: "t1" },
      { periodo: "mes_pasado", serie: "dia", ayer: true }
    );
    expect(screen.getByRole("heading", { level: 1 }).parentElement).toHaveTextContent("Mes pasado");
  });

  it("un período que el tablero no ofrece vuelve al mes en curso", async () => {
    mockKpis.mockResolvedValue(datos(3));

    await dibujar("dia", { periodo: "el-año-que-viene" });

    expect(mockKpis).toHaveBeenCalledWith(
      { tenantId: "t1" },
      { periodo: "este_mes", serie: "dia", ayer: true }
    );
  });

  it("los enlaces de la unidad conservan el período, y los del período la unidad", async () => {
    mockKpis.mockResolvedValue(datos(3));

    await dibujar("mes", { periodo: "este_anio" });

    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/metricas?serie=dia&periodo=este_anio");
    expect(hrefs).toContain("/metricas?serie=mes&periodo=esta_semana");
    // el período de siempre no ensucia la URL de siempre
    expect(hrefs).toContain("/metricas?serie=mes");
  });

  it("muestra el ciclo: sin intervención, medianas, mensajes y dónde se quedan los casos", async () => {
    mockKpis.mockResolvedValue(
      datos(3, undefined, {
        sin_intervencion_rate: 40,
        mensajes_por_caso: 6.5,
        ciclo: { mediana_horas_listo: 0.5, casos_listo: 4, mediana_horas_cierre: 72, casos_cierre: 2 },
        cuellos: [
          { estado: "info_faltante", horas_promedio: 30, estancias: 5 },
          { estado: "confirmacion_pendiente", horas_promedio: 2.5, estancias: 3 },
        ],
      })
    );

    await dibujar("dia");

    expect(screen.getByText("Sin intervención humana").parentElement).toHaveTextContent("40%");
    expect(screen.getByText("Mediana hasta completar").parentElement).toHaveTextContent("30 min");
    expect(screen.getByText("Mediana hasta pagado o rechazado").parentElement).toHaveTextContent("3 d");
    expect(screen.getByText("Mensajes por caso").parentElement).toHaveTextContent("6,5");
    const cuellos = screen.getByTestId("cuellos");
    expect(cuellos).toHaveTextContent("Info faltante");
    expect(cuellos).toHaveTextContent("30 h");
    expect(cuellos).toHaveTextContent("Confirmación pendiente");
  });

  it("sin medida, las tarjetas del ciclo dicen «—» y no cero", async () => {
    mockKpis.mockResolvedValue(datos(3));

    await dibujar("dia");

    expect(screen.getByText("Sin intervención humana").parentElement).toHaveTextContent("—");
    expect(screen.getByText("Mediana hasta completar").parentElement).toHaveTextContent("—");
    expect(screen.getByText("Mensajes por caso").parentElement).toHaveTextContent("—");
    expect(screen.getByTestId("cuellos")).toHaveTextContent("Todavía no hay estadías terminadas");
  });
});

describe("/metricas — la vista del historial", () => {
  beforeEach(() => {
    mockKpis.mockReset();
    mockHistorial.mockReset();
  });

  const fila = (mes: string, reclamos: number, extra = {}) => ({
    mes,
    reclamos,
    con_listo: 0,
    mediana_horas_listo: null,
    con_cierre: 0,
    mediana_horas_cierre: null,
    sin_intervencion: 0,
    mensajes_por_caso: null,
    completados: 0,
    escalados: 0,
    cerrados: 0,
    ...extra,
  });

  it("pide sólo el historial: ni las consultas del tablero, ni la serie, ni el resumen de ayer", async () => {
    mockHistorial.mockResolvedValue([
      fila("2026-08", 0),
      fila("2026-09", 10, { sin_intervencion: 4, mediana_horas_listo: 12.34 }),
    ]);

    await dibujar("dia", { vista: "historial" });

    expect(mockHistorial).toHaveBeenCalledWith({ tenantId: "t1" });
    expect(mockKpis).not.toHaveBeenCalled();
    const tabla = screen.getByTestId("historial");
    // el mes más nuevo arriba
    const filas = tabla.querySelectorAll("tbody tr");
    expect(filas[0]).toHaveTextContent("40%");
    expect(filas[0]).toHaveTextContent("12,3");
    expect(filas[1]).toHaveTextContent("—");
    expect(screen.getByRole("link", { name: "Descargar CSV" })).toHaveAttribute(
      "href",
      "/api/metricas/export.csv"
    );
    // ni tarjetas ni serie: sólo el historial
    expect(screen.queryByTestId("serie-actividad")).toBeNull();
    expect(screen.queryByTestId("cuellos")).toBeNull();
  });

  it("las columnas de la tabla son las mismas que las del CSV, en el mismo orden", async () => {
    mockHistorial.mockResolvedValue([fila("2026-09", 10)]);

    await dibujar("dia", { vista: "historial" });

    const encabezados = within(screen.getByTestId("historial")).getAllByRole("columnheader");
    expect(encabezados.map((c) => c.textContent)).toEqual(COLUMNAS_DEL_HISTORIAL.map((c) => getT("es-AR")(c)));
  });

  it("el tablero de siempre no pide el historial", async () => {
    mockKpis.mockResolvedValue(datos(3));

    await dibujar("dia");

    expect(mockHistorial).not.toHaveBeenCalled();
  });

  it("el selector de vista ofrece las mismas vistas que entiende la URL", async () => {
    mockKpis.mockResolvedValue(datos(3));

    await dibujar("dia");

    const vistas = within(screen.getByRole("navigation", { name: "Métricas" })).getAllByRole("link");
    expect(vistas.map((a) => a.getAttribute("href"))).toEqual(
      VISTAS.map((v) => hrefDeMetricas({ serie: "dia", periodo: "este_mes", vista: v }))
    );
  });
});
