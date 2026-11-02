/**
 * `casoQueRetiene`: el borrado de una persona espera a que no le quede nada atado a
 * los casos. Con un caso asignado, el SET NULL de `assigned_to` reiniciaría sus
 * relojes; con una fila de auditoría de caso que ella firmó, el SET NULL de
 * `actor_id` la haría pasar por trabajo del agente (toma de «Tomar el control»,
 * ancla de derivaciones y desvíos, «llegó a listo solo»).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enTenant: vi.fn(),
  filas: [] as Record<string, unknown>[],
  consultas: [] as { sql: string; params: unknown[] }[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => ({ enTenant: h.enTenant }));

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { casoQueRetiene } from "@/server/cases/asignados-a";

const ESPACIO = "aaaaaaaa-0000-4000-8000-00000000000a";
const PERSONA = "dddddddd-0000-4000-8000-00000000000d";

const dialecto = new PgDialect();

/** Lo que contesta la base. */
const responde = (asignados: boolean, firmo: boolean) => {
  h.filas = [{ asignados, firmo }];
};

beforeEach(() => {
  h.filas = [];
  h.consultas.length = 0;
  h.enTenant.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => Promise<unknown>) => {
    const db = {
      execute: async (q: SQL) => {
        const { sql, params } = dialecto.sqlToQuery(q);
        h.consultas.push({ sql, params });
        return { rows: h.filas };
      },
    };
    return armar(db);
  });
});

describe("casoQueRetiene", () => {
  it("con un caso asignado dice «asignados»", async () => {
    responde(true, false);

    expect(await casoQueRetiene(ESPACIO, PERSONA)).toBe("asignados");
  });

  it("sin casos asignados pero con algo firmado en un caso dice «firmo»", async () => {
    responde(false, true);

    expect(await casoQueRetiene(ESPACIO, PERSONA)).toBe("firmo");
  });

  it("con las dos cosas gana «asignados»: es lo que se puede arreglar antes", async () => {
    responde(true, true);

    expect(await casoQueRetiene(ESPACIO, PERSONA)).toBe("asignados");
  });

  it("sin nada atado es null", async () => {
    responde(false, false);

    expect(await casoQueRetiene(ESPACIO, PERSONA)).toBeNull();
  });

  it("una respuesta vacía no frena a nadie: null", async () => {
    expect(await casoQueRetiene(ESPACIO, PERSONA)).toBeNull();
  });

  it("corre con el espacio como contexto y manda una sola consulta con las dos preguntas", async () => {
    responde(false, false);

    await casoQueRetiene(ESPACIO, PERSONA);

    expect(h.enTenant).toHaveBeenCalledOnce();
    expect(h.enTenant.mock.calls[0][0]).toEqual({ tenantId: ESPACIO });
    expect(h.consultas).toHaveLength(1);
    const { sql, params } = h.consultas[0];
    expect(sql).toMatch(/from cases where assigned_to = \$1::uuid/);
    expect(sql).not.toContain("status");
    expect(params[0]).toBe(PERSONA);
  });

  it("lo firmado se busca por actor en cualquier evento de caso, sin lista de eventos que se quede atrás", async () => {
    responde(false, false);

    await casoQueRetiene(ESPACIO, PERSONA);

    const { sql, params } = h.consultas[0];
    expect(sql).toMatch(/from audit_log where actor_id = \$2::uuid and target_type = 'case'/);
    expect(sql).not.toContain("event_type");
    expect(params[1]).toBe(PERSONA);
  });
});
