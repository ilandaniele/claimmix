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

/**
 * Las tres guardas del 10/09, con la misma pregunta: ¿miran algo?
 *
 * No es hipotética. La de «el inquilino no entra por el cuerpo» se mergeó con
 * un RETROCESO literal (0x08) donde iba `\b`, así que su expresión pedía un
 * carácter que no existe en ningún archivo: pasaba en verde sobre una ruta que
 * la violaba, y el diff se veía perfecto. Es exactamente el defecto que este
 * archivo vino a cerrar para las dos de arriba, cometido de nuevo.
 *
 * Cada guarda se prueba contra lo que TIENE que ver y contra lo que no. La
 * segunda mitad importa igual: una guarda demasiado ancha se apaga sola, porque
 * alguien la saca cuando da falsos positivos.
 */
describe("las tres guardas del 10/09", () => {
  const FUENTE = readFileSync("scripts/check-architecture.mjs", "utf8");

  /**
   * La expresión literal que hay en esa línea del script, tal cual está.
   *
   * Recortada con `indexOf` y no con otra expresión regular: escribir una
   * expresión que lea expresiones es donde se pierden las barras, que es
   * literalmente el bug que la tercera guarda vino a agarrar.
   */
  function expresionEnLaLineaCon(marca: string): RegExp {
    const linea = FUENTE.split("\n").find((l) => l.includes(marca));
    expect(linea, `no hay línea con ${marca}`).toBeTruthy();

    const abre = linea!.indexOf("/");
    const cierra = linea!.lastIndexOf("/");
    expect(cierra, `no hay expresión en: ${linea}`).toBeGreaterThan(abre);

    const cuerpo = linea!.slice(abre + 1, cierra);
    // Las banderas son lo que queda hasta el `.` o el `;` que siguen.
    const cola = linea!.slice(cierra + 1);
    const banderas = (/^[gimsuy]*/.exec(cola)?.[0] ?? "").replace("g", "");
    return new RegExp(cuerpo, banderas);
  }

  describe("el inquilino no entra por el cuerpo", () => {
    const enUnEsquema = expresionEnLaLineaCon("tenant_?[Ii]d:");

    it("ve las dos formas de escribirlo", () => {
      expect(enUnEsquema.test("  tenant_id: z.string().uuid(),")).toBe(true);
      expect(enUnEsquema.test('  tenantId: z.string().uuid("..."),')).toBe(true);
    });

    it("y NO marca un tenant_id que es una columna o una variable", () => {
      expect(enUnEsquema.test("  tenant_id: cases.tenant_id,")).toBe(false);
      expect(enUnEsquema.test("const tenantId = userRow.tenant_id;")).toBe(false);
    });
  });

  describe("nada anota por fuera del logger", () => {
    const esConsole = expresionEnLaLineaCon("const re = /console");

    it("ve los cinco métodos", () => {
      for (const m of ["error", "warn", "info", "log", "debug"]) {
        expect(esConsole.test(`console.${m}("hola")`)).toBe(true);
      }
    });

    it("y NO marca al logger ni a algo que se llame parecido", () => {
      expect(esConsole.test('logger.error({}, "x")')).toBe(false);
      expect(esConsole.test("consola.error()")).toBe(false);
    });
  });

  describe("ningún carácter de control invisible", () => {
    /*
     * La lista de códigos prohibidos, leída del script. Tiene que llevar el 8
     * —el retroceso— porque es el que se cuela al escribir un `\b`, y NO puede
     * llevar el 9, el 10 ni el 13, que son tabulación y saltos de línea.
     */
    const linea = FUENTE.split("\n").find((l) => l.includes("const PROHIBIDOS"));
    const codigos = (linea!.match(/\d+/g) ?? []).map(Number);

    it("incluye el retroceso, que es el que se cuela", () => {
      expect(codigos).toContain(8);
    });

    it("y NO incluye tabulación ni saltos de línea", () => {
      // Si los incluyera, marcaría cada archivo del repo y alguien la sacaría.
      for (const legitimo of [9, 10, 13]) expect(codigos).not.toContain(legitimo);
    });
  });
});
