/**
 * Crear, migrar y dar permisos a la base de un inquilino.
 *
 * Se sustituye lo que habla con Neon: `db` (el dueño contra control) y el Pool de
 * WebSocket. Lo que se prueba es lo que importa sin una base de verdad: qué SQL
 * sale y en qué orden, qué se hace con cada código de error, que el nombre se
 * comprueba antes de cualquier sentencia y que el Pool se cierra siempre. Que el
 * lease y el CREATE DATABASE anden contra Postgres lo prueba `pnpm bases:probar`.
 */

import { createHash } from "node:crypto";

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  execute: vi.fn(),
  /** Una por Pool creado: la cadena con la que se abrió y lo que se le consultó. */
  pools: [] as Array<{ cadena: string; consultas: string[]; liberado: boolean; cerrado: boolean }>,
  /** Lo que contesta `query` en el Pool: recibe el texto y devuelve la respuesta o tira. */
  query: vi.fn(),
  conectar: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { execute: h.execute } }));
vi.mock("@neondatabase/serverless", () => ({
  Pool: class {
    private readonly estado: (typeof h.pools)[number];
    constructor(opciones: { connectionString: string }) {
      this.estado = { cadena: opciones.connectionString, consultas: [], liberado: false, cerrado: false };
      h.pools.push(this.estado);
    }
    async connect() {
      await h.conectar();
      return {
        query: async (texto: string) => {
          this.estado.consultas.push(texto);
          return h.query(texto);
        },
        release: () => {
          this.estado.liberado = true;
        },
      };
    }
    async end() {
      this.estado.cerrado = true;
    }
  },
}));

import { MIGRACIONES, PERMISOS_APP, PERMISOS_CLIENTE, VERSION_ESPERADA } from "@/server/bases/plantilla.generated";
import {
  crearBaseSiFalta,
  darPermisos,
  marcarBase,
  migrarBase,
  registrarBase,
  tomarBase,
  topesDeBases,
} from "@/server/bases/crear-base";

const dialecto = new PgDialect();
const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const BASE = "t_aaaaaaaabbbbccccddddeeeeeeeeeeee";
const URL_CONTROL = "postgresql://dueno:test-fake-key@ep-fake-1.example.com/neondb?sslmode=require";
const SAVED = process.env.DATABASE_URL;

/** La sentencia que se mandó a `db.execute`, con espacios normalizados y sus parámetros. */
function enviada(llamada = 0): { sql: string; params: unknown[] } {
  const q = dialecto.sqlToQuery(h.execute.mock.calls[llamada]![0] as SQL);
  return { sql: q.sql.replace(/\s+/g, " ").trim(), params: q.params };
}

const error = (code: string, envuelto = false) =>
  envuelto ? Object.assign(new Error("Failed query"), { cause: { code } }) : Object.assign(new Error("pg"), { code });

beforeEach(() => {
  h.execute.mockReset();
  h.execute.mockResolvedValue({ rows: [] });
  h.query.mockReset();
  h.query.mockResolvedValue({ rows: [] });
  h.conectar.mockReset();
  h.conectar.mockResolvedValue(undefined);
  h.pools.length = 0;
  process.env.DATABASE_URL = URL_CONTROL;
});

