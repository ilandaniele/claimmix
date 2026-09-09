/**
 * Las pestañas de estado, como pestañas de verdad.
 *
 * Declaraban `role="tablist"` y `role="tab"` sin `tabpanel`, sin
 * `aria-controls` y sin flechas: un lector anunciaba «pestaña 2 de 6», la
 * persona apretaba la flecha y no pasaba nada. Lo que se fija acá es que la
 * promesa se cumpla.
 *
 * Y de paso el reenvío de filtros al sondeo en vivo, que tenía su propia lista
 * de parámetros distinta de las otras dos y ningún test. El síntoma de que se
 * separen no es un error: es que cada cinco a treinta segundos el sondeo trae
 * filas que no cumplen el filtro nuevo y las inyecta en la lista.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import {
  FilterTabs,
  ID_PANEL_DE_LA_LISTA,
} from "../../../src/app/(app)/bandeja/components/FilterTabs";
import { NavegacionPendienteProvider } from "../../../src/app/(app)/bandeja/components/navegacion-pendiente";
import { LocaleProvider } from "../../../src/lib/i18n/LocaleContext";
import { FILTER_PARAMS } from "../../../src/app/(app)/bandeja/components/useCasesRealtime";
import { PARAMS_DE_FILTRO } from "../../../src/app/(app)/bandeja/components/grupos-de-filtro";

const push = vi.hoisted(() => vi.fn());
const buscados = vi.hoisted(() => ({ actual: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(buscados.actual),
  usePathname: () => "/bandeja",
}));

const CUENTAS = [
  { status: "todos" as const, count: 483 },
  { status: "listo" as const, count: 120 },
  { status: "esperando" as const, count: 211 },
  { status: "escalado" as const, count: 43 },
  { status: "procesando" as const, count: 9 },
  { status: "cerrado" as const, count: 100 },
];

function montar(query = "", activo?: "listo" | "escalado") {
  buscados.actual = query;
  return render(
    <LocaleProvider locale="es-AR">
      <NavegacionPendienteProvider>
        <FilterTabs counts={CUENTAS} activeStatus={activo} />
      </NavegacionPendienteProvider>
    </LocaleProvider>
  );
}

/** El parámetro `status` de la última URL empujada. */
function statusEmpujado(): string | null {
  const url = push.mock.calls.at(-1)?.[0] as string;
  const i = url.indexOf("?");
  return new URLSearchParams(i === -1 ? "" : url.slice(i + 1)).get("status");
}

describe("FilterTabs — el patrón de pestañas está completo", () => {
  beforeEach(() => push.mockClear());

  it("sólo la activa está en el orden de tabulación", () => {
    montar("", "listo");

    const pestanas = screen.getAllByRole("tab");
    const enElOrden = pestanas.filter((p) => p.getAttribute("tabindex") === "0");

    // Foco itinerante: un Tab lleva al grupo, no a cada pestaña de a una.
    expect(enElOrden).toHaveLength(1);
    expect(enElOrden[0]).toHaveTextContent("Listos");
  });

  it("cada pestaña apunta al panel de la lista", () => {
    montar();
    for (const p of screen.getAllByRole("tab")) {
      expect(p).toHaveAttribute("aria-controls", ID_PANEL_DE_LA_LISTA);
    }
  });

  it("la flecha derecha pasa a la siguiente", () => {
    montar("", "listo"); // índice 1 de seis
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(statusEmpujado()).toBe("esperando");
  });

  it("la flecha izquierda vuelve, y desde la primera da la vuelta", () => {
    montar(); // «Todos», índice 0
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowLeft" });
    expect(statusEmpujado()).toBe("cerrado");
  });

  it("Inicio y Fin van a los extremos", () => {
    montar("", "escalado");

    fireEvent.keyDown(screen.getByRole("tablist"), { key: "End" });
    expect(statusEmpujado()).toBe("cerrado");

    fireEvent.keyDown(screen.getByRole("tablist"), { key: "Home" });
    // «Todos» saca el parámetro en vez de ponerlo.
    expect(statusEmpujado()).toBeNull();
  });

  it("una tecla cualquiera no navega", () => {
    montar("", "listo");
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "a" });
    expect(push).not.toHaveBeenCalled();
  });

  it("el rótulo del grupo sale del diccionario, no escrito a mano", () => {
    montar();
    // Estaba en castellano fijo: con la interfaz en inglés se leía la mitad en
    // cada idioma.
    expect(screen.getByRole("tablist")).toHaveAccessibleName("Filtrar por estado");
  });
});

describe("el sondeo en vivo reenvía TODOS los filtros de la pantalla", () => {
  it("no se le puede escapar ninguno del panel", () => {
    // La lista del sondeo se arma desde la del panel, así que agregar un filtro
    // nuevo lo incluye solo. Este test es lo que impide volver a la lista
    // escrita a mano.
    for (const p of PARAMS_DE_FILTRO) {
      expect(FILTER_PARAMS).toContain(p);
    }
  });

  it("y lleva `status`, que no es del panel sino de las pestañas", () => {
    expect(FILTER_PARAMS).toContain("status");
  });
});
