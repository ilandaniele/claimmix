/**
 * Cuatro guardas que, al fallar, hacían justo lo que existían para impedir.
 *
 * No es que no cubrieran un caso: es que en el caso que cubrían, la salida
 * elegida producía el daño. Una guarda así es peor que no tenerla, porque
 * además convence.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * El archivo SIN comentarios.
 *
 * Estas afirmaciones son sobre el código, y los comentarios de un arreglo citan
 * el código viejo para explicar qué se cambió — así que buscar la cita choca
 * con la explicación. Ya pasó en este repo con el `slice` del barrido de
 * abandonados; ahí se resolvió buscando otra cadena, acá se resuelve mirando
 * sólo lo que corre.
 */
function soloCodigo(ruta: string): string {
  return readFileSync(ruta, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ 	]*\/\/.*$/gm, "");
}

const AUTH = soloCodigo("src/lib/auth/index.ts");
const WORKER = soloCodigo("src/server/worker/extract.ts");
const INTAKE = soloCodigo("src/server/agents/intake-agent.ts");
const ENV = readFileSync(".env.example", "utf8");

describe("el secreto de sesión no puede faltar", () => {
  /*
   * `secret: process.env.BETTER_AUTH_SECRET` a secas era un fallo abierto:
   * better-auth no rompe si falta, usa un secreto de relleno publicado en su
   * propio código y avisa por consola. Con ese secreto se firman cookies
   * válidas, y el inquilino sale de la sesión: la capa de datos las sirve
   * obedientemente.
   */
  it("no se pasa la variable cruda a betterAuth", () => {
    expect(AUTH).not.toContain("secret: process.env.BETTER_AUTH_SECRET");
  });

  it("y el que la exige tira, no devuelve un valor por omisión", () => {
    const fn = AUTH.slice(
      AUTH.indexOf("function exigirSecreto"),
      AUTH.indexOf("export const auth")
    );
    expect(fn).toContain("throw new Error");
    expect(fn).not.toMatch(/return\s+"/);
  });
});

describe("la reserva de extracción", () => {
  /*
   * El `catch` devolvía `true` con el argumento correcto —«correr dos veces es
   * el bug que arreglamos, no correr es peor»— y la salida equivocada: quien
   * llama marcaba la reserva como tomada, y el `finally` después liberaba una
   * que esta corrida nunca tomó. Le rompía el lock al que sí lo tenía y le
   * borraba su marca de mensaje pendiente.
   */
  it("tiene tres respuestas, no dos", () => {
    expect(WORKER).toContain('"tomada" | "ocupada" | "no_se_pudo"');
  });

  it("y el error no dice que la tomó", () => {
    const acquire = WORKER.slice(
      WORKER.indexOf("async function acquireExtractionLease"),
      WORKER.indexOf("async function releaseExtractionLease")
    );
    const catchBlock = acquire.slice(acquire.lastIndexOf("} catch"));
    expect(catchBlock).toContain('return "no_se_pudo"');
    expect(catchBlock).not.toContain("return true");
  });

  it("y sólo se marca como retenida cuando de verdad se tomó", () => {
    // El control: `leaseHeld = true` a secas después de la llamada devolvería
    // el bug entero, con los tres estados puestos y todo.
    expect(WORKER).toContain('leaseHeld = reserva === "tomada"');
  });
});

describe("buscar un caso abierto", () => {
  /*
   * «No encontré» y «no pude buscar» devolvían los dos `null`, y arriba el
   * `null` significa «no hay caso para este teléfono»: se abría uno nuevo. Un
   * hipo de Neon terminaba en dos conversaciones sobre el mismo choque.
   */
  it("un error de base no se disfraza de 'no hay caso'", () => {
    const fn = INTAKE.slice(
      INTAKE.indexOf("async function findExistingWhatsAppCase"),
      INTAKE.indexOf("async function casoRecienAbierto")
    );
    expect(fn).toContain("whatsapp_case_lookup_failed");
    expect(fn).toContain("whatsapp.busqueda_de_caso_fallo");
  });
});

describe("la plantilla de variables", () => {
  it("no fuerza el limitador a memoria", () => {
    /*
     * `RATE_LIMIT_PROVIDER=memory` gana sobre la detección automática. Sembrar
     * Vercel desde esta plantilla dejaba el tope del login contando en memoria:
     * en serverless, cada instancia arranca con su mapa vacío.
     */
    expect(ENV).not.toMatch(/^RATE_LIMIT_PROVIDER=memory$/m);
    expect(ENV).toMatch(/^RATE_LIMIT_PROVIDER=$/m);
  });
});
