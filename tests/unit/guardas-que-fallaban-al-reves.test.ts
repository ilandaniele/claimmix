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
const INSTR = soloCodigo("instrumentation.ts");
/** La llamada a `betterAuth`, para comprobar que la aserción NO vive ahí. */
const SOLO_CODIGO_AUTH_CONFIG = AUTH.slice(AUTH.indexOf("export const auth"));

describe("el secreto de sesión no puede faltar", () => {
  /*
   * `secret: process.env.BETTER_AUTH_SECRET` a secas era un fallo abierto:
   * better-auth no rompe si falta, usa un secreto de relleno publicado en su
   * propio código y avisa por consola. Con ese secreto se firman cookies
   * válidas, y el inquilino sale de la sesión: la capa de datos las sirve
   * obedientemente.
   */
  it("hay quien la exija, y tira en vez de devolver algo", () => {
    const fn = AUTH.slice(
      AUTH.indexOf("export function exigirSecretoDeSesion"),
      AUTH.indexOf("export const auth")
    );
    expect(fn).toContain("throw new Error");
    // Nada de devolver un valor por omisión: el punto es que no haya uno.
    expect(fn).not.toMatch(/return\s+"/);
  });

  it("y se exige al arrancar el servidor, no al cargar el módulo", () => {
    /*
     * Al cargar el módulo fue el primer intento y rompió el deploy: `next
     * build` importa `@/lib/auth` para juntar la configuración de las rutas, y
     * en esa etapa la variable no está. El error decía «Failed to collect page
     * data for /api/admin/gmail-accounts/callback», que no se parece en nada.
     *
     * Es un requisito de ejecución. `register()` corre una vez por arranque y
     * no durante el build.
     */
    expect(INSTR).toContain("exigirSecretoDeSesion");
    expect(SOLO_CODIGO_AUTH_CONFIG).not.toContain("exigirSecretoDeSesion()");
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
