/**
 * El runner de migraciones no cuelga la aplicación esperando un lock.
 *
 * Un `ALTER TABLE` pide ACCESS EXCLUSIVE; si una transacción larga tiene la
 * tabla, el pedido se encola y todo lo que llega detrás —lecturas incluidas—
 * se encola con él. Cada migración arranca entonces con un `lock_timeout` de
 * 5 s, por TCP y por HTTP, y un 55P03 sale con un mensaje que dice que es
 * pasajero.
 *
 * Los clientes de `pg` y de Neon son falsos: nada toca una base.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = vi.hoisted(() => ({
  conexion: null as unknown,
  consultas: [] as string[],
  falla: null as null | ((texto: string) => unknown),
  transacciones: [] as Array<Array<{ text: string; params?: unknown[] }>>,
  fallaHttp: null as unknown,
}));

vi.mock("pg", () => ({
  default: {
    Client: class {
      async connect() {
        if (estado.conexion) throw estado.conexion;
      }
      async query(texto: string) {
        estado.consultas.push(texto);
        const e = estado.falla?.(texto);
        if (e) throw e;
        return { rows: [] };
      }
      async end() {}
    },
  },
}));

vi.mock("@neondatabase/serverless", () => ({
  neon: () => ({
    query: (text: string, params?: unknown[]) => ({ text, params }),
    transaction: async (lista: Array<{ text: string; params?: unknown[] }>) => {
      estado.transacciones.push(lista);
      if (estado.fallaHttp) throw estado.fallaHttp;
      return [];
    },
  }),
}));

import { LEDGER_INSERT, LOCK_TIMEOUT, connect } from "../../scripts/lib/db-driver.mjs";

const MIGRACION = {
  version: "0001",
  filename: "0001_prueba.sql",
  sql: "alter table casos add column nota text;",
  checksum: "abc",
};

function errorDePostgres(code: string) {
  return Object.assign(new Error("canceling statement due to lock timeout"), { code });
}

beforeEach(() => {
  estado.conexion = null;
  estado.consultas = [];
  estado.falla = null;
  estado.transacciones = [];
  estado.fallaHttp = null;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("driver TCP", () => {
  it("el lock_timeout es lo primero dentro de la transacción", async () => {
    const c = await connect("postgres://falsa");
    expect(c.kind).toBe("tcp");

    await c.applyMigration(MIGRACION, "prueba");

    expect(estado.consultas).toEqual([
      "begin",
      "set local lock_timeout = '5s'",
      MIGRACION.sql,
      LEDGER_INSERT,
      "commit",
    ]);
    expect(LOCK_TIMEOUT).toBe("set local lock_timeout = '5s'");
  });

  it("un 55P03 revierte y sale con un mensaje de que se puede reintentar", async () => {
    const original = errorDePostgres("55P03");
    estado.falla = (texto) => (texto === MIGRACION.sql ? original : null);
    const c = await connect("postgres://falsa");

    const e = await c.applyMigration(MIGRACION, "prueba").catch((x: unknown) => x);

    expect(estado.consultas.at(-1)).toBe("rollback");
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/5 s/);
    expect((e as Error).message).toMatch(/volvé a correr/);
    expect((e as Error & { reintentable?: boolean }).reintentable).toBe(true);
    expect((e as Error).cause).toBe(original);
  });

  it("cualquier otro error se propaga como vino, tras revertir", async () => {
    const original = errorDePostgres("42P01");
    estado.falla = (texto) => (texto === MIGRACION.sql ? original : null);
    const c = await connect("postgres://falsa");

    const e = await c.applyMigration(MIGRACION, "prueba").catch((x: unknown) => x);

    expect(e).toBe(original);
    expect(estado.consultas.at(-1)).toBe("rollback");
  });
});

describe("driver HTTP", () => {
  async function porHttp() {
    estado.conexion = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const c = await connect("postgres://falsa");
    expect(c.kind).toBe("http");
    return c;
  }

  it("el lock_timeout es la primera sentencia de la transacción", async () => {
    const c = await porHttp();

    await c.applyMigration(MIGRACION, "prueba");

    expect(estado.transacciones).toHaveLength(1);
    expect(estado.transacciones[0].map((q) => q.text)).toEqual([
      "set local lock_timeout = '5s'",
      "alter table casos add column nota text",
      LEDGER_INSERT,
    ]);
  });

  it("un 55P03 sale con un mensaje de que se puede reintentar", async () => {
    estado.fallaHttp = errorDePostgres("55P03");
    const c = await porHttp();

    const e = await c.applyMigration(MIGRACION, "prueba").catch((x: unknown) => x);

    expect((e as Error).message).toMatch(/5 s/);
    expect((e as Error).message).toMatch(/volvé a correr/);
    expect((e as Error & { reintentable?: boolean }).reintentable).toBe(true);
    expect((e as Error).cause).toBe(estado.fallaHttp);
  });

  it("cualquier otro error se propaga como vino", async () => {
    estado.fallaHttp = errorDePostgres("42P01");
    const c = await porHttp();

    const e = await c.applyMigration(MIGRACION, "prueba").catch((x: unknown) => x);

    expect(e).toBe(estado.fallaHttp);
  });
});
