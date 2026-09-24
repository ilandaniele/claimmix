// @vitest-environment node
/**
 * `migrate.mjs --exigir-al-dia` corre después del deploy contra la base viva.
 *
 * Nació para el ensayo de CI, donde crear el ledger si faltaba no le hacía mal
 * a nadie. Tras el deploy de QA y de producción la misma línea sería un chequeo
 * que escribe en la base que está mirando, y además mentiroso: un ledger vacío
 * recién creado dice «todo pendiente» de una base que ya tiene todo.
 *
 * Se importa el script de verdad, con el driver falso y `process.exit` atajado,
 * para que lo probado sea lo que corre y no una copia de su lógica.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const estado = vi.hoisted(() => ({
  consultas: [] as string[],
  hayLedger: true,
  filas: [] as Array<Record<string, unknown>>,
  aplicar: vi.fn(),
}));

vi.mock("../../scripts/lib/db-driver.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/db-driver.mjs")>()),
  connect: async () => ({
    query: async (text: string) => {
      estado.consultas.push(text);
      if (/to_regclass/.test(text)) {
        return { rows: [{ t: estado.hayLedger ? "schema_migrations" : null }] };
      }
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

const ESCRITURA =
  /\b(create|alter|drop|insert|update|delete|truncate|grant)\b/i;
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
  process.argv = [
    argvOriginal[0],
    "migrate.mjs",
    "--url",
    "postgres://falsa",
    ...banderas,
  ];
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
  estado.hayLedger = true;
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

describe("migrate.mjs --exigir-al-dia", () => {
  it("con todas registradas sale 0", async () => {
    expect(await correr("--exigir-al-dia")).toBe(0);
    expect(estado.consultas.filter((q) => ESCRITURA.test(q))).toEqual([]);
    expect(estado.aplicar).not.toHaveBeenCalled();
  });

  it("con la última sin registrar sale 1 y no la aplica", async () => {
    estado.filas.pop();

    expect(await correr("--exigir-al-dia")).toBe(1);
    expect(errores.join("\n")).toContain("1 migración(es) sin aplicar");
    expect(estado.consultas.filter((q) => ESCRITURA.test(q))).toEqual([]);
    expect(estado.aplicar).not.toHaveBeenCalled();
  });

  it("sin ledger sale 1 sin crearlo: sólo pregunta si existe", async () => {
    estado.hayLedger = false;

    expect(await correr("--exigir-al-dia")).toBe(1);
    expect(errores.join("\n")).toContain("ledger ausente");
    expect(estado.consultas).toHaveLength(1);
    expect(estado.consultas[0]).toMatch(/to_regclass/);
    expect(estado.aplicar).not.toHaveBeenCalled();
  });

  // Sin esto el filtro de escrituras podría no atrapar nada y los tres de
  // arriba pasarían igual.
  it("sin la bandera sigue creando el ledger, y el filtro lo ve", async () => {
    expect(await correr()).toBe(0);
    expect(estado.consultas.filter((q) => ESCRITURA.test(q))).toHaveLength(1);
    expect(estado.consultas.some((q) => /to_regclass/.test(q))).toBe(false);
  });
});
