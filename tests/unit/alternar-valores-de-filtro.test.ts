/**
 * Los filtros de la bandeja pasaron de un valor por grupo a varios.
 *
 * `alternar` es la mitad pura de ese cambio —agregar o sacar un valor de la
 * lista— y `filtrosPuestos` es quien arma las marcas de afuera del panel a
 * partir de esas listas. Las dos se prueban solas, sin URL de por medio, y
 * después el hook que sí toca la URL se prueba con `renderHook`.
 */

import { createElement } from "react";
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { alternar, filtrosPuestos } from "../../src/app/(app)/bandeja/components/grupos-de-filtro";
import { useFilterParam } from "../../src/app/(app)/bandeja/components/useFilterParam";
import { NavegacionPendienteProvider } from "../../src/app/(app)/bandeja/components/navegacion-pendiente";

describe("alternar", () => {
  it("agrega un valor que no estaba", () => {
    expect(alternar([], "choque")).toEqual(["choque"]);
  });

  it("deja los dos cuando se agrega un segundo valor", () => {
    expect(alternar(["choque"], "robo")).toEqual(["choque", "robo"]);
  });

  it("saca uno solo y deja el otro", () => {
    expect(alternar(["choque", "robo"], "choque")).toEqual(["robo"]);
  });
});

describe("filtrosPuestos", () => {
  it("devuelve una entrada por valor y descarta claves que no existen en el grupo", () => {
    const leer = (param: string) =>
      param === "type" ? ["choque", "meteorito"] : [];

    const puestos = filtrosPuestos(leer);

    expect(puestos).toEqual([
      { param: "type", valor: "choque", rotulo: "filter.tipo", etiqueta: "type.choque", color: undefined },
    ]);
  });

  it("respeta el orden de los grupos", () => {
    // `status` está declarado antes que `type` en GRUPOS_DE_FILTRO: sus
    // valores tienen que aparecer primero aunque `type` traiga más de uno.
    const leer = (param: string) => {
      if (param === "status") return ["listo"];
      if (param === "type") return ["choque", "robo"];
      return [];
    };

    const puestos = filtrosPuestos(leer);

    expect(puestos.map((p) => `${p.param}:${p.valor}`)).toEqual([
      "status:listo",
      "type:choque",
      "type:robo",
    ]);
  });
});

const push = vi.hoisted(() => vi.fn());
const buscados = vi.hoisted(() => ({ actual: "" }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(buscados.actual),
  usePathname: () => "/bandeja",
}));

function montarHook() {
  return renderHook(() => useFilterParam(), {
    wrapper: ({ children }) => createElement(NavegacionPendienteProvider, null, children),
  });
}

/** La URL que se empujó, como parámetros. */
function ultimaUrl(): URLSearchParams {
  const url = push.mock.calls.at(-1)?.[0] as string;
  const i = url.indexOf("?");
  return new URLSearchParams(i === -1 ? "" : url.slice(i + 1));
}

describe("useFilterParam", () => {
  it("dos valores quedan como parámetros repetidos en la URL", () => {
    buscados.actual = "";
    push.mockClear();
    const { result } = montarHook();

    act(() => result.current("type", ["choque", "robo"]));

    expect(ultimaUrl().getAll("type")).toEqual(["choque", "robo"]);
  });

  it("sacar el último valor borra el parámetro", () => {
    buscados.actual = "type=choque";
    push.mockClear();
    const { result } = montarHook();

    act(() => result.current("type", []));

    expect(ultimaUrl().has("type")).toBe(false);
  });

  it("cambiar un filtro siempre borra page", () => {
    buscados.actual = "type=choque&page=4";
    push.mockClear();
    const { result } = montarHook();

    act(() => result.current("type", ["robo"]));

    expect(ultimaUrl().has("page")).toBe(false);
  });
});