afterEach(() => {
  if (SAVED === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = SAVED;
});

const NOMBRES_MALOS = [
  "",
  "neondb",
  "T_" + "a".repeat(32),
  "t_" + "A".repeat(32),
  "t_" + "a".repeat(31),
  "t_" + "a".repeat(33),
  `${BASE}"; drop database neondb; --`,
  `${BASE}/../neondb`,
  "t_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
];

describe("crearBaseSiFalta", () => {
  it("crea la base por el driver HTTP, con el nombre entre comillas", async () => {
    await expect(crearBaseSiFalta(BASE)).resolves.toBe("creada");

    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(enviada().sql).toBe(`CREATE DATABASE "${BASE}"`);
    expect(h.pools).toHaveLength(0);
  });

  it.each([false, true])("42P04 (la base ya estaba, envuelto=%s) da 'existia' y no sigue", async (envuelto) => {
    h.execute.mockRejectedValue(error("42P04", envuelto));

    await expect(crearBaseSiFalta(BASE)).resolves.toBe("existia");

    expect(h.pools).toHaveLength(0);
  });

  it("25001 repite por Pool contra la base de control y cierra el Pool", async () => {
    h.execute.mockRejectedValue(error("25001", true));

    await expect(crearBaseSiFalta(BASE)).resolves.toBe("creada");

    expect(h.pools).toHaveLength(1);
    expect(h.pools[0]!.cadena).toBe(URL_CONTROL);
    expect(h.pools[0]!.consultas).toEqual([`CREATE DATABASE "${BASE}"`]);
    expect(h.pools[0]!.liberado).toBe(true);
    expect(h.pools[0]!.cerrado).toBe(true);
  });

  it("si el Pool dice que ya existía, también es 'existia'", async () => {
    h.execute.mockRejectedValue(error("25001"));
    h.query.mockRejectedValue(error("42P04"));

    await expect(crearBaseSiFalta(BASE)).resolves.toBe("existia");
    expect(h.pools[0]!.cerrado).toBe(true);
  });

  it("si el Pool falla por otra cosa, tira y igual lo cierra", async () => {
    h.execute.mockRejectedValue(error("25001"));
    h.query.mockRejectedValue(error("42501"));

    await expect(crearBaseSiFalta(BASE)).rejects.toMatchObject({ code: "42501" });
    expect(h.pools[0]!.cerrado).toBe(true);
  });

  it("cualquier otro error del driver HTTP tira sin abrir un Pool", async () => {
    h.execute.mockRejectedValue(error("53100"));

    await expect(crearBaseSiFalta(BASE)).rejects.toMatchObject({ code: "53100" });
    expect(h.pools).toHaveLength(0);
  });

  it.each(NOMBRES_MALOS)("no manda SQL con el nombre %j", async (nombre) => {
    await expect(crearBaseSiFalta(nombre)).rejects.toThrow(/no es t_ y 32 hex/);

    expect(h.execute).not.toHaveBeenCalled();
    expect(h.pools).toHaveLength(0);
  });
});

describe("registrarBase", () => {
  it("inserta 'creando' y deja en paz a la fila que ya hubiera", async () => {
    await registrarBase(TENANT);

    const { sql, params } = enviada();
    expect(sql).toContain("insert into public.tenant_bases");
    expect(sql).toContain("'creando'");
    expect(sql).toContain("on conflict do nothing");
    expect(params).toEqual([TENANT]);
  });
});

describe("tomarBase", () => {
  it("es una sola sentencia: inserta o reclama, y sólo si está creando o fallida y sin lease vigente", async () => {
    h.execute.mockResolvedValue({ rows: [{ intentos: 2 }] });

    await tomarBase(TENANT, 15);

    expect(h.execute).toHaveBeenCalledTimes(1);
    const { sql, params } = enviada();
    expect(sql).toContain("insert into public.tenant_bases as b");
    expect(sql).toContain("on conflict (tenant_id) do update");
    expect(sql).toContain("tomada_at = now()");
    expect(sql).toContain("intentos = b.intentos + 1");
    expect(sql).toContain("estado = 'creando'");
    expect(sql).toContain("where b.estado in ('creando', 'fallida')");
    expect(sql).toContain("b.tomada_at is null or b.tomada_at < now() - make_interval(mins => $2::int)");
    expect(sql).toContain("returning b.intentos");
    expect(params).toEqual([TENANT, 15]);
  });

  it("devuelve los intentos de la fila reclamada", async () => {
    h.execute.mockResolvedValue({ rows: [{ intentos: "3" }] });

    await expect(tomarBase(TENANT, 15)).resolves.toEqual({ intentos: 3 });
  });

  it("dentro del lease (o con la base lista o borrada) la sentencia no devuelve fila y da null", async () => {
    h.execute.mockResolvedValue({ rows: [] });

    await expect(tomarBase(TENANT, 15)).resolves.toBeNull();
  });
});

describe("migrarBase", () => {
  const sqlDe = (m: { sql: string }) => expect.stringContaining(m.sql);

  it("abre el Pool sobre la base del inquilino, no sobre control", async () => {
    h.query.mockResolvedValue({ rows: [{ v: VERSION_ESPERADA }] });

    await migrarBase(BASE);

    const url = new URL(h.pools[0]!.cadena);
    expect(url.pathname).toBe(`/${BASE}`);
    expect(url.host).toBe("ep-fake-1.example.com");
    expect(url.searchParams.get("sslmode")).toBe("require");
  });

  it("crea el registro, lee la versión y aplica sólo las que faltan", async () => {
    const pendientes = MIGRACIONES.slice(-2);
    h.query.mockImplementation(async (texto: string) =>
      texto.includes("max(version") ? { rows: [{ v: VERSION_ESPERADA - 2 }] } : { rows: [] },
    );

    await expect(migrarBase(BASE)).resolves.toBe(VERSION_ESPERADA);

    const { consultas } = h.pools[0]!;
    expect(consultas).toHaveLength(2 + 2);
    expect(consultas[0]).toContain("create table if not exists schema_migrations");
    expect(consultas[1]).toContain("select coalesce(max(version::int), 0)");
    expect(consultas[2]).toEqual(sqlDe(pendientes[0]!));
    expect(consultas[3]).toEqual(sqlDe(pendientes[1]!));
    for (const m of MIGRACIONES.slice(0, -2)) {
      expect(consultas.some((c) => c.includes(m.sql))).toBe(false);
    }
  });

  it("con la base al día no aplica nada y devuelve su versión", async () => {
    h.query.mockResolvedValue({ rows: [{ v: VERSION_ESPERADA }] });

    await expect(migrarBase(BASE)).resolves.toBe(VERSION_ESPERADA);

    expect(h.pools[0]!.consultas).toHaveLength(2);
  });

  it("con el registro vacío aplica toda la cadena, en orden, y devuelve la última", async () => {
    h.query.mockImplementation(async (texto: string) =>
      texto.includes("max(version") ? { rows: [{ v: 0 }] } : { rows: [] },
    );

    await expect(migrarBase(BASE)).resolves.toBe(VERSION_ESPERADA);

    const aplicadas = h.pools[0]!.consultas.slice(2);
    expect(aplicadas).toHaveLength(MIGRACIONES.length);
    aplicadas.forEach((c, i) => expect(c).toContain(MIGRACIONES[i]!.sql));
  });

  it("la migración y su asiento van en la misma consulta, con el hash del SQL", async () => {
    h.query.mockImplementation(async (texto: string) =>
      texto.includes("max(version") ? { rows: [{ v: VERSION_ESPERADA - 1 }] } : { rows: [] },
    );

    await migrarBase(BASE);

    const ultima = MIGRACIONES[MIGRACIONES.length - 1]!;
    const hash = createHash("sha256").update(ultima.sql).digest("hex");
    const consulta = h.pools[0]!.consultas[2]!;
    expect(consulta).toContain(ultima.sql);
    expect(consulta).toContain(
      `insert into schema_migrations (version, filename, checksum, applied_by) values ('${ultima.nombre.slice(0, 4)}', '${ultima.nombre}', '${hash}', 'preparar-base')`,
    );
    expect(consulta.indexOf(ultima.sql)).toBeLessThan(consulta.indexOf("insert into schema_migrations"));
  });

  it("si una migración falla, tira, no sigue con las otras y cierra el Pool", async () => {
    h.query.mockImplementation(async (texto: string) => {
      if (texto.includes("max(version")) return { rows: [{ v: VERSION_ESPERADA - 2 }] };
      if (texto.includes(MIGRACIONES[MIGRACIONES.length - 2]!.sql)) throw error("42P07");
      return { rows: [] };
    });

    await expect(migrarBase(BASE)).rejects.toMatchObject({ code: "42P07" });

    expect(h.pools[0]!.consultas).toHaveLength(3);
    expect(h.pools[0]!.liberado).toBe(true);
    expect(h.pools[0]!.cerrado).toBe(true);
  });

  it("si no puede conectar, igual cierra el Pool", async () => {
    h.conectar.mockRejectedValue(new Error("sin red"));

    await expect(migrarBase(BASE)).rejects.toThrow("sin red");
    expect(h.pools[0]!.cerrado).toBe(true);
  });

  it("sin DATABASE_URL tira", async () => {
    delete process.env.DATABASE_URL;

    await expect(migrarBase(BASE)).rejects.toThrow("DATABASE_URL is not set");
    expect(h.pools).toHaveLength(0);
  });

  it.each(NOMBRES_MALOS)("no abre un Pool con el nombre %j", async (nombre) => {
    await expect(migrarBase(nombre)).rejects.toThrow(/no es t_ y 32 hex/);

    expect(h.pools).toHaveLength(0);
  });
});

describe("darPermisos", () => {
  it("manda los permisos de la app y después los del perfil cliente, en una sola consulta", async () => {
    await darPermisos(BASE);

    const { consultas, cadena, cerrado } = h.pools[0]!;
    expect(new URL(cadena).pathname).toBe(`/${BASE}`);
    expect(consultas).toEqual([[...PERMISOS_APP, ...PERMISOS_CLIENTE].join(";\n")]);
    expect(consultas[0]!.indexOf(PERMISOS_APP[0]!)).toBe(0);
    expect(consultas[0]!.endsWith(PERMISOS_CLIENTE[PERMISOS_CLIENTE.length - 1]!)).toBe(true);
    expect(cerrado).toBe(true);
  });

  it("si falla tira y cierra el Pool", async () => {
    h.query.mockRejectedValue(error("42704"));

    await expect(darPermisos(BASE)).rejects.toMatchObject({ code: "42704" });
    expect(h.pools[0]!.cerrado).toBe(true);
  });

  it.each(NOMBRES_MALOS)("no abre un Pool con el nombre %j", async (nombre) => {
    await expect(darPermisos(nombre)).rejects.toThrow(/no es t_ y 32 hex/);

    expect(h.pools).toHaveLength(0);
  });
});

describe("marcarBase", () => {
  it("lista: guarda la versión, sella lista_at, limpia el error y suelta el lease", async () => {
    await marcarBase(TENANT, "lista", { version: 50 });

    const { sql, params } = enviada();
    expect(sql).toContain("update public.tenant_bases set");
    expect(sql).toContain("lista_at = case when $4::boolean then now() else lista_at end");
    expect(sql).toContain("tomada_at = null");
    expect(sql).toContain("where tenant_id = $5::uuid");
    expect(params).toEqual(["lista", 50, null, true, TENANT]);
  });

  it("fallida: guarda el error, no sella lista_at y suelta el lease", async () => {
    await marcarBase(TENANT, "fallida", { error: "boom" });

    const { params } = enviada();
    expect(params).toEqual(["fallida", null, "boom", false, TENANT]);
  });

  it("recorta el error a 500 caracteres", async () => {
    await marcarBase(TENANT, "fallida", { error: "x".repeat(900) });

    const error = enviada().params[2] as string;
    expect(error).toHaveLength(500);
  });
});

describe("topesDeBases", () => {
  it("es una consulta sobre pg_database, con el filtro de CONNECT", async () => {
    h.execute.mockResolvedValue({ rows: [{ bases: 7, mb: "212" }] });

    await expect(topesDeBases()).resolves.toEqual({ bases: 7, mb: 212 });

    expect(h.execute).toHaveBeenCalledTimes(1);
    const { sql } = enviada();
    expect(sql).toContain("from pg_database");
    expect(sql).toContain("datname ~ '^t_[0-9a-f]{32}$'");
    expect(sql).toContain("not datistemplate and has_database_privilege(oid, 'CONNECT')");
    expect(sql).toContain("sum(pg_database_size(oid))");
  });

  it("sin fila devuelve ceros", async () => {
    h.execute.mockResolvedValue({ rows: [] });

    await expect(topesDeBases()).resolves.toEqual({ bases: 0, mb: 0 });
  });
});
