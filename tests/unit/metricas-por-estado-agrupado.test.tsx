/**
 * El gráfico «Siniestros por situación» de /metricas, con estados de verdad.
 *
 * El canal real nunca escribe `listo`, `esperando` ni `escalado` —esos son el
 * vocabulario del flujo simulado— así que `by_status` trae `requiere_especialista`,
 * `listo_para_core`, `recibido`, `no_relevante`... El gráfico dibujaba sólo las
 * cinco claves legadas, así que los casos de verdad no tenían barra y el 100%
 * del gráfico se repartía sobre un total que ni siquiera los contaba.
 *
 * Esto prueba que agrupa por `filtro-de-estado.ts` —los mismos seis grupos que
 * ya usa la bandeja— y que el porcentaje se calcula sobre esos grupos, sin
 * `no_relevante` diluyendo la cuenta.
 */

import { describe, it, expect, vi } from "vitest";
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

function datos(porEstado: Record<string, number>): MetricasData {
  return {
    summary: {
      total_cases_month: Object.values(porEstado).reduce((a, b) => a + b, 0),
      avg_first_response_minutes: null,
      auto_completion_rate: 0,
      escalated_count: 0,
    },
    by_status: porEstado,
    by_type: {},
    top_analysts: [],
    ai_usage: { month: SIN_USO, all_time: SIN_USO, by_user: [], by_model: [] },
    period: { start: "", end: "" },
    serie: null,
  };
}

describe("/metricas — el gráfico por situación agrupa los estados crudos", () => {
  it("los estados del canal real tienen barra, y `no_relevante` no infla el total", async () => {
    mockKpis.mockResolvedValue(
      datos({
        requiere_especialista: 10, // grupo «escalado»
        listo_para_core: 5, // grupo «listo»
        recibido: 3, // grupo «procesando»
        no_relevante: 100, // fuera de los seis grupos
      })
    );

    render(await MetricasPage({ searchParams: Promise.resolve({}) }));

    // El total de la partición es 18 (10+5+3), no 118: si `no_relevante`
    // entrara en la cuenta, el 56% de acá sería un 8%.
    expect(screen.getByText("Escalados").parentElement).toHaveTextContent("10 (56%)");
    expect(screen.getByText("Listos").parentElement).toHaveTextContent("5 (28%)");
    expect(screen.getByText("Procesando").parentElement).toHaveTextContent("3 (17%)");
  });

  it("un estado que no aparece en la respuesta cuenta cero, no rompe", async () => {
    mockKpis.mockResolvedValue(datos({ requiere_especialista: 4 }));

    render(await MetricasPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getByText("Escalados").parentElement).toHaveTextContent("4 (100%)");
    expect(screen.getByText("Cerrados").parentElement).toHaveTextContent("0 (0%)");
  });
});
