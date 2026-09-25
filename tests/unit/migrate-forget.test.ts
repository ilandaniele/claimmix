// @vitest-environment node
/**
 * `migrate.mjs --forget NNNN` saca una versión del registro sin tocar el
 * esquema — la contracara de --baseline, para cuando el ledger dice que la
 * base tiene algo que no tiene.
 *
 * El chequeo de drift corría ANTES que --forget, así que una fila cuyo
 * checksum divergió no se podía olvidar nunca: el drift cortaba la corrida
 * antes de llegar a la sección que la borra del registro. Exactamente el
 * caso para el que --forget existe.
 *
 * Mismo patrón que migrate-exigir.test.ts: se importa el script de verdad,
 * con el driver falso y `process.exit` atajado.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const estado = vi.hoisted(() => ({
  consultas: [] as string[],
  filas: [] as Array<Record<string, unknown>>,
  aplicar: vi.fn(),
}));

vi.mock("../../scripts/lib/db-driver.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/db-driver.mjs")>()),
  connect: async () => ({
    query: async (text: string) => {
      estado.consultas.push(text);
      if (/to_regclass/.test(text)) return { rows: [{ t: "schema_migrations" }] };
      if (/from schema_migrations/.test(text)) return { rows: estado.filas };
      return { rows: [] };
    },
    applyMigration: estado.aplicar,
    end: async () => {},
  }),
}));

class Salida extends Error {
  codigo: number;
  constructor(codigo: number) {
    super(`process.exit(${codigo})`);
    this.codigo = codigo;
  }
}

const DIR = "neon/migrations";

// El mismo hash que guarda el runner: CRLF normalizado a LF.
function filasDelRepo() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({
      version: f.slice(0, 4),
      filename: f,
      checksum: createHash("sha256")
        .update(readFileSync(join(DIR, f), "utf8").split("\r\n").join("\n"))
        .digest("hex"),
      applied_at: new Date(),
      applied_by: "prueba",
    }));
}

const [PRIMERA, SEGUNDA] = filasDelRepo().map((f) => f.version);

const argvOriginal = process.argv;
let errores: string[];

async function correr(...banderas: string[]) {
  process.argv = [argvOriginal[0], "migrate.mjs", "--url", "postgres://falsa", ...banderas];
  try {
    await import("../../scripts/migrate.mjs");
  } catch (e) {
    if (e instanceof Salida) return e.codigo;
    throw e;
  }
  return "terminó sin exit";
}

beforeEach(() => {
  vi.resetModules();
  estado.consultas = [];
  estado.filas = filasDelRepo();
  estado.aplicar.mockClear();
  errores = [];
  vi.spyOn(process, "exit").mockImplementation((codigo) => {
    throw new Salida(Number(codigo ?? 0));
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errores.push(a.join(" "));
  });
});

afterEach(() => {
  process.argv = argvOriginal;
  vi.restoreAllMocks();
});

const DELETE = /delete from schema_migrations where version/i;

describe("migrate.mjs --forget", () => {
  it("con drift en la propia versión, la olvida igual", async () => {
    const fila = estado.filas.find((f) => f.version === PRIMERA)!;
    fila.checksum = "deadbeef".repeat(8); // no matchea ni el nuevo hash ni el viejo

    const codigo = await correr("--forget", PRIMERA, "--apply");

    expect(codigo).toBe(0);
    expect(estado.consultas.some((q) => DELETE.test(q))).toBe(true);
    expect(errores.join("\n")).not.toContain("DRIFT");
  });

  it("un drift en OTRA versión sigue bloqueando la corrida", async () => {
    const otra = estado.filas.find((f) => f.version === SEGUNDA)!;
    otra.checksum = "deadbeef".repeat(8);

    const codigo = await correr("--forget", PRIMERA, "--apply");

    expect(codigo).toBe(1);
    expect(errores.join("\n")).toContain("DRIFT");
    expect(estado.consultas.some((q) => DELETE.test(q))).toBe(false);
  });

  it("sin --apply es un dry run: no borra nada, aunque haya drift propio", async () => {
    const fila = estado.filas.find((f) => f.version === PRIMERA)!;
    fila.checksum = "deadbeef".repeat(8);

    const codigo = await correr("--forget", PRIMERA);

    expect(codigo).toBe(0);
    expect(estado.consultas.some((q) => DELETE.test(q))).toBe(false);
  });
});
