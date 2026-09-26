/**
 * /metricas con la serie de actividad, dibujada entera.
 *
 * El componente y `getTenantKpis` se prueban cada uno por su lado; esto prueba
 * la unión: que `?serie=` llegue a la consulta, y que la sección salga adentro
 * del tablero y no en ceros debajo de «no hay datos».
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockKpis } = vi.hoisted(() => ({ mockKpis: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), unstable_rethrow: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getSessionContext: vi.fn(async () => ({ user: { id: "u1" } })),
}));
vi.mock("@/lib/auth/user-row", () => ({
  getUserRow: vi.fn(async () => ({ tenant_id: "t1" })),
}));
vi.mock("@/lib/i18n/locale", () => ({ getServerLocale: vi.fn(async () => "es-AR") }));
vi.mock("@/data/scope", () => ({ enTenant: vi.fn() }));
vi.mock("@/server/metrics/kpis", () => ({ getTenantKpis: mockKpis }));

import MetricasPage from "@/app/(app)/metricas/page";
import type { MetricasData } from "@/server/metrics/kpis";

const SIN_USO = { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0 };

function datos(casos: number): MetricasData {
  return {
    summary: {
      total_cases_month: casos,
      avg_first_response_minutes: null,
      auto_completion_rate: 0,
      escalated_count: 0,
    },
    by_status: { listo: casos },
    by_type: {},
    top_analysts: [],
    ai_usage: { month: SIN_USO, all_time: SIN_USO, by_user: [], by_model: [] },
    period: { start: "", end: "" },
    serie: [{ clave: "2026-09-15", reclamos: casos, whatsapps: 0, mails: 0 }],
  };
}

async function dibujar(serie?: string) {
  render(await MetricasPage({ searchParams: Promise.resolve({ serie }) }));
}

describe("/metricas — la serie de actividad", () => {
  beforeEach(() => mockKpis.mockReset());

  it("`?serie=dia` llega a la consulta y la serie sale en el tablero", async () => {
    mockKpis.mockResolvedValue(datos(3));

    await dibujar("dia");

    expect(mockKpis).toHaveBeenCalledWith({ tenantId: "t1" }, { serie: "dia" });
    expect(screen.getByTestId("serie-actividad")).toBeInTheDocument();
    expect(screen.getByRole("link", { current: "page" })).toHaveTextContent("Por día");
  });

  it("sin `?serie=` pide la mensual", async () => {
    mockKpis.mockResolvedValue(datos(3));

    await dibujar();

    expect(mockKpis).toHaveBeenCalledWith({ tenantId: "t1" }, { serie: "mes" });
  });

  it("sin ningún caso queda sólo el aviso, no una serie en ceros debajo", async () => {
    mockKpis.mockResolvedValue(datos(0));

    await dibujar("dia");

    expect(screen.getByText(/No hay datos disponibles/)).toBeInTheDocument();
    expect(screen.queryByTestId("serie-actividad")).not.toBeInTheDocument();
  });
});
