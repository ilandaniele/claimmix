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

import {
  normalizarBusqueda,
  VALID_CHANNELS,
  VALID_COMPLEJIDADES,
  VALID_SEVERITIES,
  VALID_STATUSES,
  VALID_VENCIMIENTOS,
} from "@/app/(app)/bandeja/page";

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

// G26: VALID_STATUSES/VALID_SEVERITIES/VALID_CHANNELS pasan a salir de sus
// schemas — el conjunto de valores válidos tiene que quedar igual al de la
// lista escrita a mano que reemplazan.
describe("conjuntos válidos de la bandeja", () => {
  it("VALID_STATUSES es el mismo conjunto de antes", () => {
    expect(new Set(VALID_STATUSES)).toEqual(
      new Set([
        "procesando",
        "listo",
        "esperando",
        "escalado",
        "cerrado",
        "recibido",
        "info_faltante",
        "confirmacion_pendiente",
        "requiere_especialista",
        "listo_para_core",
        "enviado_a_core",
        "error_core",
        "no_relevante",
        // B25, migración 0035
        "en_liquidacion",
        "pagado",
        "rechazado",
      ])
    );
  });

  it("VALID_SEVERITIES es el mismo conjunto de antes", () => {
    expect(new Set(VALID_SEVERITIES)).toEqual(new Set(["low", "medium", "high", "critical"]));
  });

  it("VALID_VENCIMIENTOS y VALID_COMPLEJIDADES son los del filtro (B10, B13)", () => {
    expect(new Set(VALID_VENCIMIENTOS)).toEqual(new Set(["vencidos", "por_vencer"]));
    expect(new Set(VALID_COMPLEJIDADES)).toEqual(new Set(["baja", "media", "alta"]));
  });

  it("VALID_CHANNELS es el de antes más el formulario web (B17)", () => {
    expect(new Set(VALID_CHANNELS)).toEqual(
      new Set(["email_sim", "email", "whatsapp_sim", "whatsapp", "web"])
    );
  });
});
