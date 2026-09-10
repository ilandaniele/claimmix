/**
 * Borrado múltiple: que no cruce inquilinos, y que diga la verdad.
 *
 * Es la frontera de aislamiento (AC10) y no tenía ninguna cobertura: el único
 * DELETE en tests/ era el de un mail que ya no está. Y el borrado pasó de cien
 * pedidos a uno, así que el aislamiento que antes daba el chequeo previo de cada
 * request ahora lo da la base con el contexto del lote — que es más fuerte, pero
 * hay que comprobarlo.
 */

const { mockEnTenant } = vi.hoisted(() => ({ mockEnTenant: vi.fn() }));

vi.mock("@/data/scope", () => ({
  enTenant: mockEnTenant,
}));

vi.mock("@/lib/db/schema", () => ({
  cases: { id: "cases.id", assigned_to: "cases.assigned_to" },
}));

import { describe, it, expect, vi, beforeEach } from "vitest";
import { deleteCases } from "@/server/cases/delete";

const TENANT_A = { tenantId: "aaaaaaaa-0000-0000-0000-00000000000a" };
const ADMIN = { id: "user-admin", role: "admin" as const };
const ANALISTA = { id: "user-analista", role: "analyst" as const };

/** Lo último que recibió `.where()`, para mirar qué condición se armó. */
let ultimoWhere: unknown;

/** ¿La condición nombra esta columna? Los chunks son la propia columna. */
function nombra(cond: unknown, columna: string): boolean {
  return JSON.stringify(cond, (_k, v) => (typeof v === "function" ? undefined : v))
    .includes(columna);
}

/**
 * Una base que sólo devuelve las filas del inquilino del contexto, que es lo
 * que hace RLS de verdad. El armador se ejecuta para comprobar que la consulta
 * se arma, pero lo que se filtra lo decide esta simulación.
 */
function baseCon(delInquilino: string[]) {
  mockEnTenant.mockImplementation(async (_ctx: unknown, armar: (d: unknown) => unknown) => {
    const chain = {
      delete: () => chain,
      where: (cond: unknown) => {
        ultimoWhere = cond;
        return chain;
      },
      returning: () => delInquilino.map((id) => ({ id })),
    };
    return armar(chain as never);
  });
}

beforeEach(() => vi.clearAllMocks());

describe("deleteCases", () => {
  it("devuelve los ids que borró", async () => {
    baseCon(["c-1", "c-2"]);
    await expect(deleteCases(TENANT_A, ["c-1", "c-2"], ADMIN)).resolves.toEqual(["c-1", "c-2"]);
  });

  it("un id de otra aseguradora no se borra ni se reporta", async () => {
    // La base devuelve sólo el propio: el ajeno no coincide con ninguna fila
    // porque el contexto del lote lo excluye.
    baseCon(["mio-1"]);

    const borrados = await deleteCases(TENANT_A, ["mio-1", "de-otro-inquilino"], ADMIN);

    expect(borrados).toEqual(["mio-1"]);
    expect(borrados).not.toContain("de-otro-inquilino");
  });

  it("una lista entera de otro inquilino borra cero", async () => {
    baseCon([]);
    await expect(deleteCases(TENANT_A, ["ajeno-1", "ajeno-2"], ADMIN)).resolves.toEqual([]);
  });

  it("con la lista vacía no toca la base", async () => {
    // Sin esto, `inArray(id, [])` genera SQL que borra según el motor. No es un
    // caso hipotético: el cliente manda lo que haya seleccionado.
    baseCon(["no-deberia-verse"]);
    await expect(deleteCases(TENANT_A, [], ADMIN)).resolves.toEqual([]);
    expect(mockEnTenant).not.toHaveBeenCalled();
  });

  it("un analista sólo borra lo que tiene asignado", async () => {
    // `patchCase` ya le contesta 404 a un analista que edita un caso ajeno. El
    // borrado —que es irreversible y cascadea a nueve tablas— no tenía nada.
    baseCon(["mio-1"]);
    await deleteCases(TENANT_A, ["mio-1"], ANALISTA);
    expect(nombra(ultimoWhere, "cases.assigned_to")).toBe(true);
  });

  it("un admin borra cualquier caso del inquilino", async () => {
    baseCon(["de-otro-analista"]);
    await deleteCases(TENANT_A, ["de-otro-analista"], ADMIN);
    expect(nombra(ultimoWhere, "cases.assigned_to")).toBe(false);
  });

  it("le pasa a la capa el inquilino del contexto", async () => {
    baseCon(["c-1"]);
    await deleteCases(TENANT_A, ["c-1"], ADMIN);
    expect(mockEnTenant.mock.calls[0][0]).toEqual(TENANT_A);
  });
});
