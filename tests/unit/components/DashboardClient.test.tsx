/**
 * Borrar desde la bandeja: qué queda marcado después.
 *
 * La ventana en la que lo marcado y lo borrado difieren no es sólo la del
 * atajo «no volver a preguntar». El diálogo de confirmación no atrapa el
 * foco —no hay `inert` sobre el fondo ni se mueve el foco al abrirlo—, así
 * que con el teclado se siguen marcando filas mientras está abierto: la
 * misma divergencia existe también por el camino CON confirmación. Este test
 * recorre ese camino y fija el resultado: la poda saca de lo marcado lo que
 * el borrado se llevó, y nada más.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";
import { DashboardClient } from "../../../src/app/(app)/bandeja/DashboardClient";
import { LocaleProvider } from "../../../src/lib/i18n/LocaleContext";
import type { CaseRow } from "../../../src/server/cases/list";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/bandeja",
}));

const UNO = "00000000-0000-0000-0000-000000000001";
const DOS = "00000000-0000-0000-0000-000000000002";

function makeCase(overrides: Partial<CaseRow> = {}): CaseRow {
  return {
    id: UNO,
    tenant_id: "tenant-1",
    policy_number: "POL-001",
    policyholder_name: "Juan Pérez",
    claim_type: "choque",
    status: "procesando",
    confidence_min: 0.85,
    assigned_to: null,
    channel: "email_sim",
    created_at: new Date().toISOString(),
    updated_at: null,
    closed_at: null,
    ...overrides,
  } as CaseRow;
}

/** El `.cifra` de la barra del modo selección: cuántas dice que hay marcadas. */
function cifra() {
  return screen.getByRole("toolbar").querySelector(".cifra");
}

function montar(borrados: string[]) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    // El sondeo de `useCasesRealtime` arranca al montar: se le contesta vacío
    // para que sólo siembre su base y no toque nada.
    if (init?.method !== "DELETE") {
      return { ok: true, json: async () => ({ data: [] }) } as Response;
    }
    return { ok: true, json: async () => ({ deleted: borrados }) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);

  const dos = [makeCase(), makeCase({ id: DOS, policyholder_name: "Ana Gómez" })];
  render(
    <LocaleProvider locale="es-AR">
      <DashboardClient
        initialData={{ data: dos, meta: { total: 2, page: 1, per_page: 20, pages: 1 } }}
        scenarios={[]}
        allStatusCounts={[
          { status: "todos", count: 2 },
          { status: "procesando", count: 2 },
        ]}
      />
    </LocaleProvider>
  );
  return fetchMock;
}

describe("DashboardClient — borrar y lo que queda marcado", () => {
  beforeEach(() => {
    localStorage.clear();
    push.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("con el diálogo abierto se puede marcar otra fila, y esa marca sobrevive al borrado", async () => {
    montar([UNO]);

    fireEvent.click(screen.getByRole("button", { name: "Seleccionar" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /SIN-0000-0001/ }));
    fireEvent.click(screen.getByRole("button", { name: /Eliminar seleccionados \(1\)/ }));

    // El overlay tapa el mouse, no el teclado: la fila de atrás sigue
    // respondiendo a Enter/Espacio con el diálogo abierto.
    const dialogo = screen.getByRole("dialog");
    fireEvent.keyDown(screen.getByRole("row", { name: /SIN-0000-0002/ }), { key: " " });
    expect(screen.getByRole("checkbox", { name: /SIN-0000-0002/ })).toHaveAttribute(
      "aria-checked",
      "true"
    );

    fireEvent.click(within(dialogo).getByRole("button", { name: "Eliminar" }));

    // Se fue la fila borrada; la marcada mientras tanto sigue marcada.
    await waitFor(() =>
      expect(screen.queryByRole("row", { name: /SIN-0000-0001/ })).toBeNull()
    );
    expect(screen.getByRole("checkbox", { name: /SIN-0000-0002/ })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(cifra()).toHaveTextContent("1");
    expect(push).not.toHaveBeenCalled();
  });

  it("sin confirmación, lo mismo: se borra al toque y la marca nueva queda", async () => {
    localStorage.setItem("claimmix:skip-delete-confirm", "true");
    montar([UNO]);

    fireEvent.click(screen.getByRole("button", { name: "Seleccionar" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /SIN-0000-0001/ }));
    fireEvent.click(screen.getByRole("button", { name: /Eliminar seleccionados \(1\)/ }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.keyDown(screen.getByRole("row", { name: /SIN-0000-0002/ }), { key: " " });

    await waitFor(() =>
      expect(screen.queryByRole("row", { name: /SIN-0000-0001/ })).toBeNull()
    );
    expect(screen.getByRole("checkbox", { name: /SIN-0000-0002/ })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(cifra()).toHaveTextContent("1");
  });
});
