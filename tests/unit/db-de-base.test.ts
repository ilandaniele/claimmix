/**
 * `dbDeBase` es el rol dueño contra la base de UN inquilino (`t_<32 hex>`), para
 * el workflow que la prepara y los barridos. El nombre termina en una cadena de
 * conexión: se valida antes de armarla. Y la cache tiene tope, porque cada
 * cliente nuevo es una conexión más.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockNeon } = vi.hoisted(() => ({ mockNeon: vi.fn() }));

vi.mock("@neondatabase/serverless", () => ({ neon: mockNeon }));

let dbDeBase: typeof import("@/lib/db").dbDeBase;

const URL_CONTROL = "postgresql://dueno:test-fake-key@ep-fake-1.example.com/neondb?sslmode=require";
const hex = (n: number) => n.toString(16).padStart(32, "0");
const base = (n: number) => `t_${hex(n)}`;
const SAVED = process.env.DATABASE_URL;

beforeEach(async () => {
  // La cache es del módulo: cada prueba arranca con la suya vacía.
  vi.resetModules();
  ({ dbDeBase } = await import("@/lib/db"));
  mockNeon.mockReset();
  mockNeon.mockImplementation(() => () => undefined);
  process.env.DATABASE_URL = URL_CONTROL;
});

afterEach(() => {
  if (SAVED === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = SAVED;
});

describe("dbDeBase", () => {
  it("conecta a la misma cadena con otra base", () => {
    dbDeBase(base(1));

    expect(mockNeon).toHaveBeenCalledTimes(1);
    const url = new URL(mockNeon.mock.calls[0]![0] as string);
    expect(url.pathname).toBe(`/${base(1)}`);
    expect(url.host).toBe("ep-fake-1.example.com");
    expect(url.searchParams.get("sslmode")).toBe("require");
  });

  it.each([
    "",
    "neondb",
    "T_" + hex(1),
    "t_" + hex(1).toUpperCase().replace(/0/g, "A"),
    "t_" + hex(1).slice(1),
    "t_" + hex(1) + "0",
    `${base(1)}; drop database neondb`,
    `${base(1)}/../neondb`,
    "t_00000000-0000-0000-0000-000000000001",
  ])("no arma la cadena con %j", (nombre) => {
    expect(() => dbDeBase(nombre)).toThrow(/no es t_ y 32 hex/);
    expect(mockNeon).not.toHaveBeenCalled();
  });

  it("sin DATABASE_URL tira, como getDb", () => {
    delete process.env.DATABASE_URL;

    expect(() => dbDeBase(base(1))).toThrow("DATABASE_URL is not set");
  });

  it("la misma base devuelve el mismo cliente, y otra base otro", () => {
    const a = dbDeBase(base(2));

    expect(dbDeBase(base(2))).toBe(a);
    expect(dbDeBase(base(3))).not.toBe(a);
    expect(mockNeon).toHaveBeenCalledTimes(2);
  });

  it("si cambia DATABASE_URL no sirve el cliente de la cadena vieja", () => {
    const a = dbDeBase(base(4));
    process.env.DATABASE_URL = URL_CONTROL.replace("ep-fake-1", "ep-fake-2");

    expect(dbDeBase(base(4))).not.toBe(a);
  });

  it("guarda hasta 50 y tira el más viejo", () => {
    const primero = dbDeBase(base(100));
    for (let i = 101; i < 150; i++) dbDeBase(base(i));
    expect(dbDeBase(base(100))).toBe(primero);

    dbDeBase(base(150));

    expect(dbDeBase(base(100))).not.toBe(primero);
  });
});
