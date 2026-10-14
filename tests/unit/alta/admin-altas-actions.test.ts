/**
 * La acción `despublicarLegales` de /admin/altas (R3): el operador baja las páginas legales
 * públicas de un cliente de la app propia.
 *
 * Lo que se prueba es la puerta y el resultado, no la sentencia (de eso se ocupa
 * `panel-operador.test.ts`):
 *   - sin sesión va a /login y sin ser operador a /bandeja, sin llegar a la base;
 *   - quién baja sale de la sesión y de los headers, nunca del formulario;
 *   - pide un uuid y la casilla de confirmación, o no hace nada;
 *   - el resultado vuelve en `?r=` (de la lista cerrada), un fallo es `falla` sin el mensaje del error,
 *     y el `redirect` va afuera de todo try/catch.
 */

import { isIP } from "node:net";

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireOperator: vi.fn(),
  despublicar: vi.fn(),
  cabeceras: vi.fn(),
  error: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => h.cabeceras() }));

/** `redirect` tira, igual que en Next: se atrapa el destino. */
class RedirigioA extends Error {
  constructor(public readonly destino: string) {
    super(`NEXT_REDIRECT:${destino}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new RedirigioA(destino);
  },
}));
vi.mock("@/lib/audit/log", () => ({ ipValida: (ip?: string | null) => (ip && isIP(ip) !== 0 ? ip : null) }));
vi.mock("@/lib/auth/require-operator", () => ({ requireOperator: h.requireOperator }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: h.error },
}));
vi.mock("@/server/alta/panel-operador", () => ({
  activarInquilino: vi.fn(),
  conectarNumero: vi.fn(),
  darDeBajaNumero: vi.fn(),
  desvincularWaba: vi.fn(),
  despublicarLegales: h.despublicar,
  extenderPrueba: vi.fn(),
  reactivarInquilino: vi.fn(),
  reactivarNumero: vi.fn(),
  reintentarWaba: vi.fn(),
  suspenderInquilino: vi.fn(),
  suspenderNumero: vi.fn(),
  terminosDeActivacion: vi.fn(),
}));

import { despublicarLegales } from "@/app/(app)/admin/altas/actions";
import { AppError } from "@/lib/errors";

const OPERADOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLIENTE = "22222222-2222-4222-8222-222222222222";

function formulario(campos: Record<string, string> = { tenant_id: CLIENTE, confirmo: "on" }): FormData {
  const form = new FormData();
  for (const [campo, valor] of Object.entries(campos)) form.set(campo, valor);
  return form;
}

/** A dónde mandó la acción: termina siempre en un `redirect`. */
async function destinoDe(form = formulario()): Promise<string> {
  try {
    await despublicarLegales(form);
  } catch (e) {
    if (e instanceof RedirigioA) return e.destino;
    throw e;
  }
  throw new Error("la acción no redirigió");
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireOperator.mockResolvedValue({ userRow: { id: OPERADOR } });
  h.cabeceras.mockReturnValue(new Headers({ "x-forwarded-for": "203.0.113.7" }));
  h.despublicar.mockResolvedValue("ok");
});

describe("despublicarLegales (la acción): la puerta", () => {
  it("sin sesión va a /login y no llega a la base", async () => {
    h.requireOperator.mockRejectedValue(new AppError("MISSING_SESSION"));

    expect(await destinoDe()).toBe("/login");
    expect(h.despublicar).not.toHaveBeenCalled();
  });

  it("sin ser operador va a /bandeja y no llega a la base", async () => {
    h.requireOperator.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));

    expect(await destinoDe()).toBe("/bandeja");
    expect(h.despublicar).not.toHaveBeenCalled();
  });

  it("un fallo cualquiera al pedir la sesión va a /bandeja", async () => {
    h.requireOperator.mockRejectedValue(new Error("la base no contesta"));

    expect(await destinoDe()).toBe("/bandeja");
    expect(h.despublicar).not.toHaveBeenCalled();
  });
});

describe("despublicarLegales (la acción): el pedido", () => {
  it("baja las páginas del espacio del formulario y vuelve a la pantalla con el resultado", async () => {
    expect(await destinoDe()).toBe("/admin/altas?r=legales_despublicadas");

    expect(h.despublicar).toHaveBeenCalledTimes(1);
    expect(h.despublicar).toHaveBeenCalledWith(CLIENTE, { userId: OPERADOR, ip: "203.0.113.7" });
  });

  it("quién baja sale de la sesión: un user_id o una IP del formulario no cuentan", async () => {
    await destinoDe(formulario({ tenant_id: CLIENTE, confirmo: "on", user_id: "otro", ip: "198.51.100.1" }));

    expect(h.despublicar).toHaveBeenCalledWith(CLIENTE, { userId: OPERADOR, ip: "203.0.113.7" });
  });

  it.each(["", "no-es-un-uuid", "22222222-2222-4222-8222-22222222222", "'; drop table tenants; --"])(
    "un tenant_id sin forma de uuid (%j) es datos_invalidos y no llega a la base",
    async (tenant_id) => {
      expect(await destinoDe(formulario({ tenant_id, confirmo: "on" }))).toBe("/admin/altas?r=datos_invalidos");
      expect(h.despublicar).not.toHaveBeenCalled();
    }
  );

  it("sin tenant_id en el formulario es datos_invalidos", async () => {
    expect(await destinoDe(formulario({ confirmo: "on" }))).toBe("/admin/altas?r=datos_invalidos");
    expect(h.despublicar).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([{}, { confirmo: "" }, { confirmo: "off" }, { confirmo: "true" }])(
    "sin la casilla de confirmación tildada (%j) es no_confirmado y no baja nada",
    async (extra) => {
      expect(await destinoDe(formulario({ tenant_id: CLIENTE, ...extra }))).toBe("/admin/altas?r=no_confirmado");
      expect(h.despublicar).not.toHaveBeenCalled();
    }
  );

  it.each(["no_aplica", "migracion_pendiente"])("el resultado «%s» de la base vuelve tal cual", async (resultado) => {
    h.despublicar.mockResolvedValue(resultado);

    expect(await destinoDe()).toBe(`/admin/altas?r=${resultado}`);
  });
});

describe("despublicarLegales (la acción): cuando algo sale mal", () => {
  it("si la base tira, vuelve con ?r=falla y anota sólo el nombre del error", async () => {
    h.despublicar.mockRejectedValue(new TypeError("conexión fake-database-url rechazada"));

    expect(await destinoDe()).toBe("/admin/altas?r=falla");
    expect(h.error).toHaveBeenCalledTimes(1);
    expect(h.error).toHaveBeenCalledWith({ error: "TypeError" }, "altas.accion_fallo");
  });

  it("un valor que no es un Error se anota como UnknownError", async () => {
    h.despublicar.mockRejectedValue("fake-texto-suelto");

    expect(await destinoDe()).toBe("/admin/altas?r=falla");
    expect(h.error).toHaveBeenCalledWith({ error: "UnknownError" }, "altas.accion_fallo");
  });

  it("el redirect va afuera del try: un resultado normal no se anota como fallo", async () => {
    await expect(despublicarLegales(formulario())).rejects.toBeInstanceOf(RedirigioA);

    expect(h.error).not.toHaveBeenCalled();
  });
});
