/**
 * `crearInquilino` con una base por cliente: corre en control (`enControl`) y la
 * misma sentencia mira los topes de bases y de MB antes de llamar a la función.
 *
 * No hay Postgres acá: se comprueba que la sentencia que sale tiene la forma que
 * el contrato pide (cada tope cierra el alta sin llegar a `claimmix_crear_inquilino`,
 * que sólo vive en el `else`), con qué parámetros, y que el resultado se lee como siempre.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ enControl: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => ({ enControl: h.enControl }));

import { crearInquilino } from "@/server/alta/crear-inquilino";

const USUARIO = "11111111-1111-4111-8111-111111111111";
const DATOS = { userId: USUARIO, empresa: "Seguros del Sur", numero: "+5492916426930", ip: "203.0.113.7" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const respuesta = (r: Record<string, unknown>) => [{ r }];

function conRespuesta(r: Record<string, unknown>) {
  h.enControl.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => unknown) =>
    armar({ execute: async () => respuesta(r) })
  );
}

/** El contexto y la sentencia ya armada, con el texto y los parámetros que llegarían a Postgres. */
async function llamadaALaBase() {
  const [contexto, armar] = h.enControl.mock.calls[0];
  let consulta: Parameters<PgDialect["sqlToQuery"]>[0] | undefined;
  await armar({
    execute: (q: typeof consulta) => {
      consulta = q;
      return [];
    },
  });
  const { sql, params } = new PgDialect().sqlToQuery(consulta!);
  return { contexto, sql: sql.replace(/\s+/g, " ").trim(), params };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ALTA_TOPE_BASES;
  delete process.env.ALTA_TOPE_MB;
  delete process.env.ALTA_TOPE_GLOBAL_DIA;
  delete process.env.ALTA_PRUEBA_DIAS;
  conRespuesta({ resultado: "ok", creadas_24h: 3, tope: 20 });
});

describe("dónde y con qué contexto corre", () => {
  it("va por `enControl`, con el id nuevo como contexto y como primer argumento de la función", async () => {
    await crearInquilino(DATOS);

    expect(h.enControl).toHaveBeenCalledTimes(1);
    const { contexto, params } = await llamadaALaBase();
    expect(contexto.tenantId).toMatch(UUID);
    expect(contexto.tenantId).not.toBe(USUARIO);
    expect(params[4]).toBe(contexto.tenantId);
  });

  it("cada alta inventa su propio id", async () => {
    await crearInquilino(DATOS);
    await crearInquilino(DATOS);

    expect(h.enControl.mock.calls[0][0].tenantId).not.toBe(h.enControl.mock.calls[1][0].tenantId);
  });

  it("el resultado lleva el id del espacio, para que quien sigue sepa qué base preparar", async () => {
    const alta = await crearInquilino(DATOS);

    expect(alta.tenantId).toBe(h.enControl.mock.calls[0][0].tenantId);
  });
});

