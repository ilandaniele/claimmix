/**
 * «Para responder» en la bandeja: lo que el sondeo trae o deja de traer.
 *
 * En la cola una fila nueva es un caso viejo que se acaba de marcar, y una que
 * falta es un caso que alguien ya contestó. Ninguna de las dos cosas es lo que
 * el sondeo de la bandeja entiende por alta, así que la cola le pregunta de
 * nuevo al servidor.
 */

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardClient } from "../../../src/app/(app)/bandeja/DashboardClient";
import { LocaleProvider } from "../../../src/lib/i18n/LocaleContext";
import type { CaseRow } from "../../../src/server/cases/list";

const nav = vi.hoisted(() => ({ busqueda: new URLSearchParams(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: nav.refresh }),
  useSearchParams: () => nav.busqueda,
  usePathname: () => "/bandeja",
}));

const UNO = "00000000-0000-0000-0000-000000000001";
const DOS = "00000000-0000-0000-0000-000000000002";

function caso(id: string): CaseRow {
  return {
    id,
    tenant_id: "tenant-1",
    policy_number: "POL-001",
    policyholder_name: "Juan Pérez",
    claim_type: "choque",
    status: "listo",
    confidence_min: 0.85,
    assigned_to: null,
    channel: "whatsapp",
    created_at: "2026-09-06T00:00:00.000Z",
    updated_at: null,
    closed_at: null,
    para_responder_desde: "2026-09-07T00:00:00.000Z",
  } as unknown as CaseRow;
}

/** Lo que devuelve cada sondeo, en orden; el último se repite. */
function montar(query: string, iniciales: CaseRow[], sondeos: CaseRow[][]) {
  nav.busqueda = new URLSearchParams(query);
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const data = sondeos[Math.min(i++, sondeos.length - 1)];
      return { ok: true, json: async () => ({ data }) } as Response;
    })
  );
  render(
    <LocaleProvider locale="es-AR">
      <DashboardClient
        initialData={{
          data: iniciales,
          meta: { total: iniciales.length, page: 1, per_page: 20, pages: 1 },
        }}
        scenarios={[]}
        allStatusCounts={[
          { status: "todos", count: 2 },
          { status: "listo", count: 2 },
        ]}
      />
    </LocaleProvider>
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  nav.refresh.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("«Para responder» y el sondeo", () => {
  it("un caso que se marca mientras mirás la cola no avisa un siniestro nuevo", async () => {
    montar("para_responder=true", [caso(UNO)], [[caso(UNO)], [caso(UNO), caso(DOS)]]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);

    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Nuevo siniestro recibido/)).toBeNull();
  });

  it("en la bandeja, un alta sigue siendo un siniestro nuevo", async () => {
    montar("", [caso(UNO)], [[caso(UNO)], [caso(DOS), caso(UNO)]]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);

    expect(nav.refresh).not.toHaveBeenCalled();
    expect(screen.getByText(/Nuevo siniestro recibido/)).toBeInTheDocument();
  });

  // El Atrás del navegador restaura la cola de antes de marcar: el primer
  // sondeo ya no trae el caso contestado.
  it("lo que el sondeo ya no trae sale de la cola", async () => {
    montar("para_responder=true", [caso(UNO), caso(DOS)], [[caso(DOS)]]);
    await vi.advanceTimersByTimeAsync(0);

    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });

  it("con la cola al día no le vuelve a preguntar al servidor", async () => {
    montar("para_responder=true", [caso(UNO), caso(DOS)], [[caso(UNO), caso(DOS)]]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);

    expect(nav.refresh).not.toHaveBeenCalled();
  });
});
