/**
 * El gráfico «Siniestros por tipo» de /metricas, con ramos propios.
 *
 * Dibujaba sólo los tipos del código, pero el porcentaje se calculaba sobre
 * TODO `by_type`: los casos de un ramo propio inflaban el total sin tener
 * barra, y los porcentajes no llegaban a 100.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockKpis, mockRamos } = vi.hoisted(() => ({ mockKpis: vi.fn(), mockRamos: vi.fn() }));

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
vi.mock("@/server/cases/ramos-del-inquilino", () => ({ cargarRamosDelInquilino: mockRamos }));

import MetricasPage from "@/app/(app)/metricas/page";
import type { MetricasData } from "@/server/metrics/kpis";
import { PERIODO_DEL_MES, RESUMEN_DEL_CICLO } from "../mocks/metricas-datos";

const SIN_USO = { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };

function datos(porTipo: Record<string, number>): MetricasData {
  return {
    summary: {
      total_cases_month: Object.values(porTipo).reduce((a, b) => a + b, 0),
      avg_first_response_minutes: null,
      completado_confirmado_rate: 0,
      escalated_count: 0,
      ...RESUMEN_DEL_CICLO,
    },
    by_status: {},
    by_type: porTipo,
    top_analysts: [],
    ai_usage: { month: SIN_USO, all_time: SIN_USO, by_user: [], by_model: [] },
    period: { start: "", end: "" },
    periodo: PERIODO_DEL_MES,
    serie: null,
  };
}

const CAUCION = { clave: "caucion", nombre_es: "Caución", nombre_en: "Surety bond", documentos: [], datos: [] };

beforeEach(() => {
  mockRamos.mockReset();
  mockRamos.mockResolvedValue([CAUCION]);
});

describe("/metricas — el gráfico por tipo dibuja también los ramos propios", () => {
  it("un ramo propio tiene barra con su nombre y los porcentajes suman 100", async () => {
    mockKpis.mockResolvedValue(datos({ choque: 6, caucion: 4 }));

    render(await MetricasPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("Caución").parentElement).toHaveTextContent("4 (40%)");
    expect(screen.getByText("Choque").parentElement).toHaveTextContent("6 (60%)");
    expect(screen.getByRole("progressbar", { name: "Caución" })).toBeInTheDocument();
    expect(mockRamos).toHaveBeenCalledWith("t1");
  });

  it("un ramo propio cuya fila se borró se nombra con su clave humanizada", async () => {
    mockRamos.mockResolvedValue([]);
    mockKpis.mockResolvedValue(datos({ choque: 1, mi_ramo_viejo: 1 }));

    render(await MetricasPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("Mi ramo viejo").parentElement).toHaveTextContent("1 (50%)");
  });

  it("una clave que coincide con una propiedad de Object no rompe la pantalla", async () => {
    mockKpis.mockResolvedValue(datos({ choque: 1, constructor: 1 }));

    render(await MetricasPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("Constructor").parentElement).toHaveTextContent("1 (50%)");
  });

  it("sin ramos propios con casos no lee la tabla de ramos", async () => {
    mockKpis.mockResolvedValue(datos({ choque: 3, robo: 1 }));

    render(await MetricasPage({ searchParams: Promise.resolve({}) }));

    expect(mockRamos).not.toHaveBeenCalled();
    expect(screen.getByText("Choque").parentElement).toHaveTextContent("3 (75%)");
  });
});
