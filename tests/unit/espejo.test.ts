/**
 * El espejo de control en la base de un cliente.
 *
 * Se sustituye lo que habla con Neon: `db` (el dueño contra control) y `dbDeBase`
 * (el dueño contra la base del cliente), que devuelve las sentencias tal cual en
 * vez de ejecutarlas, y un `batch` que las recibe todas juntas. Lo que se prueba es
 * lo que importa sin una base de verdad: que haya una lectura y un lote, en qué
 * orden van las sentencias, qué columnas se pisan y cuáles no, que el token no
 * viaje y qué pasa con el barrido. Que el SQL ande contra Postgres lo prueba
 * `pnpm bases:probar`, que compara el espejo con control.
 */

import { getTableColumns } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** La lectura a control: `db.execute`. */
  leer: vi.fn(),
  /** El lote a la base del cliente. */
  batch: vi.fn(),
  dbDeBase: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { execute: h.leer }, dbDeBase: h.dbDeBase }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() },
}));

import { authUsers, tenants, users, whatsappNumeros } from "@/lib/db/schema";
import { espejar, espejarTodas } from "@/server/bases/espejo";
import { COLUMNAS_DE_CONFIG } from "@/server/bases/plantilla.generated";

const dialecto = new PgDialect();
const SAVED = process.env.BASE_POR_CLIENTE;

const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const BASE = "t_aaaaaaaabbbbccccddddeeeeeeeeeeee";
const OTRO = "11111111-2222-3333-4444-555555555555";
const TERCERO = "99999999-8888-7777-6666-555555555555";
const HORA = 60 * 60_000;

const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";
const N1 = "00000000-0000-4000-8000-0000000000a1";
const N2 = "00000000-0000-4000-8000-0000000000a2";

/** Lo que devuelve la lectura a control para un inquilino con dos usuarios y dos números (uno de baja). */
function deControl(): Record<string, unknown> {
  return {
    tenant: { id: TENANT, name: "Aseguradora Ejemplo", plan: "piloto", autoalta: true, plazos: null },
    users: [
      { id: U1, tenant_id: TENANT, full_name: "Ana", role: "owner", locale: "es-AR", created_at: "2026-10-01T10:00:00+00:00" },
      { id: U2, tenant_id: TENANT, full_name: "Beto", role: "analyst", locale: null, created_at: "2026-10-02T10:00:00+00:00" },
    ],
    auth: [
      { id: U1, name: "Ana", email: "ana@example.com", email_verified: true },
      { id: U2, name: "Beto", email: "beto@example.com", email_verified: false },
    ],
    numeros: [
      { id: N2, tenant_id: TENANT, numero_e164: "+5491100000001", estado: "baja", token_cifrado: "test-viejo-key" },
      { id: N1, tenant_id: TENANT, numero_e164: "+5491100000002", estado: "conectado", token_cifrado: "test-token-key" },
    ],
  };
}

/** `db.execute` de la lectura: la lista de bases para el barrido y el espejo para cada inquilino. */
function control(espejo: () => Record<string, unknown> = deControl, listadas: string[] = []) {
  h.leer.mockImplementation(async (consulta: SQL) => {
    if (dialecto.sqlToQuery(consulta).sql.includes("from public.tenant_bases")) {
      return { rows: listadas.map((tenant_id) => ({ tenant_id })) };
    }
    return { rows: [{ espejo: espejo() }] };
  });
}

const render = (s: SQL) => {
  const q = dialecto.sqlToQuery(s);
  return { sql: q.sql.replace(/\s+/g, " ").trim(), params: q.params };
};

/** Las sentencias del primer lote, ya con su texto y sus parámetros. */
const lote = () => (h.batch.mock.calls[0]![0] as SQL[]).map(render);

/** Las columnas que lista un `insert into … (a, b, c)`. */
const columnasDelInsert = (texto: string) =>
  /insert into \S+ \((.*?)\) select/.exec(texto)![1]!.split(", ").map((c) => c.replaceAll('"', ""));

const error = (code: string, envuelto = false) =>
  envuelto ? Object.assign(new Error("Failed query"), { cause: { code } }) : Object.assign(new Error("pg"), { code });

beforeEach(() => {
  h.leer.mockReset();
  h.batch.mockReset();
  h.batch.mockResolvedValue([]);
  h.dbDeBase.mockReset();
  h.dbDeBase.mockImplementation(() => ({ execute: (s: SQL) => s, batch: h.batch }));
  h.warn.mockReset();
  control();
  process.env.BASE_POR_CLIENTE = "1";
});

afterEach(() => {
  vi.useRealTimers();
  if (SAVED === undefined) delete process.env.BASE_POR_CLIENTE;
  else process.env.BASE_POR_CLIENTE = SAVED;
});

