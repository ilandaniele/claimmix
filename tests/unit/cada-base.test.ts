/**
 * El recorrido por las bases de cliente (P10).
 *
 * Se sustituye lo que habla con Neon: `db` (el dueño contra control, de donde sale la
 * lista) y `dbDeBase`, que devuelve un objeto con el nombre de la base. Lo que se
 * prueba es lo que importa sin una base de verdad: con la bandera apagada corre una
 * vez y sin inquilino, con ella una vez por base `lista`, en serie, rotando cada
 * hora, cortando en `hasta` sin perder la cuenta y sin que una base caída frene a las
 * otras.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** La lectura a control: `db.execute`. */
  leer: vi.fn(),
  dbDeBase: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { execute: h.leer, nombre: "control" }, dbDeBase: h.dbDeBase }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() },
}));

import { db } from "@/lib/db";
import { paraCadaBase } from "@/server/bases/cada-base";

const dialecto = new PgDialect();
const SAVED = process.env.BASE_POR_CLIENTE;

const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTRO = "11111111-2222-3333-4444-555555555555";
const TERCERO = "99999999-8888-7777-6666-555555555555";
const HORA = 60 * 60_000;
const nombre = (id: string) => `t_${id.replaceAll("-", "")}`;

/** La lista que devuelve control: las bases `lista`, en el orden de `hashtext`. */
function listadas(...ids: string[]) {
  h.leer.mockResolvedValue({ rows: ids.map((tenant_id) => ({ tenant_id })) });
}

const error = (code: string) => Object.assign(new Error("falló"), { code });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BASE_POR_CLIENTE = "1";
  h.dbDeBase.mockImplementation((base: string) => ({ nombre: base }));
});

afterEach(() => {
  vi.useRealTimers();
  if (SAVED === undefined) delete process.env.BASE_POR_CLIENTE;
  else process.env.BASE_POR_CLIENTE = SAVED;
});

describe("paraCadaBase con la bandera apagada", () => {
  beforeEach(() => {
    delete process.env.BASE_POR_CLIENTE;
  });

  it("corre el trabajo una sola vez, con `db` y sin inquilino, y no consulta nada", async () => {
    const trabajo = vi.fn().mockResolvedValue("hecho");

    const r = await paraCadaBase(trabajo, { hasta: Date.now() + 60_000 });

    expect(r).toEqual({ resultados: ["hecho"], pendientes: 0, fallas: 0 });
    expect(trabajo).toHaveBeenCalledOnce();
    expect(trabajo).toHaveBeenCalledWith(db, null);
    expect(h.leer).not.toHaveBeenCalled();
    expect(h.dbDeBase).not.toHaveBeenCalled();
  });

  it("corre aunque `hasta` ya haya pasado: es lo de siempre, una sola base", async () => {
    const trabajo = vi.fn().mockResolvedValue(1);

    await expect(paraCadaBase(trabajo, { hasta: Date.now() - 1 })).resolves.toMatchObject({ resultados: [1] });
  });

  it("si el trabajo tira, tira: no cambia lo que pasaba antes", async () => {
    const trabajo = vi.fn().mockRejectedValue(new Error("se cayó"));

    await expect(paraCadaBase(trabajo, { hasta: Date.now() + 60_000 })).rejects.toThrow("se cayó");
  });
});

