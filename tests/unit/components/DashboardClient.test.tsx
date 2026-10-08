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

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";
import { DashboardClient } from "../../../src/app/(app)/bandeja/DashboardClient";
import { LocaleProvider } from "../../../src/lib/i18n/LocaleContext";
import type { CaseRow } from "../../../src/server/cases/list";

const nav = vi.hoisted(() => ({ busqueda: new URLSearchParams("") }));
const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
const enVuelo = vi.hoisted(() => ({ pendiente: false }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => nav.busqueda,
  usePathname: () => "/bandeja",
}));

// Una navegación que no llegó todavía: sin esto la transición del mock termina
// en el mismo turno y `paramsVisibles` vuelve siempre a la URL real.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useTransition: () => [enVuelo.pendiente, (cb: () => void) => cb()],
  };
});

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
    nav.busqueda = new URLSearchParams("");
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

/**
 * El total del encabezado sigue al filtro de estado durante el sondeo.
 *
 * Antes `handleUpdate` sólo tocaba `statusCountsBase` (las pestañas). El total
 * del encabezado —lo que dice «N reclamos» arriba de la tabla— es un
 * `useState` aparte que sólo bajaba al borrar: una fila que el sondeo trae con
 * un estado que el filtro activo ya no cubre desaparecía de la tabla, pero el
 * número de arriba seguía contando las dos.
 */
describe("DashboardClient — el total del encabezado y el filtro de estado", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("una fila que el sondeo saca del estado activo baja el total en uno", async () => {
    nav.busqueda = new URLSearchParams("status=procesando");
    const inicial = [
      makeCase({ status: "procesando" }),
      makeCase({ id: DOS, policyholder_name: "Ana Gómez", status: "procesando" }),
    ];

    let sondeo = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const rows =
          sondeo++ === 0
            ? inicial
            : [inicial[0], { ...inicial[1], status: "listo_para_core" }];
        return { ok: true, json: async () => ({ data: rows }) } as Response;
      })
    );

    render(
      <LocaleProvider locale="es-AR">
        <DashboardClient
          initialData={{ data: inicial, meta: { total: 2, page: 1, per_page: 20, pages: 1 } }}
          scenarios={[]}
          allStatusCounts={[
            { status: "todos", count: 2 },
            { status: "procesando", count: 2 },
          ]}
        />
      </LocaleProvider>
    );

    expect(document.querySelector(".cifra")).toHaveTextContent("2");

    // Primer sondeo: siembra la base con las mismas dos filas.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Segundo sondeo: una de las dos pasa a un estado fuera del filtro activo.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(document.querySelector(".cifra")).toHaveTextContent("1");
  });
});

const TOTALES_DEL_TABLERO = {
  procesando: 43,
  esperando: 0,
  confirmacion_pendiente: 0,
  escalado: 0,
  listo: 0,
  cerrado: 0,
};

function montarTablero(busqueda: string, data: CaseRow[] = [makeCase()]) {
  nav.busqueda = new URLSearchParams(busqueda);
  return render(
    <LocaleProvider locale="es-AR">
      <DashboardClient
        initialData={{ data, meta: { total: 43, page: 1, per_page: 20, pages: 1 } }}
        scenarios={[]}
        allStatusCounts={[
          { status: "todos", count: 2 },
          { status: "procesando", count: 2 },
        ]}
        totalesDelTablero={TOTALES_DEL_TABLERO}
      />
    </LocaleProvider>
  );
}

describe("DashboardClient — la vista lista y tablero", () => {
  beforeEach(() => {
    push.mockClear();
    refresh.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }) as Response)
    );
  });
  afterEach(() => {
    enVuelo.pendiente = false;
    vi.unstubAllGlobals();
  });

  it("el clic en Tablero lo marca al instante y empuja una URL sin page", () => {
    enVuelo.pendiente = true;
    montarTablero("page=3&type=choque");
    // La URL todavía es la lista: el botón sigue al destino.
    fireEvent.click(screen.getByRole("button", { name: "Tablero" }));

    expect(screen.getByRole("button", { name: "Tablero" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Lista" })).toHaveAttribute("aria-pressed", "false");
    const url = new URL(push.mock.calls.at(-1)?.[0] as string, "http://x");
    expect(url.pathname).toBe("/bandeja");
    expect(url.searchParams.get("vista")).toBe("tablero");
    expect(url.searchParams.get("type")).toBe("choque");
    expect(url.searchParams.has("page")).toBe(false);
  });

  it("volver a la lista saca vista y page", () => {
    enVuelo.pendiente = true;
    montarTablero("vista=tablero&page=2&q=perez");
    fireEvent.click(screen.getByRole("button", { name: "Lista" }));

    expect(push).toHaveBeenLastCalledWith("/bandeja?q=perez");
  });

  it("el tablero usa los totales del servidor, no los contadores de las pestañas", () => {
    montarTablero("vista=tablero");
    expect(screen.getByText("1 de 43")).toBeInTheDocument();
  });

  it("mientras la navegación está en vuelo el tablero se atenúa y queda ocupado", () => {
    enVuelo.pendiente = true;
    montarTablero("vista=tablero");
    const contenedor = screen.getByRole("heading", { level: 3, name: "Procesando" }).closest("[aria-busy]");
    expect(contenedor).toHaveAttribute("aria-busy", "true");
    expect(contenedor).toHaveClass("opacity-60", "pointer-events-none");
  });

  it("con la navegación quieta el tablero no está ocupado", () => {
    montarTablero("vista=tablero");
    const contenedor = screen.getByRole("heading", { level: 3, name: "Procesando" }).closest("[aria-busy]");
    expect(contenedor).toHaveAttribute("aria-busy", "false");
    expect(contenedor).not.toHaveClass("opacity-60");
  });

  it("el CSV se pide sin vista", () => {
    montarTablero("vista=tablero&type=choque");
    expect(screen.getByRole("link", { name: "Exportar CSV" })).toHaveAttribute(
      "href",
      "/api/cases/export.csv?type=choque"
    );
  });

  it("en el tablero una fila nueva del sondeo pide la pantalla al servidor y no se mezcla", async () => {
    vi.useFakeTimers();
    try {
      let sondeo = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          const rows = sondeo++ === 0 ? [] : [makeCase({ id: DOS, policyholder_name: "Ana Gómez" })];
          return { ok: true, json: async () => ({ data: rows }) } as Response;
        })
      );
      montarTablero("vista=tablero", []);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(refresh).toHaveBeenCalled();
      expect(screen.queryByText("SIN-0000-0002")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("en el tablero varias filas que cambian en una misma vuelta del sondeo piden una sola vez", async () => {
    vi.useFakeTimers();
    try {
      const TRES = "00000000-0000-0000-0000-000000000003";
      let sondeo = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          const rows =
            sondeo++ === 0
              ? [makeCase()]
              : [
                  makeCase({ status: "listo" as CaseRow["status"] }),
                  makeCase({ id: DOS, policyholder_name: "Ana Gómez" }),
                  makeCase({ id: TRES, policyholder_name: "Luis Soto" }),
                ];
          return { ok: true, json: async () => ({ data: rows }) } as Response;
        })
      );
      montarTablero("vista=tablero", []);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
