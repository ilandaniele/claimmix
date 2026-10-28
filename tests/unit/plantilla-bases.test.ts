/**
 * La cadena empaquetada y los permisos por perfil. Lo que se vigila: que el
 * archivo generado diga lo mismo que `neon/migrations/` (una migración nueva sin
 * volver a empaquetar es una base de cliente que nace sin ella), que no dependa
 * de `node:fs` (lo usa un workflow), que los perfiles de permisos se ajusten a las
 * listas de control y que sin `--perfil` el rol reciba exactamente lo de siempre.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  COLUMNAS_DE_CONFIG,
  ROL_APP,
  TABLAS_DE_CONTROL,
  TABLAS_SOLO_DE_CONTROL,
  sentenciasDelRol,
  sentenciasPerfilCliente,
  sentenciasPerfilControl,
} from "../../scripts/lib/permisos-por-perfil.mjs";
import {
  PERMISOS_POR_COLUMNA,
  PERMISOS_QUITADOS,
  sentenciasPorColumna,
  sentenciasQuitar,
} from "../../scripts/lib/permisos-quitados.mjs";
import { splitSqlStatements } from "../../scripts/lib/split-sql.mjs";
import { tenants } from "@/lib/db/schema";
import {
  COLUMNAS_DE_CONFIG as EMPAQUETADAS_DE_CONFIG,
  MIGRACIONES,
  PERMISOS_APP,
  PERMISOS_CLIENTE,
  VERSION_ESPERADA,
} from "@/server/bases/plantilla.generated";

const RAIZ = process.cwd();
const CARPETA = join(RAIZ, "neon/migrations");
const ARCHIVOS = readdirSync(CARPETA)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const GENERADO = readFileSync(join(RAIZ, "src/server/bases/plantilla.generated.ts"), "utf8");

/** Las tablas que crea la cadena entera, con o sin comillas y con o sin `public.`. */
const TABLAS_DE_LA_CADENA = new Set(
  MIGRACIONES.flatMap((m) =>
    [...m.sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?(\w+)"?/gi)].map((x) => x[1])
  )
);

describe("la cadena empaquetada", () => {
  it("lleva las versiones en orden y sin huecos, una por archivo", () => {
    expect(MIGRACIONES.map((m) => m.version)).toEqual(MIGRACIONES.map((_, i) => i + 1));
    expect(MIGRACIONES.map((m) => m.nombre)).toEqual(ARCHIVOS);
  });

  it("VERSION_ESPERADA es la última de la cadena y la del último archivo", () => {
    expect(VERSION_ESPERADA).toBe(MIGRACIONES[MIGRACIONES.length - 1].version);
    expect(VERSION_ESPERADA).toBe(Number(ARCHIVOS[ARCHIVOS.length - 1].slice(0, 4)));
  });

  it("cada migración es el archivo, con finales de línea LF", () => {
    for (const m of MIGRACIONES) {
      expect(m.version).toBe(Number(m.nombre.slice(0, 4)));
      expect(m.sql).toBe(readFileSync(join(CARPETA, m.nombre), "utf8").replace(/\r\n/g, "\n"));
      expect(m.sql).not.toContain("\r");
    }
  });

  it("el generado no importa nada, ni node:fs", () => {
    expect(GENERADO).not.toMatch(/^\s*import\s/m);
    expect(GENERADO).not.toMatch(/node:|require\(/);
  });

  it("pnpm bases:empaquetar --comprobar da 0: el archivo está al día", () => {
    const r = spawnSync(process.execPath, ["scripts/empaquetar-bases.mjs", "--comprobar"], {
      cwd: RAIZ,
      encoding: "utf8",
    });

    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("la 0054 (case_id en ai_usage) viaja en la cadena: igual al archivo, y no toca la RLS ni los permisos", () => {
    const m54 = MIGRACIONES.find((m) => m.version === 54)!;

    expect(m54.version).toBe(54);
    expect(m54.nombre).toBe("0054_costo_por_caso.sql");
    expect(m54.sql).toBe(readFileSync(join(CARPETA, m54.nombre), "utf8").replace(/\r\n/g, "\n"));
    expect(m54.sql).toContain("ADD COLUMN IF NOT EXISTS case_id uuid");
    // ADD COLUMN conserva lo que ai_usage ya tenía: la RLS de la 0004 y el FORCE de la 0018,
    // que recorre toda tabla con tenant_id. Si la 0054 los repitiera, sobraría; si los quitara, se vería acá.
    const sinComentarios = m54.sql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(sinComentarios).not.toMatch(/ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY|GRANT|REVOKE/i);
    const rls = MIGRACIONES.filter((m) => m.version < 54 && /'ai_usage',/.test(m.sql) && /ENABLE ROW LEVEL SECURITY/.test(m.sql));
    expect(rls.map((m) => m.version)).toContain(4);
    expect(MIGRACIONES.find((m) => m.version === 18)!.sql).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("la 0055 (planes por unidades) es la última versión de la cadena, igual al archivo, y no toca la RLS ni los permisos", () => {
    const m55 = MIGRACIONES.find((m) => m.version === 55)!;

    expect(VERSION_ESPERADA).toBe(55);
    expect(m55.nombre).toBe("0055_planes_por_unidades.sql");
    expect(m55.sql).toBe(readFileSync(join(CARPETA, m55.nombre), "utf8").replace(/\r\n/g, "\n"));
    expect(m55.sql).toContain("ADD COLUMN IF NOT EXISTS waba_propia boolean NOT NULL DEFAULT false");
    const sinComentarios = m55.sql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(sinComentarios).not.toMatch(/ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY|GRANT|REVOKE/i);
  });

  it("lleva los permisos tal como los arman los scripts", () => {
    expect(PERMISOS_APP).toEqual(sentenciasDelRol());
    expect(PERMISOS_CLIENTE).toEqual(sentenciasPerfilCliente());
    expect(EMPAQUETADAS_DE_CONFIG).toEqual(COLUMNAS_DE_CONFIG);
  });
});

describe("las listas de control", () => {
  it("TABLAS_DE_CONTROL no repite y todas las crea la cadena", () => {
    expect(new Set(TABLAS_DE_CONTROL).size).toBe(TABLAS_DE_CONTROL.length);
    expect(TABLAS_DE_CONTROL.filter((t) => !TABLAS_DE_LA_CADENA.has(t))).toEqual([]);
  });

  it("TABLAS_SOLO_DE_CONTROL está dentro de TABLAS_DE_CONTROL y deja afuera lo que el cliente también tiene", () => {
    expect(TABLAS_SOLO_DE_CONTROL.filter((t) => !TABLAS_DE_CONTROL.includes(t))).toEqual([]);
    expect(TABLAS_DE_CONTROL.filter((t) => !TABLAS_SOLO_DE_CONTROL.includes(t))).toEqual([
      "tenants",
      "users",
      "user",
      "whatsapp_numeros",
      "audit_log",
      "ai_usage",
      "ai_usage_mensual",
    ]);
  });

  it("a lo que PERMISOS_QUITADOS le saca todo, el cliente no lo ve", () => {
    const sinNada = Object.entries(PERMISOS_QUITADOS)
      .filter(([, p]) => ["SELECT", "INSERT", "UPDATE", "DELETE"].every((x) => (p as string[]).includes(x)))
      .map(([t]) => t);

    expect(sinNada.length).toBeGreaterThan(0);
    expect(sinNada.filter((t) => !TABLAS_SOLO_DE_CONTROL.includes(t))).toEqual([]);
  });

  it("COLUMNAS_DE_CONFIG son siete, las de PERMISOS_POR_COLUMNA, y existen en tenants", () => {
    const deTenants = Object.values(getTableColumns(tenants)).map((c) => c.name);

    expect(COLUMNAS_DE_CONFIG).toHaveLength(7);
    expect(COLUMNAS_DE_CONFIG).toEqual(PERMISOS_POR_COLUMNA.tenants.UPDATE);
    expect(COLUMNAS_DE_CONFIG.filter((c) => !deTenants.includes(c))).toEqual([]);
  });
});

describe("el rol sin --perfil (unico)", () => {
  it("recibe exactamente las sentencias de siempre", () => {
    const rol = "claimmix_app";

    expect(ROL_APP).toBe(rol);
    expect(sentenciasDelRol()).toEqual([
      `GRANT USAGE ON SCHEMA public TO ${rol}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${rol}`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${rol}`,
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${rol}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${rol}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${rol}`,
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${rol}`,
      ...sentenciasQuitar(rol),
      ...sentenciasPorColumna(rol).map((x: { sql: string }) => x.sql),
    ]);
  });

  it("los quitados van antes que los permisos por columna, que un REVOKE de tabla borra", () => {
    const todas = sentenciasDelRol();
    const ultimoRevoke = todas.map((s) => s.includes("REVOKE")).lastIndexOf(true);
    const primerGrantDeColumna = todas.findIndex((s) => /GRANT \w+ \(/.test(s));

    expect(primerGrantDeColumna).toBeGreaterThan(ultimoRevoke);
    expect(todas).toContain(
      `DO $$ BEGIN IF to_regclass('public."audit_log"') IS NOT NULL THEN REVOKE UPDATE, DELETE ON public."audit_log" FROM ${ROL_APP}; END IF; END $$`
    );
  });

  it("el script del rol las toma de acá y no las repite", () => {
    const script = readFileSync(join(RAIZ, "scripts/create-app-role.mts"), "utf8");

    expect(script).toContain("sentenciasDelRol()");
    expect(script).not.toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES");
    expect(script).toMatch(/\?\s*process\.argv\[perfilIdx \+ 1\] : "unico"/);
  });
});

describe("el perfil cliente", () => {
  const sentencias = sentenciasPerfilCliente();
  const de = (tabla: string) => sentencias.filter((s) => s.includes(`public."${tabla}"`));

  it("le quita todo al rol en cada tabla que sólo es de control", () => {
    for (const tabla of TABLAS_SOLO_DE_CONTROL) {
      expect(de(tabla)).toEqual([
        `DO $$ BEGIN IF to_regclass('public."${tabla}"') IS NOT NULL THEN REVOKE ALL ON public."${tabla}" FROM claimmix_app; END IF; END $$`,
      ]);
    }
  });

  it("deja las espejadas de sólo lectura: sin INSERT, UPDATE, DELETE ni TRUNCATE", () => {
    for (const tabla of ["users", "user", "whatsapp_numeros"]) {
      expect(de(tabla)).toEqual([
        `DO $$ BEGIN IF to_regclass('public."${tabla}"') IS NOT NULL THEN REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public."${tabla}" FROM claimmix_app; END IF; END $$`,
      ]);
    }
  });

  it("en tenants quita la escritura de tabla y da UPDATE sólo de las columnas de configuración, al final", () => {
    const deTenants = de("tenants");

    expect(deTenants).toHaveLength(2);
    expect(deTenants[0]).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.\"tenants\"");
    expect(deTenants[1]).toContain(`GRANT UPDATE (${COLUMNAS_DE_CONFIG.join(", ")}) ON public."tenants" TO claimmix_app`);
    expect(sentencias[sentencias.length - 1]).toBe(deTenants[1]);
  });

  it("no toca lo que es del negocio ni las tablas que el cliente tiene propias", () => {
    for (const tabla of ["cases", "audit_log", "ai_usage", "ai_usage_mensual"]) {
      expect(de(tabla)).toEqual([]);
    }
  });

  it("cada sentencia es una sola, con el DO entero", () => {
    for (const s of sentencias) expect(splitSqlStatements(s)).toEqual([s]);
  });
});

describe("el perfil control", () => {
  const bloque = sentenciasPerfilControl();

  it("es un solo bloque DO que recorre lo que no es de control", () => {
    expect(splitSqlStatements(bloque)).toEqual([bloque]);
    expect(bloque.startsWith("DO $$")).toBe(true);
    expect(bloque.endsWith("END $$")).toBe(true);
    expect(bloque).toContain("n.nspname = 'public'");
    expect(bloque).toContain("c.relname::text <> ALL (ARRAY[");
  });

  it("excluye cada tabla de control, con 'user' entre comillas simples", () => {
    for (const tabla of TABLAS_DE_CONTROL) expect(bloque).toContain(`'${tabla}'`);
  });

  it("quita la escritura y deja SELECT", () => {
    expect(bloque).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.%I FROM claimmix_app");
    expect(bloque).not.toMatch(/REVOKE[^;]*SELECT/);
    expect(bloque).not.toContain("REVOKE ALL");
  });
});
