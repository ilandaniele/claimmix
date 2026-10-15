/**
 * Cuando una migración falla por un lock (55P03), `migrate.mjs` no manda a
 * «arreglar el SQL»: el SQL está bien y lo que hay que hacer es esperar y
 * volver a correr.
 *
 * Mismo patrón que migrate-forget.test.ts: se importa el script de verdad,
 * con el driver falso y `process.exit` atajado.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const estado = vi.hoisted(() => ({
  filas: [] as Array<Record<string, unknown>>,
  aplicar: vi.fn(),
}));

vi.mock("../../scripts/lib/db-driver.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/db-driver.mjs")>()),
  connect: async () => ({
    query: async (text: string) => {
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
  // La última sin registrar: una pendiente, y el ledger no está vacío.
  estado.filas = filasDelRepo().slice(0, -1);
  estado.aplicar.mockReset();
  errores = [];
  vi.spyOn(process, "exit").mockImplementation((codigo) => {
    throw new Salida(Number(codigo ?? 0));
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errores.push(a.join(" "));
  });
});

afterEach(() => {
  process.argv = argvOriginal;
  vi.restoreAllMocks();
});

describe("migrate.mjs ante un fallo", () => {
  it("por lock dice que se vuelva a correr, no que se arregle el SQL", async () => {
    estado.aplicar.mockRejectedValue(
      Object.assign(new Error("no soltó el lock en 5 s"), { reintentable: true }),
    );

    expect(await correr("--apply")).toBe(1);

    const salida = errores.join("\n");
    expect(salida).toContain("no soltó el lock en 5 s");
    expect(salida).toContain("El SQL no tiene la culpa");
    expect(salida).not.toContain("Arreglá el SQL");
  });

  it("por cualquier otra cosa sigue mandando a arreglar el SQL", async () => {
    estado.aplicar.mockRejectedValue(new Error('la relación "x" no existe'));

    expect(await correr("--apply")).toBe(1);

    const salida = errores.join("\n");
    expect(salida).toContain("Arreglá el SQL");
    expect(salida).not.toContain("El SQL no tiene la culpa");
  });
});
