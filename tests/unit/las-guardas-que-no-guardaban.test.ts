/**
 * Dos guardas que imprimían un tilde sin mirar nada.
 *
 * Las dos son de esta semana y las dos vinieron a cerrar una clase de bug. Y las
 * dos salían en verde por construcción: una porque su expresión no matchea el
 * estilo en que este repo escribe, y la otra porque el tipo que usa para eximir
 * era el mismo que el que quería excluir.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("enTenant no se anida", () => {
  /*
   * `enTenant(ctx, (db) => enTenant(ctx, (db) => …))` compila y revienta en
   * tiempo de ejecución SIEMPRE: la capa rechaza una promesa donde espera una
   * consulta. Ya rompió el PATCH y el DELETE de las casillas de Gmail — un
   * admin no podía desconectar una casilla comprometida.
   *
   * La guarda que se agregó para que no volviera usaba `[^)]*?`, que no puede
   * cruzar el `)` de `(db)`. O sea que no veía la forma que causó el bug.
   */
  const FUENTE = readFileSync("scripts/check-architecture.mjs", "utf8");
  const anidaEnTenant = (() => {
    const i = FUENTE.indexOf("function anidaEnTenant");
    const j = FUENTE.indexOf("\n}", FUENTE.indexOf("return false;", i)) + 2;
    // eslint-disable-next-line no-eval
    return eval(`(${FUENTE.slice(i, j).replace("function anidaEnTenant", "function")})`) as (
      txt: string
    ) => boolean;
  })();

  it("ve el estilo en que este repo escribe — el que causó el bug", () => {
    expect(anidaEnTenant("enTenant(ctx, (db) =>\n  enTenant(ctx, (db) => db.select()))")).toBe(true);
  });

  it("y las otras tres formas de escribir lo mismo", () => {
    expect(anidaEnTenant("enTenant(ctx, db => enTenant(ctx, db => x))")).toBe(true);
    expect(anidaEnTenant("enTenant(ctx, async (db) => enTenant(ctx, (db) => x))")).toBe(true);
    expect(anidaEnTenant("enTenantVarias<[A,B]>(ctx, (db) => [enTenant(ctx, (db) => x)])")).toBe(true);
  });

  it("y NO marca dos llamadas hermanas", () => {
    // El control. Una guarda demasiado ancha se apaga sola: alguien la saca
    // porque da falsos positivos, y volvemos al principio.
    expect(
      anidaEnTenant(
        "await enTenant(ctx, (db) => db.select());\nawait enTenant(ctx, (db) => db.update());"
      )
    ).toBe(false);
  });
});

describe("ClienteDatos es de la capa, no cualquier db", () => {
  /*
   * Era `ReturnType<typeof crearCliente>` a secas: el mismo tipo estructural
   * que el `db` de `@/lib/db`, que corre con el rol dueño y saltea RLS.
   *
   * Con los dos iguales, `consultaPromptRules(db)` compilaba, devolvía las filas
   * de TODOS los inquilinos, y pasaba los dos chequeos requeridos de `main`: la
   * guarda de consultas crudas exime el cuerpo de un armador, y una llamada a un
   * armador no se parece a `db.select(`.
   *
   * Y el identificador que hacía falta para equivocarse estaba importado y sin
   * usar en los cinco archivos donde equivocarse era más fácil.
   */
  const SCOPE = readFileSync("src/data/scope.ts", "utf8");

  it("el tipo lleva una marca que sólo pone la capa", () => {
    expect(SCOPE).toContain("unique symbol");
    expect(SCOPE).toMatch(/export type ClienteDatos =[\s\S]*marcaDeLaCapa/);
  });

  it("y la marca se pone en un solo lugar", () => {
    const casts = SCOPE.split("as ClienteDatos").length - 1;
    expect(casts).toBe(1);
  });

  it("los cinco armadores ya no importan el db del rol dueño", () => {
    for (const ruta of [
      "src/server/training/examples.ts",
      "src/server/training/prompt-rules.ts",
      "src/server/training/custom-fields.ts",
      "src/server/training/prompt-version.ts",
      "src/server/agents/training.ts",
    ]) {
      const txt = readFileSync(ruta, "utf8");
      expect(txt, ruta).not.toMatch(/import \{[^}]*\bdb\b[^}]*\} from "@\/lib\/db"/);
    }
  });
});
