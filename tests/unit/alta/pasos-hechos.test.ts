/**
 * Qué de los primeros pasos está hecho (`pasosHechos`) y adónde sigue quien termina
 * de esperar su base (`destinoAlTerminarLaBase`).
 *
 * La base de control se simula: se ve la consulta que se arma (una sola, con las
 * dos preguntas) y cómo se lee lo que vuelve. Que cada tabla se vea sólo la del
 * propio espacio lo prueba `pnpm tenancy` contra una base de verdad.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enControl: vi.fn(),
  respuesta: vi.fn(),
  consultas: [] as unknown[],
  warn: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => ({
  enControl: async (ctx: unknown, armar: (db: unknown) => unknown) => {
    h.enControl(ctx);
    return armar({
      execute: (consulta: unknown) => {
        h.consultas.push(consulta);
        return h.respuesta();
      },
    });
  },
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() },
}));

import { RESULTADOS_DEL_NUMERO } from "@/server/alta/numero-resultados";
import { destinoAlTerminarLaBase, pasosHechos } from "@/server/alta/pasos-hechos";

const TENANT = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  h.consultas.length = 0;
  h.respuesta.mockResolvedValue({ rows: [{ whatsapp: true, gmail: true }] });
});

describe("pasosHechos", () => {
  it("lee las dos cosas en una sola consulta contra control, con el espacio como contexto", async () => {
    await pasosHechos(TENANT);

    expect(h.enControl).toHaveBeenCalledTimes(1);
    expect(h.enControl).toHaveBeenCalledWith({ tenantId: TENANT });
    expect(h.consultas).toHaveLength(1);
    const { sql, params } = new PgDialect().sqlToQuery(h.consultas[0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql).toContain("public.whatsapp_numeros");
    expect(sql).toContain("estado = 'conectado'");
    expect(sql).toContain("public.gmail_accounts");
    expect(params).toEqual([]);
  });

  it("no lee nada que se pueda mostrar: sólo dos exists", async () => {
    await pasosHechos(TENANT);

    const { sql } = new PgDialect().sqlToQuery(h.consultas[0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    for (const columna of ["numero_e164", "phone_number_id", "waba_id", "token", "email", "refresh"]) expect(sql).not.toContain(columna);
    expect(sql.match(/exists \(/g)).toHaveLength(2);
  });

  it.each([
    [{ whatsapp: true, gmail: true }, { whatsapp: true, gmail: true }],
    [{ whatsapp: true, gmail: false }, { whatsapp: true, gmail: false }],
    [{ whatsapp: false, gmail: true }, { whatsapp: false, gmail: true }],
    [{ whatsapp: false, gmail: false }, { whatsapp: false, gmail: false }],
  ])("%j se lee tal cual", async (fila, esperado) => {
    h.respuesta.mockResolvedValue({ rows: [fila] });

    expect(await pasosHechos(TENANT)).toEqual(esperado);
  });

  it("también entiende un arreglo pelado, según el driver", async () => {
    h.respuesta.mockResolvedValue([{ whatsapp: true, gmail: false }]);

    expect(await pasosHechos(TENANT)).toEqual({ whatsapp: true, gmail: false });
  });

  it.each([[{ whatsapp: "t", gmail: 1 }], [{ whatsapp: null, gmail: undefined }], [{}]])(
    "algo que no es true cuenta como no hecho: %j",
    async (fila) => {
      h.respuesta.mockResolvedValue({ rows: [fila] });

      expect(await pasosHechos(TENANT)).toEqual({ whatsapp: false, gmail: false });
    }
  );

  it.each([[{ rows: [] }], [[]], [null], [undefined]])("sin filas (%j) no hay nada hecho", async (respuesta) => {
    h.respuesta.mockResolvedValue(respuesta);

    expect(await pasosHechos(TENANT)).toEqual({ whatsapp: false, gmail: false });
  });

  it("si control no contesta, no tira: los dos pasos quedan pendientes y se anota sólo el nombre y el código", async () => {
    h.respuesta.mockRejectedValue(Object.assign(new TypeError("fake-secreto en el mensaje"), { code: "57P01" }));

    expect(await pasosHechos(TENANT)).toEqual({ whatsapp: false, gmail: false });
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith({ error: "TypeError", codigo: "57P01" }, "alta.pasos_hechos_fallo");
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("fake-secreto");
  });

  it("si falta una tabla tampoco tira", async () => {
    h.respuesta.mockRejectedValue(Object.assign(new Error("no existe"), { code: "42P01" }));

    expect(await pasosHechos(TENANT)).toEqual({ whatsapp: false, gmail: false });
  });

  it("un valor que no es un Error se anota como UnknownError", async () => {
    h.respuesta.mockRejectedValue("fake-texto-suelto");

    expect(await pasosHechos(TENANT)).toEqual({ whatsapp: false, gmail: false });
    expect(h.warn).toHaveBeenCalledWith({ error: "UnknownError", codigo: undefined }, "alta.pasos_hechos_fallo");
  });
});

describe("destinoAlTerminarLaBase", () => {
  it("con el WhatsApp y Gmail hechos, a la bandeja de bienvenida", () => {
    expect(destinoAlTerminarLaBase({ whatsapp: true, gmail: true }, null)).toBe("/bandeja?bienvenida=1");
  });

  it.each([
    [{ whatsapp: true, gmail: false }],
    [{ whatsapp: false, gmail: true }],
    [{ whatsapp: false, gmail: false }],
  ])("con %j todavía falta algo: a los primeros pasos", (pasos) => {
    expect(destinoAlTerminarLaBase(pasos, null)).toBe("/configuracion?primeros=1");
  });

  it.each(RESULTADOS_DEL_NUMERO)("lo que dijo el número (%s) viaja a los primeros pasos", (wa) => {
    expect(destinoAlTerminarLaBase({ whatsapp: false, gmail: false }, wa)).toBe(`/configuracion?primeros=1&wa=${wa}`);
  });

  it("con todo hecho a la bandeja no se arrastra el resultado del número", () => {
    expect(destinoAlTerminarLaBase({ whatsapp: true, gmail: true }, "conectado")).toBe("/bandeja?bienvenida=1");
  });
});
