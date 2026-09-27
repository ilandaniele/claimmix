/**
 * `normalizarBusqueda`, el recorte del `q` que llega por la URL de la bandeja.
 *
 * Se importa desde `page.tsx` con todas sus dependencias de servidor tapadas
 * — sesión, fila de usuario, listado de casos — porque este archivo no las
 * necesita para nada: sólo prueba la función pura que decide qué texto de
 * búsqueda pasa y cuál se descarta.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionContext: vi.fn() }));
vi.mock("@/lib/auth/user-row", () => ({ getUserRow: vi.fn() }));
vi.mock("@/lib/i18n/locale", () => ({ getServerLocale: vi.fn(async () => "es-AR") }));
vi.mock("@/server/cases/list", () => ({
  buildCaseFilters: vi.fn(),
  contarPorEstado: vi.fn(async () => []),
  desdeDePeriodo: vi.fn(),
  listCases: vi.fn(async () => ({ cases: [], total: 0 })),
}));
vi.mock("@/server/intake/scenarios", () => ({ OPCIONES_DE_ESCENARIO: [] }));

import { normalizarBusqueda } from "@/app/(app)/bandeja/page";

describe("normalizarBusqueda", () => {
  it("recorta los espacios de los extremos", () => {
    expect(normalizarBusqueda("  juan perez  ")).toBe("juan perez");
  });

  it("corta a 80 caracteres", () => {
    const largo = "a".repeat(100);
    expect(normalizarBusqueda(largo)).toBe("a".repeat(80));
  });

  it("con un array toma el primer valor", () => {
    expect(normalizarBusqueda(["juan", "pedro"])).toBe("juan");
  });

  it("vacío, sólo espacios o sin valor da undefined", () => {
    expect(normalizarBusqueda("")).toBeUndefined();
    expect(normalizarBusqueda("   ")).toBeUndefined();
    expect(normalizarBusqueda(undefined)).toBeUndefined();
  });

  it("menos de tres caracteres da undefined — pg_trgm no tiene grupo que buscar", () => {
    expect(normalizarBusqueda("a")).toBeUndefined();
    expect(normalizarBusqueda("ab")).toBeUndefined();
    expect(normalizarBusqueda("  ab  ")).toBeUndefined();
  });

  it("tres caracteres ya pasa", () => {
    expect(normalizarBusqueda("abc")).toBe("abc");
  });
});