describe("espejar", () => {
  it("con el flag apagado no hace nada: ni lee control ni abre la base", async () => {
    delete process.env.BASE_POR_CLIENTE;

    await expect(espejar(TENANT)).resolves.toBeUndefined();
    await expect(espejar("no-es-un-uuid")).resolves.toBeUndefined();

    expect(h.leer).not.toHaveBeenCalled();
    expect(h.dbDeBase).not.toHaveBeenCalled();
    expect(h.batch).not.toHaveBeenCalled();
  });

  it("hace una sola lectura a control y un solo lote a la base del inquilino", async () => {
    await expect(espejar(TENANT)).resolves.toBeUndefined();

    expect(h.leer).toHaveBeenCalledTimes(1);
    expect(h.dbDeBase).toHaveBeenCalledTimes(1);
    expect(h.dbDeBase).toHaveBeenCalledWith(BASE);
    expect(h.batch).toHaveBeenCalledTimes(1);
    expect(lote()).toHaveLength(6);
  });

  it("la lectura es una sentencia sobre el inquilino y no trae token_cifrado", async () => {
    await espejar(TENANT);

    const { sql, params } = render(h.leer.mock.calls[0]![0] as SQL);
    expect(sql).toContain("jsonb_build_object(");
    expect(sql).toContain("from public.tenants t where t.id = $1::uuid");
    expect(sql).toContain("from public.users u where u.tenant_id = $2::uuid");
    expect(sql).toContain('from public."user" a');
    expect(sql).toContain("select m.id from public.users m where m.tenant_id = $3::uuid");
    expect(sql).toContain("from public.whatsapp_numeros n where n.tenant_id = $4::uuid");
    expect(sql).toContain("to_jsonb(n) - 'token_cifrado'");
    expect(params).toEqual([TENANT, TENANT, TENANT, TENANT]);
  });

  it("los números salen de baja primero, para que el nuevo no choque con el viejo en los índices únicos", async () => {
    await espejar(TENANT);

    expect(render(h.leer.mock.calls[0]![0] as SQL).sql).toContain("order by (n.estado <> 'baja'), n.creado_en, n.id");
  });

  it("en orden de FK: primero se borra lo que se fue (users antes que 'user'), después se sube tenants, 'user', users y números", async () => {
    await espejar(TENANT);

    const [borraUsuarios, borraNumeros, subeTenant, subeAuth, subeUsuarios, subeNumeros] = lote();
    const usuariosAntes = borraUsuarios!.sql.indexOf("delete from public.users");
    const authDespues = borraUsuarios!.sql.indexOf('delete from public."user"');
    expect(usuariosAntes).toBeGreaterThan(-1);
    expect(authDespues).toBeGreaterThan(usuariosAntes);
    expect(borraNumeros!.sql).toContain("delete from public.whatsapp_numeros");
    expect(subeTenant!.sql).toContain("insert into public.tenants");
    expect(subeAuth!.sql).toContain('insert into public."user"');
    expect(subeUsuarios!.sql).toContain("insert into public.users");
    expect(subeNumeros!.sql).toContain("insert into public.whatsapp_numeros");
  });

  it("el insert del inquilino lleva todas las columnas del esquema y el update no toca COLUMNAS_DE_CONFIG ni el id", async () => {
    await espejar(TENANT);

    const [insertar, actualizar] = lote()[2]!.sql.split(" do update set ") as [string, string];
    const todas = Object.values(getTableColumns(tenants)).map((c) => c.name);
    expect(columnasDelInsert(insertar).sort()).toEqual([...todas].sort());

    expect(COLUMNAS_DE_CONFIG.length).toBeGreaterThan(0);
    for (const c of COLUMNAS_DE_CONFIG) {
      expect(insertar).toContain(`"${c}"`);
      expect(actualizar).not.toContain(`"${c}"`);
    }
    expect(actualizar).not.toContain('"id"');

    const pisadas = [...actualizar.matchAll(/"(\w+)" = excluded\."\1"/g)].map((m) => m[1]).sort();
    expect(pisadas).toEqual(todas.filter((c) => c !== "id" && !COLUMNAS_DE_CONFIG.includes(c)).sort());
  });

  it("el inquilino viaja como el único elemento de una lista, tal cual lo leyó control", async () => {
    await espejar(TENANT);

    const { sql, params } = lote()[2]!;
    expect(sql).toContain("jsonb_populate_recordset(null::public.tenants, $1::jsonb)");
    expect(params).toHaveLength(1);
    expect(JSON.parse(params[0] as string)).toEqual([deControl().tenant]);
  });

  it.each([
    [3, "user", authUsers, "auth"],
    [4, "users", users, "users"],
  ] as const)("la sentencia %i sube %s entera y pisa todo menos el id", async (i, _nombre, tabla, clave) => {
    await espejar(TENANT);

    const { sql, params } = lote()[i]!;
    const todas = Object.values(getTableColumns(tabla)).map((c) => c.name);
    const [insertar, actualizar] = sql.split(" do update set ") as [string, string];
    expect(columnasDelInsert(insertar)).toEqual(todas);
    expect([...actualizar.matchAll(/"(\w+)" = excluded\."\1"/g)].map((m) => m[1])).toEqual(
      todas.filter((c) => c !== "id"),
    );
    expect(sql).toContain("on conflict (id) do update set");
    expect(JSON.parse(params[0] as string)).toEqual(deControl()[clave]);
  });

  it("token_cifrado nunca viaja: no está en el JSON y la columna se pisa con NULL", async () => {
    await espejar(TENANT);

    const { sql, params } = lote()[5]!;
    const [insertar, actualizar] = sql.split(" do update set ") as [string, string];
    const filas = JSON.parse(params[0] as string) as Array<Record<string, unknown>>;
    expect(filas).toHaveLength(2);
    for (const fila of filas) expect(fila).not.toHaveProperty("token_cifrado");
    expect(JSON.stringify(params)).not.toContain("test-token-key");
    expect(JSON.stringify(params)).not.toContain("test-viejo-key");
    // La columna está en el insert y en el update, y sin valor en el JSON queda NULL.
    expect(columnasDelInsert(insertar)).toEqual(Object.values(getTableColumns(whatsappNumeros)).map((c) => c.name));
    expect(actualizar).toContain('"token_cifrado" = excluded."token_cifrado"');
  });

  it("los números siguen el orden de la lectura (los de baja primero)", async () => {
    await espejar(TENANT);

    const filas = JSON.parse(lote()[5]!.params[0] as string) as Array<{ id: string }>;
    expect(filas.map((f) => f.id)).toEqual([N2, N1]);
  });

  it("borra de la copia lo que control ya no tiene: sólo del inquilino, con los ids que siguen", async () => {
    await espejar(TENANT);

    const [borraUsuarios, borraNumeros] = lote();
    expect(borraUsuarios!.sql).toContain("delete from public.users where tenant_id = $1::uuid");
    expect(borraUsuarios!.sql).toContain("and id not in (select jsonb_array_elements_text($2::jsonb)::uuid)");
    expect(borraUsuarios!.sql).toContain("returning id");
    expect(borraUsuarios!.sql).toContain('delete from public."user" where id in (select id from fuera)');
    expect(borraUsuarios!.params).toEqual([TENANT, JSON.stringify([U1, U2])]);

    expect(borraNumeros!.sql).toContain("delete from public.whatsapp_numeros where tenant_id = $1::uuid");
    expect(borraNumeros!.sql).toContain("and id not in (select jsonb_array_elements_text($2::jsonb)::uuid)");
    expect(borraNumeros!.params).toEqual([TENANT, JSON.stringify([N2, N1])]);
  });

  it("un inquilino sin números borra todos los de la copia: la lista de ids que siguen va vacía", async () => {
    control(() => ({ ...deControl(), numeros: [] }));

    await espejar(TENANT);

    expect(lote()[1]!.params).toEqual([TENANT, "[]"]);
    expect(JSON.parse(lote()[5]!.params[0] as string)).toEqual([]);
  });

  it("acepta que el driver entregue el JSON como texto", async () => {
    h.leer.mockResolvedValue([{ espejo: JSON.stringify(deControl()) }]);

    await espejar(TENANT);

    expect(JSON.parse(lote()[4]!.params[0] as string)).toEqual(deControl().users);
  });

  it("si control no tiene al inquilino tira y no toca la base del cliente", async () => {
    control(() => ({ tenant: null, users: [], auth: [], numeros: [] }));

    await expect(espejar(TENANT)).rejects.toThrow(/no está en control/);

    expect(h.dbDeBase).not.toHaveBeenCalled();
    expect(h.batch).not.toHaveBeenCalled();
  });

  it("si la lectura a control falla, tira y no manda el lote", async () => {
    h.leer.mockRejectedValue(error("57P01"));

    await expect(espejar(TENANT)).rejects.toMatchObject({ code: "57P01" });

    expect(h.batch).not.toHaveBeenCalled();
  });

  it("si el lote falla (la base no existe), tira el mismo error para que decida quien llama", async () => {
    h.batch.mockRejectedValue(error("3D000", true));

    await expect(espejar(TENANT)).rejects.toMatchObject({ cause: { code: "3D000" } });
  });

  it.each(["", "neondb", "t_" + "a".repeat(32), `${TENANT}; drop database neondb`])(
    "no lee nada con el id %j, que no es un uuid",
    async (id) => {
      await expect(espejar(id)).rejects.toThrow(/no es un uuid/);

      expect(h.leer).not.toHaveBeenCalled();
      expect(h.dbDeBase).not.toHaveBeenCalled();
    },
  );
});

