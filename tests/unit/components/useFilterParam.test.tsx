/**
 * `useFilterParam` arma la URL siguiente sobre `paramsVisibles` (el destino
 * de una navegación en vuelo), no sobre `useSearchParams()` directo.
 *
 * Antes leía la URL real. Con la navegación en vuelo esa URL real está
 * vieja: sacar un filtro y al toque poner otro arma el segundo sobre la
 * URL de ANTES del primer click, y el primero se pierde. Acá se fuerza el
 * estado «en vuelo» (`useTransition` mockeado a pendiente) para que el
 * segundo click se dispare mientras el primero todavía no llegó a la URL
 * real — que es justo la ventana donde el bug aparecía.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { vi, describe, it, expect } from "vitest";
import { useFilterParam } from "../../../src/app/(app)/bandeja/components/useFilterParam";
import { NavegacionPendienteProvider } from "../../../src/app/(app)/bandeja/components/navegacion-pendiente";

const push = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams("status=listo&type=granizo"),
  usePathname: () => "/bandeja",
}));

// Sin esto la transición del mock de arriba termina antes del segundo click
// y `paramsVisibles` cae siempre en la URL real: el bug no se ve.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useTransition: () => [true, (cb: () => void) => cb()],
  };
});

function Prueba() {
  const setFilter = useFilterParam();
  return (
    <>
      <button onClick={() => setFilter("status", [])}>sacar status</button>
      <button onClick={() => setFilter("type", ["choque"])}>poner type</button>
    </>
  );
}

function ultimaUrl(): URLSearchParams {
  const url = push.mock.calls.at(-1)?.[0] as string;
  const i = url.indexOf("?");
  return new URLSearchParams(i === -1 ? "" : url.slice(i + 1));
}

describe("useFilterParam — sin carreras", () => {
  it("el segundo filtro se arma sobre el destino del primero, no sobre la URL vieja", () => {
    render(
      <NavegacionPendienteProvider>
        <Prueba />
      </NavegacionPendienteProvider>
    );

    fireEvent.click(screen.getByText("sacar status"));
    fireEvent.click(screen.getByText("poner type"));

    const url = ultimaUrl();
    // El status ya se había sacado en el primer click: si el segundo hubiera
    // leído la URL vieja, «status» reaparecería acá.
    expect(url.get("status")).toBeNull();
    expect(url.get("type")).toBe("choque");
  });
});