describe("paraCadaBase con la bandera prendida", () => {
  it("pide a control las bases 'lista' en una sola consulta y corre el trabajo en cada una, con su inquilino", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    listadas(TENANT, OTRO);
    const trabajo = vi.fn(async (_db: unknown, tenantId: string | null) => `visto ${tenantId}`);

    const r = await paraCadaBase(trabajo, { hasta: Date.now() + 60_000 });

    expect(r).toEqual({ resultados: [`visto ${TENANT}`, `visto ${OTRO}`], pendientes: 0, fallas: 0 });
    expect(h.leer).toHaveBeenCalledOnce();
    const { sql } = dialecto.sqlToQuery(h.leer.mock.calls[0]![0] as SQL);
    expect(sql).toContain("from public.tenant_bases");
    expect(sql).toContain("where estado = 'lista'");
    expect(h.dbDeBase.mock.calls.map((c) => c[0])).toEqual([nombre(TENANT), nombre(OTRO)]);
    expect(trabajo.mock.calls).toEqual([
      [{ nombre: nombre(TENANT) }, TENANT],
      [{ nombre: nombre(OTRO) }, OTRO],
    ]);
  });

  it("no usa `db` para el trabajo: cada base trae la suya", async () => {
    listadas(TENANT);
    const trabajo = vi.fn().mockResolvedValue(null);

    await paraCadaBase(trabajo, { hasta: Date.now() + 60_000 });

    expect(trabajo.mock.calls[0]![0]).not.toBe(db);
  });

  it("empieza cada hora por otra base, para que si no alcanza el tiempo no queden siempre las mismas afuera", async () => {
    vi.useFakeTimers();
    listadas(TENANT, OTRO, TERCERO);
    const orden: string[][] = [];
    for (const hora of [0, 1, 2, 3]) {
      vi.setSystemTime(hora * HORA);
      const visitadas: string[] = [];
      await paraCadaBase(async (_db, tenantId) => void visitadas.push(tenantId!), { hasta: Date.now() + 60_000 });
      orden.push(visitadas);
    }

    expect(orden).toEqual([
      [TENANT, OTRO, TERCERO],
      [OTRO, TERCERO, TENANT],
      [TERCERO, TENANT, OTRO],
      [TENANT, OTRO, TERCERO],
    ]);
  });

  it("corta en `hasta` y cuenta como pendientes las bases que no alcanzó, sin contarlas como falla", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    listadas(TENANT, OTRO, TERCERO);
    // La primera base consume todo el tiempo que había.
    const trabajo = vi.fn(async () => {
      vi.setSystemTime(61_000);
      return "listo";
    });

    const r = await paraCadaBase(trabajo, { hasta: 60_000 });

    expect(r).toEqual({ resultados: ["listo"], pendientes: 2, fallas: 0 });
    expect(trabajo).toHaveBeenCalledTimes(1);
  });

  it("con `hasta` vencido no corre ninguna y todas quedan pendientes", async () => {
    listadas(TENANT, OTRO);
    const trabajo = vi.fn();

    const r = await paraCadaBase(trabajo, { hasta: Date.now() - 1 });

    expect(r).toEqual({ resultados: [], pendientes: 2, fallas: 0 });
    expect(trabajo).not.toHaveBeenCalled();
  });

  it("una base que falla se cuenta y no frena a las demás", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    listadas(TENANT, OTRO, TERCERO);
    const trabajo = vi.fn(async (_db: unknown, tenantId: string | null) => {
      if (tenantId === OTRO) throw error("3D000");
      return tenantId;
    });

    const r = await paraCadaBase(trabajo, { hasta: Date.now() + 60_000 });

    expect(r).toEqual({ resultados: [TENANT, TERCERO], pendientes: 0, fallas: 1 });
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith({ tenantId: OTRO, detalle: "3D000" }, "bases.barrido_fallo");
  });

  it("si el nombre de la base no se puede armar, esa base falla y las otras siguen", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    listadas(TENANT, OTRO);
    h.dbDeBase.mockImplementationOnce(() => {
      throw new Error("[db] el nombre de la base no es t_ y 32 hex");
    });
    const trabajo = vi.fn().mockResolvedValue("ok");

    const r = await paraCadaBase(trabajo, { hasta: Date.now() + 60_000 });

    expect(r).toEqual({ resultados: ["ok"], pendientes: 0, fallas: 1 });
  });

  it("no deja correos en el log: sólo el código del error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    listadas(TENANT);
    const trabajo = vi.fn().mockRejectedValue(
      Object.assign(new Error('Failed query: update … params: [{"email":"ana@example.com"}]'), { code: "23505" })
    );

    await paraCadaBase(trabajo, { hasta: Date.now() + 60_000 });

    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("ana@example.com");
    expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT, detalle: "23505" }, "bases.barrido_fallo");
  });

  it("corre de a una base por vez: nunca dos a la vez", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    listadas(TENANT, OTRO, TERCERO);
    let enCurso = 0;
    let maximo = 0;
    const trabajo = async () => {
      enCurso++;
      maximo = Math.max(maximo, enCurso);
      await Promise.resolve();
      enCurso--;
    };

    await paraCadaBase(trabajo, { hasta: Date.now() + 60_000 });

    expect(maximo).toBe(1);
  });

  it("si no puede leer la lista de bases devuelve una falla y no tira ni corre nada", async () => {
    h.leer.mockRejectedValue(error("08006"));
    const trabajo = vi.fn();

    await expect(paraCadaBase(trabajo, { hasta: Date.now() + 60_000 })).resolves.toEqual({
      resultados: [],
      pendientes: 0,
      fallas: 1,
    });

    expect(trabajo).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith({ detalle: "08006" }, "bases.barrido_sin_lista");
  });

  it("sin bases 'lista' no hay nada que hacer", async () => {
    listadas();
    const trabajo = vi.fn();

    await expect(paraCadaBase(trabajo, { hasta: Date.now() + 60_000 })).resolves.toEqual({
      resultados: [],
      pendientes: 0,
      fallas: 0,
    });

    expect(trabajo).not.toHaveBeenCalled();
  });
});