describe("espejarTodas", () => {
  it("con el flag apagado no hace nada", async () => {
    delete process.env.BASE_POR_CLIENTE;

    await expect(espejarTodas(Date.now() + 60_000)).resolves.toEqual({ ok: 0, fallas: 0 });

    expect(h.leer).not.toHaveBeenCalled();
    expect(h.batch).not.toHaveBeenCalled();
  });

  it("pide a control las bases 'lista' en una sola consulta y espeja cada una en su base", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    control(() => deControl(), [TENANT, OTRO]);

    await expect(espejarTodas(Date.now() + 60_000)).resolves.toEqual({ ok: 2, fallas: 0 });

    const { sql } = render(h.leer.mock.calls[0]![0] as SQL);
    expect(sql).toContain("from public.tenant_bases");
    expect(sql).toContain("where estado = 'lista'");
    expect(h.dbDeBase.mock.calls.map((c) => c[0])).toEqual([BASE, "t_11111111222233334444555555555555"]);
    expect(h.batch).toHaveBeenCalledTimes(2);
  });

  it("empieza cada hora por otra base, para que si no alcanza el tiempo no queden siempre las mismas afuera", async () => {
    vi.useFakeTimers();
    control(() => deControl(), [TENANT, OTRO, TERCERO]);
    const orden: string[][] = [];
    for (const hora of [0, 1, 2, 3]) {
      vi.setSystemTime(hora * HORA);
      h.dbDeBase.mockClear();
      await espejarTodas(Date.now() + 60_000);
      orden.push(h.dbDeBase.mock.calls.map((c) => c[0] as string));
    }

    const b = (id: string) => `t_${id.replaceAll("-", "")}`;
    expect(orden).toEqual([
      [b(TENANT), b(OTRO), b(TERCERO)],
      [b(OTRO), b(TERCERO), b(TENANT)],
      [b(TERCERO), b(TENANT), b(OTRO)],
      [b(TENANT), b(OTRO), b(TERCERO)],
    ]);
  });

  it("corta en `hasta` y las que no alcanzó no cuentan como falla", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    control(() => deControl(), [TENANT, OTRO, TERCERO]);
    // La primera base consume todo el tiempo que había.
    h.batch.mockImplementationOnce(async () => {
      vi.setSystemTime(61_000);
      return [];
    });

    await expect(espejarTodas(60_000)).resolves.toEqual({ ok: 1, fallas: 0 });

    expect(h.batch).toHaveBeenCalledTimes(1);
  });

  it("con `hasta` vencido no espeja ninguna", async () => {
    control(() => deControl(), [TENANT]);

    await expect(espejarTodas(Date.now() - 1)).resolves.toEqual({ ok: 0, fallas: 0 });

    expect(h.batch).not.toHaveBeenCalled();
  });

  it("cuenta las fallas, sigue con las demás y nunca tira", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    control(() => deControl(), [TENANT, OTRO, TERCERO]);
    h.batch.mockResolvedValueOnce([]).mockRejectedValueOnce(error("42501", true)).mockResolvedValueOnce([]);

    await expect(espejarTodas(Date.now() + 60_000)).resolves.toEqual({ ok: 2, fallas: 1 });

    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith({ tenantId: OTRO, detalle: "42501" }, "bases.espejo_barrido_fallo");
  });

  it("un inquilino que control ya no tiene es una falla, no una excepción", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    control(() => ({ tenant: null, users: [], auth: [], numeros: [] }), [TENANT]);

    await expect(espejarTodas(Date.now() + 60_000)).resolves.toEqual({ ok: 0, fallas: 1 });
  });

  it("no deja correos en el log: sólo el código del error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    control(() => deControl(), [TENANT]);
    h.batch.mockRejectedValue(
      Object.assign(new Error('Failed query: insert … params: [{"email":"ana@example.com"}]'), { code: "23505" }),
    );

    await espejarTodas(Date.now() + 60_000);

    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("ana@example.com");
    expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT, detalle: "23505" }, "bases.espejo_barrido_fallo");
  });

  it("si no puede leer la lista de bases devuelve una falla y no tira", async () => {
    h.leer.mockRejectedValue(error("08006"));

    await expect(espejarTodas(Date.now() + 60_000)).resolves.toEqual({ ok: 0, fallas: 1 });

    expect(h.batch).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith({ detalle: "08006" }, "bases.espejo_sin_lista");
  });

  it("sin bases 'lista' no hay nada que hacer", async () => {
    control(() => deControl(), []);

    await expect(espejarTodas(Date.now() + 60_000)).resolves.toEqual({ ok: 0, fallas: 0 });

    expect(h.leer).toHaveBeenCalledTimes(1);
  });
});
