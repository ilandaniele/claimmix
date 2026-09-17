/**
 * `?status=escalado` es una CLAVE de grupo, no un estado de la base.
 *
 * El recorte del lado del cliente comparaba la fila contra esa clave tal
 * cual: `c.status !== "escalado"`. El canal real nunca escribe `escalado`
 * —escribe `requiere_especialista`—, así que una fila que el sondeo trae con
 * ese estado desaparecía de la lista con el filtro puesto, aunque el
 * servidor ya la hubiera devuelto por pertenecer al grupo. Este test fija
 * que el recorte expande la clave con `estadosAConsultar` antes de comparar.
 */

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardClient } from "../../../src/app/(app)/bandeja/DashboardClient";
import { LocaleProvider } from "../../../src/lib/i18n/LocaleContext";
import type { CaseRow } from "../../../src/server/cases/list";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams("status=escalado"),
  usePathname: () => "/bandeja",
}));

const NUEVO = "00000000-0000-0000-0000-000000000009";

function makeCase(overrides: Partial<CaseRow> = {}): CaseRow {
  return {
    id: NUEVO,
    tenant_id: "tenant-1",
    policy_number: "POL-009",
    policyholder_name: "Requiere Especialista",
    claim_type: "choque",
    status: "requiere_especialista",
    confidence_min: 0.9,
    assigned_to: null,
    channel: "email",
    created_at: new Date().toISOString(),
    updated_at: null,
    closed_at: null,
    ...overrides,
  } as CaseRow;
}

describe("el estado activo cubre el grupo, no sólo su clave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("una fila que llega del sondeo con requiere_especialista queda con ?status=escalado puesto", async () => {
    const fetchMock = vi.fn(
      async () => ({ ok: true, json: async () => ({ data: [] }) }) as Response
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <LocaleProvider locale="es-AR">
        <DashboardClient
          initialData={{ data: [], meta: { total: 0, page: 1, per_page: 20, pages: 0 } }}
          scenarios={[]}
          allStatusCounts={[{ status: "todos", count: 0 }]}
        />
      </LocaleProvider>
    );

    // Primer sondeo: siembra la base vacía, sin disparar onInsert.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Segundo sondeo: llega la fila con su estado CRUDO del canal real.
    fetchMock.mockImplementation(
      async () =>
        ({ ok: true, json: async () => ({ data: [makeCase()] }) }) as Response
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.getByRole("row", { name: /SIN-0000-0009/ })).toBeInTheDocument();
  });
});
