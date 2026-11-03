/**
 * Borrar a una persona (DELETE /api/admin/users/:id/cuenta) sólo conserva el
 * historial si toda clave foránea hacia `users` o `"user"` es CASCADE (lo que es
 * sólo de ella) o SET NULL (el historial). Una FK sin ON DELETE, o con RESTRICT,
 * frenaría el borrado con 23503; una CASCADE de más borraría historial.
 *
 * Este test lee las migraciones: si una nueva agrega una FK a la persona, obliga a
 * decidir acá qué pasa con esa fila cuando la persona se borra.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CARPETA = join(process.cwd(), "neon", "migrations");

/** `REFERENCES users(id) …` o `REFERENCES "user"(id) …`, con lo que sigue hasta la coma, el punto y coma o el cierre. */
const REFERENCIA = /references\s+(?:public\.)?"?(users|user)"?\s*\(\s*id\s*\)([^,;)]*)/gi;

interface Fk {
  migracion: string;
  hacia: string;
  accion: string;
}

const fks: Fk[] = readdirSync(CARPETA)
  .filter((nombre) => nombre.endsWith(".sql"))
  .flatMap((nombre) => {
    // Sin los comentarios: uno que nombre "REFERENCES users(id)" no es una clave foránea.
    const sql = readFileSync(join(CARPETA, nombre), "utf8").replace(/--[^\n]*/g, "");
    return [...sql.matchAll(REFERENCIA)].map((m) => ({
      migracion: nombre,
      hacia: m[1].toLowerCase(),
      accion: (/on\s+delete\s+(cascade|set\s+null)/i.exec(m[2])?.[1] ?? "SIN ACCIÓN").toLowerCase().replace(/\s+/g, " "),
    }));
  });

describe("las claves foráneas hacia la persona", () => {
  it("encuentra las FK de las migraciones", () => {
    expect(fks.length).toBeGreaterThan(10);
  });

  it("todas son ON DELETE CASCADE o ON DELETE SET NULL: ninguna frena el borrado", () => {
    const sueltas = fks.filter((fk) => fk.accion === "sin acción");

    expect(sueltas).toEqual([]);
  });

  it("sólo cinco son CASCADE: las cuentas de Better Auth, el perfil y lo que es sólo de la persona", () => {
    const cascadas = fks
      .filter((fk) => fk.accion === "cascade")
      .map((fk) => `${fk.migracion}:${fk.hacia}`)
      .sort();

    expect(cascadas).toEqual([
      "0001_init.sql:user",
      "0001_init.sql:user",
      "0001_init.sql:user",
      "0003_user_ai_settings.sql:users",
      "0043_asistente_y_desvios.sql:users",
    ]);
  });

  it("el historial (casos, auditoría, aprobaciones) es SET NULL", () => {
    const aNulo = fks.filter((fk) => fk.accion === "set null" && fk.hacia === "users");

    expect(aNulo.length).toBeGreaterThanOrEqual(15);
  });
});

/**
 * `audit_log.actor_id` nulo es lo que distingue al agente de una persona. Si el
 * borrado de una cuenta lo pusiera en NULL en filas de caso, sus intervenciones
 * pasarían por trabajo del agente, y por eso el borrado espera con `casoQueRetiene`.
 * Una consulta nueva que lea el nulo así tiene que sumarse acá, después de revisar
 * que esa guarda la cubra.
 */
describe("lo que lee un actor_id nulo como «lo hizo el agente»", () => {
  const LEE_ACTOR_NULO = /actor_id\s+is\s+(?:not\s+)?null|(?:isNotNull|isNull)\(\s*\w+\.actor_id/i;
  const SRC = join(process.cwd(), "src");

  it("sólo lo hacen las cuatro consultas de caso que cubre la guarda del borrado", () => {
    const archivos = (readdirSync(SRC, { recursive: true }) as string[])
      .map((ruta) => ruta.split("\\").join("/"))
      .filter((ruta) => /\.tsx?$/.test(ruta) && !ruta.endsWith("plantilla.generated.ts"))
      .filter((ruta) => LEE_ACTOR_NULO.test(readFileSync(join(SRC, ruta), "utf8")))
      .sort();

    expect(archivos).toEqual([
      "server/cases/auditoria-si-quedo.ts",
      "server/cases/devolver-al-agente.ts",
      "server/desvios/revision-nocturna.ts",
      "server/metrics/trayecto.ts",
    ]);
  });
});
