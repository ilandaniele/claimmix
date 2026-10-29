/**
 * Qué de los primeros pasos está hecho (`pasosHechos`) y adónde sigue quien termina
 * de esperar su base (`destinoAlTerminarLaBase`).
 *
 * La base de control se simula: se ve la consulta que se arma (una sola, con las
 * cuatro preguntas) y cómo se lee lo que vuelve. Que cada tabla se vea sólo la del
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
import { destinoAlTerminarLaBase, PRIMEROS_PASOS, pasosHechos, type PasosHechos } from "@/server/alta/pasos-hechos";

const TENANT = "11111111-1111-4111-8111-111111111111";
const NADA: PasosHechos = { whatsapp: false, gmail: false, equipo: false, formulario: false };
const TODO: PasosHechos = { whatsapp: true, gmail: true, equipo: true, formulario: true };

beforeEach(() => {
  vi.clearAllMocks();
  h.consultas.length = 0;
  h.respuesta.mockResolvedValue({ rows: [TODO] });
});

describe("pasosHechos", () => {
  it("lee las cuatro cosas en una sola consulta contra control, con el espacio como contexto", async () => {
    await pasosHechos(TENANT);

    expect(h.enControl).toHaveBeenCalledTimes(1);
    expect(h.enControl).toHaveBeenCalledWith({ tenantId: TENANT });
    expect(h.consultas).toHaveLength(1);
    const { sql, params } = new PgDialect().sqlToQuery(h.consultas[0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    expect(sql).toContain("public.whatsapp_numeros");
    expect(sql).toContain("estado = 'conectado'");
    expect(sql).toContain("public.gmail_accounts");
    expect(sql).toContain("public.users");
    expect(sql).toContain("dado_de_baja_en is null");
    expect(sql).toContain("offset 1");
    expect(sql).toContain("public.formulario_web");
    expect(sql).toContain("where activo");
    expect(params).toEqual([TENANT]);
  });

  it("hace una sola llamada a execute y de esa fila salen las cuatro", async () => {
    await pasosHechos(TENANT);

    expect(h.consultas).toHaveLength(1);
    expect(h.respuesta).toHaveBeenCalledTimes(1);
  });

  it("no lee nada que se pueda mostrar: sólo exists", async () => {
    await pasosHechos(TENANT);

    const { sql } = new PgDialect().sqlToQuery(h.consultas[0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    for (const columna of ["numero_e164", "phone_number_id", "waba_id", "token", "email", "refresh"]) expect(sql).not.toContain(columna);
    expect(sql.match(/exists \(/g)).toHaveLength(4);
  });

  it.each([
    ["whatsapp", { ...NADA, whatsapp: true }],
    ["gmail", { ...NADA, gmail: true }],
    ["equipo", { ...NADA, equipo: true }],
    ["formulario", { ...NADA, formulario: true }],
    ["todo", TODO],
    ["nada", NADA],
  ])("cada columna se lee tal cual y no se cruza (%s)", async (_cual, fila) => {
    h.respuesta.mockResolvedValue({ rows: [fila] });

    expect(await pasosHechos(TENANT)).toEqual(fila);
  });

  it("también entiende un arreglo pelado, según el driver", async () => {
    const fila = { whatsapp: true, gmail: false, equipo: false, formulario: true };
    h.respuesta.mockResolvedValue([fila]);

    expect(await pasosHechos(TENANT)).toEqual(fila);
  });

  it.each([[{ whatsapp: "t", gmail: 1, equipo: "t", formulario: 1 }], [{ whatsapp: null, gmail: undefined }], [{}]])(
    "algo que no es true cuenta como no hecho: %j",
    async (fila) => {
      h.respuesta.mockResolvedValue({ rows: [fila] });

      expect(await pasosHechos(TENANT)).toEqual(NADA);
    }
  );

  it.each([[{ rows: [] }], [[]], [null], [undefined]])("sin filas (%j) no hay nada hecho", async (respuesta) => {
    h.respuesta.mockResolvedValue(respuesta);

    expect(await pasosHechos(TENANT)).toEqual(NADA);
  });

  it("si control no contesta, no tira: los cuatro pasos quedan pendientes y se anota sólo el nombre y el código", async () => {
    h.respuesta.mockRejectedValue(Object.assign(new TypeError("fake-secreto en el mensaje"), { code: "57P01" }));

    expect(await pasosHechos(TENANT)).toEqual(NADA);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith({ error: "TypeError", codigo: "57P01" }, "alta.pasos_hechos_fallo");
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("fake-secreto");
  });

  it("si falta una tabla tampoco tira", async () => {
    h.respuesta.mockRejectedValue(Object.assign(new Error("no existe"), { code: "42P01" }));

    expect(await pasosHechos(TENANT)).toEqual(NADA);
  });

  it("un valor que no es un Error se anota como UnknownError", async () => {
    h.respuesta.mockRejectedValue("fake-texto-suelto");

    expect(await pasosHechos(TENANT)).toEqual(NADA);
    expect(h.warn).toHaveBeenCalledWith({ error: "UnknownError", codigo: undefined }, "alta.pasos_hechos_fallo");
  });
});

describe("destinoAlTerminarLaBase", () => {
  it("PRIMEROS_PASOS es /configuracion?primeros=1", () => {
    expect(PRIMEROS_PASOS).toBe("/configuracion?primeros=1");
  });

  it("con el WhatsApp y Gmail hechos, a la bandeja sin aviso", () => {
    expect(destinoAlTerminarLaBase({ whatsapp: true, gmail: true }, null)).toBe("/bandeja");
  });

  // Como variable: un literal de cuatro campos sería propiedad excedente del Pick.
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])("el equipo (%s) y el formulario (%s) no cambian el destino", (equipo, formulario) => {
    const listo: PasosHechos = { whatsapp: true, gmail: true, equipo, formulario };
    const sinGmail: PasosHechos = { whatsapp: true, gmail: false, equipo, formulario };

    expect(destinoAlTerminarLaBase(listo, null)).toBe("/bandeja");
    expect(destinoAlTerminarLaBase(sinGmail, null)).toBe(PRIMEROS_PASOS);
    expect(destinoAlTerminarLaBase(sinGmail, "conectado")).toBe(`${PRIMEROS_PASOS}&wa=conectado`);
  });

  it.each([
    [{ whatsapp: true, gmail: false }],
    [{ whatsapp: false, gmail: true }],
    [{ whatsapp: false, gmail: false }],
  ])("con %j todavía falta algo: a los primeros pasos", (pasos) => {
    expect(destinoAlTerminarLaBase(pasos, null)).toBe(PRIMEROS_PASOS);
  });

  it.each(RESULTADOS_DEL_NUMERO)("lo que dijo el número (%s) viaja a los primeros pasos", (wa) => {
    expect(destinoAlTerminarLaBase({ whatsapp: false, gmail: false }, wa)).toBe(`${PRIMEROS_PASOS}&wa=${wa}`);
  });

  it("con todo hecho a la bandeja no se arrastra el resultado del número", () => {
    expect(destinoAlTerminarLaBase({ whatsapp: true, gmail: true }, "conectado")).toBe("/bandeja");
  });
});
