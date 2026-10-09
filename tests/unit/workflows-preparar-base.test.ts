/**
 * El flujo que prepara la base de un inquilino, paso por paso.
 *
 * Sin el compilador de flujos, `"use step"` y `"use workflow"` son literales de
 * cadena: las funciones corren como cualquier otra, y acá se sustituyen los
 * módulos de bases. Lo que se prueba:
 *
 *   · sin lease (otro flujo la tiene, o ya está lista o borrada) no se hace nada
 *   · el orden: crear, migrar, permisos, espejo y recién ahí `lista`
 *   · un paso que falla deja la base `fallida`, con la primera línea del error
 *     (los errores de drizzle traen el cuerpo de la fila después) y sin seguir
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  tomarBase: vi.fn(),
  crearBaseSiFalta: vi.fn(),
  migrarBase: vi.fn(),
  darPermisos: vi.fn(),
  marcarBase: vi.fn(),
  espejar: vi.fn(),
}));

vi.mock("@/server/bases/crear-base", () => ({
  tomarBase: h.tomarBase,
  crearBaseSiFalta: h.crearBaseSiFalta,
  migrarBase: h.migrarBase,
  darPermisos: h.darPermisos,
  marcarBase: h.marcarBase,
}));
vi.mock("@/server/bases/espejo", () => ({ espejar: h.espejar }));

import { prepararBase } from "@/workflows/preparar-base";

const TENANT = "aaaaaaaa-0000-4000-8000-00000000000a";
const BASE = "t_aaaaaaaa00004000800000000000000a";

/** Los pasos que llegaron a correr, en orden. */
const orden: string[] = [];

function registrar(nombre: string, mock: ReturnType<typeof vi.fn>, valor?: unknown) {
  mock.mockImplementation(async () => {
    orden.push(nombre);
    return valor;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  orden.length = 0;
  registrar("tomar", h.tomarBase, { intentos: 1 });
  registrar("crear", h.crearBaseSiFalta, "creada");
  registrar("migrar", h.migrarBase, 50);
  registrar("permisos", h.darPermisos);
  registrar("espejar", h.espejar);
  registrar("marcar", h.marcarBase);
});

describe("tomar la base", () => {
  it("pide el lease de 15 minutos de ese inquilino", async () => {
    await prepararBase(TENANT);

    expect(h.tomarBase).toHaveBeenCalledWith(TENANT, 15);
  });

  it("sin lease termina sin crear, migrar, espejar ni marcar nada", async () => {
    h.tomarBase.mockResolvedValue(null);

    await prepararBase(TENANT);

    expect(h.crearBaseSiFalta).not.toHaveBeenCalled();
    expect(h.migrarBase).not.toHaveBeenCalled();
    expect(h.darPermisos).not.toHaveBeenCalled();
    expect(h.espejar).not.toHaveBeenCalled();
    expect(h.marcarBase).not.toHaveBeenCalled();
  });
});

describe("cuando todo sale bien", () => {
  it("crea, migra, da permisos, espeja y deja la base lista, en ese orden", async () => {
    await prepararBase(TENANT);

    expect(orden).toEqual(["tomar", "crear", "migrar", "permisos", "espejar", "marcar"]);
  });

  it("los pasos de la base reciben el nombre t_<hex> del inquilino, y el espejo su id", async () => {
    await prepararBase(TENANT);

    expect(h.crearBaseSiFalta).toHaveBeenCalledWith(BASE);
    expect(h.migrarBase).toHaveBeenCalledWith(BASE);
    expect(h.darPermisos).toHaveBeenCalledWith(BASE);
    expect(h.espejar).toHaveBeenCalledWith(TENANT);
  });

  it("marca `lista` con la versión a la que migró, y nunca `fallida`", async () => {
    await prepararBase(TENANT);

    expect(h.marcarBase).toHaveBeenCalledTimes(1);
    expect(h.marcarBase).toHaveBeenCalledWith(TENANT, "lista", { version: 50 });
  });
});

describe("cuando un paso agota sus reintentos", () => {
  it("migrar: deja la base `fallida` con el error, y no sigue", async () => {
    h.migrarBase.mockRejectedValue(new Error("syntax error at or near \"CREAT\""));

    await prepararBase(TENANT);

    expect(h.darPermisos).not.toHaveBeenCalled();
    expect(h.espejar).not.toHaveBeenCalled();
    expect(h.marcarBase).toHaveBeenCalledTimes(1);
    expect(h.marcarBase).toHaveBeenCalledWith(TENANT, "fallida", { error: 'syntax error at or near "CREAT"' });
  });

  it.each([
    ["crear", () => h.crearBaseSiFalta, ["tomar"]],
    ["permisos", () => h.darPermisos, ["tomar", "crear", "migrar"]],
    ["espejar", () => h.espejar, ["tomar", "crear", "migrar", "permisos"]],
  ])("%s: `fallida`, nunca `lista`", async (_paso, mock, previos) => {
    mock().mockRejectedValue(new Error("se cayó"));

    await prepararBase(TENANT);

    // Lo que corrió antes de la falla, y al final el cierre en `fallida`.
    expect(orden).toEqual([...previos, "marcar"]);
    expect(h.marcarBase).toHaveBeenCalledTimes(1);
    expect(h.marcarBase).toHaveBeenCalledWith(TENANT, "fallida", { error: "se cayó" });
  });

  it("anota sólo la primera línea del error y la acota: el resto puede traer filas", async () => {
    h.espejar.mockRejectedValue(new Error(`Failed query: insert into x\nparams: ana@example.com,${"x".repeat(50)}`));

    await prepararBase(TENANT);

    expect(h.marcarBase).toHaveBeenCalledWith(TENANT, "fallida", { error: "Failed query: insert into x" });

    h.marcarBase.mockClear();
    h.espejar.mockRejectedValue(new Error("a".repeat(900)));

    await prepararBase(TENANT);

    const { error } = h.marcarBase.mock.calls[0][2];
    expect(error).toHaveLength(200);
  });

  it("un valor que no es un Error también queda anotado", async () => {
    h.darPermisos.mockRejectedValue("sin permisos");

    await prepararBase(TENANT);

    expect(h.marcarBase).toHaveBeenCalledWith(TENANT, "fallida", { error: "sin permisos" });
  });
});