describe("la sentencia", () => {
  it("cierra por bases, cierra por MB y sólo después llama a la función, en ese orden", async () => {
    await crearInquilino(DATOS);

    const { sql } = await llamadaALaBase();
    expect(sql).toContain(
      "select case " +
        "when $1::int > 0 and (select count(*) from pg_database where datname ~ '^t_[0-9a-f]{32}$') >= $2::int " +
        "then jsonb_build_object('resultado', 'alta_cerrada') " +
        "when $3::int > 0 and (select sum(pg_database_size(oid)) from pg_database " +
        "where not datistemplate and has_database_privilege(oid, 'CONNECT')) / 1048576 >= $4::int " +
        "then jsonb_build_object('resultado', 'alta_cerrada') " +
        "else public.claimmix_crear_inquilino("
    );
    expect(sql.endsWith("end as r")).toBe(true);
  });

  it("la función aparece una sola vez, en el `else`: un tope pasado no la alcanza", async () => {
    await crearInquilino(DATOS);

    const { sql } = await llamadaALaBase();
    expect(sql.match(/claimmix_crear_inquilino/g)).toHaveLength(1);
    expect(sql.indexOf("claimmix_crear_inquilino")).toBeGreaterThan(sql.indexOf("else"));
    expect(sql.match(/jsonb_build_object\('resultado', 'alta_cerrada'\)/g)).toHaveLength(2);
  });

  it("con los topes en 0 (por omisión) no cuentan: llegan 0 y la función recibe lo de siempre", async () => {
    await crearInquilino(DATOS);

    const { contexto, params } = await llamadaALaBase();
    expect(params.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(params.slice(4)).toEqual([contexto.tenantId, USUARIO, "Seguros del Sur", "+5492916426930", 30, 20, "203.0.113.7"]);
  });

  it("ALTA_TOPE_BASES y ALTA_TOPE_MB llegan a cada comparación", async () => {
    process.env.ALTA_TOPE_BASES = "40";
    process.env.ALTA_TOPE_MB = "450";
    await crearInquilino(DATOS);

    const { params } = await llamadaALaBase();
    expect(params.slice(0, 4)).toEqual([40, 40, 450, 450]);
  });

  it.each(["", "abc", "-1", "501", "1.5", "4 0"])("el valor %j no abre un tope: queda en 0", async (valor) => {
    process.env.ALTA_TOPE_BASES = valor;
    process.env.ALTA_TOPE_MB = valor;
    await crearInquilino(DATOS);

    const { params } = await llamadaALaBase();
    expect(params.slice(0, 4)).toEqual([0, 0, 0, 0]);
  });

  it("el tope global y los días de prueba siguen saliendo del entorno", async () => {
    process.env.ALTA_TOPE_GLOBAL_DIA = "7";
    process.env.ALTA_PRUEBA_DIAS = "14";
    await crearInquilino(DATOS);

    const { params } = await llamadaALaBase();
    expect(params.slice(8, 10)).toEqual([14, 7]);
  });
});

describe("el resultado", () => {
  it("con los topes en 0 es el de siempre", async () => {
    expect(await crearInquilino(DATOS)).toEqual({
      resultado: "ok",
      tenantId: h.enControl.mock.calls[0][0].tenantId,
      creadas24h: 3,
      tope: 20,
    });
  });

  it("un tope pasado devuelve `alta_cerrada` sin contadores, como lo lee la acción", async () => {
    conRespuesta({ resultado: "alta_cerrada" });

    expect(await crearInquilino(DATOS)).toMatchObject({ resultado: "alta_cerrada", creadas24h: null, tope: null });
  });

  it("el jsonb puede llegar como texto", async () => {
    h.enControl.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => unknown) =>
      armar({ execute: async () => ({ rows: [{ r: JSON.stringify({ resultado: "ok_numero_en_revision" }) }] }) })
    );

    expect(await crearInquilino(DATOS)).toMatchObject({ resultado: "ok_numero_en_revision" });
  });

  it("un resultado que no se conoce tira, no cierra en silencio", async () => {
    conRespuesta({ resultado: "otra_cosa" });

    await expect(crearInquilino(DATOS)).rejects.toThrow(/no se reconoce/);
  });

  it.each(["42883", "42P01", "42703", "23505"])("el código %s cierra el alta y conserva el id", async (code) => {
    h.enControl.mockRejectedValue(Object.assign(new Error("fallo de la base"), { code }));

    expect(await crearInquilino(DATOS)).toEqual({
      resultado: "alta_cerrada",
      tenantId: expect.stringMatching(UUID),
      creadas24h: null,
      tope: null,
    });
  });

  it("cualquier otra falla de la base sube", async () => {
    h.enControl.mockRejectedValue(Object.assign(new Error("sin red"), { code: "08006" }));

    await expect(crearInquilino(DATOS)).rejects.toThrow("sin red");
  });
});
