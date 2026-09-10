/**
 * Un re-despacho que no llega deja el mensaje sin leer y sin nada que lo recuerde.
 *
 * Cuando llega un mensaje a mitad de una corrida, la que corre marca el caso como
 * pendiente y la que termina lo re-despacha por HTTP. Pero para cuando el POST
 * sale, la bandera `extraction_pending` YA se limpió: `releaseExtractionLease` la
 * lee y la borra en la misma transacción.
 *
 * Y el `fetch` no miraba la respuesta. No hace falta que se caiga la red: un
 * despliegue sin `NEXT_PUBLIC_APP_URL` cae a `https://${VERCEL_URL}`, que está
 * detrás de Deployment Protection y contesta una pantalla de SSO con 401 — un
 * `fetch` perfectamente exitoso que no llegó a ningún handler. Sin mirar el
 * código, es indistinguible de haber funcionado.
 *
 * Resultado: la persona manda «sí, confirmo» y «el DNI es 30.111.222» con un
 * segundo de diferencia, y el segundo no lo lee nadie nunca.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

const FUENTE = readFileSync("src/server/worker/extract.ts", "utf8");

describe("el re-despacho mira si llegó", () => {
  it("comprueba el código de la respuesta, no sólo que el fetch no tire", () => {
    expect(FUENTE).toContain("res.ok");
  });

  it("y cuando no llegó, vuelve a marcar el caso como pendiente", () => {
    /*
     * Es lo que hace que el mensaje no se pierda: la marca la recupera la
     * próxima corrida del worker sobre ese caso —el siguiente mensaje de esa
     * persona— que es el camino que ya existe.
     */
    expect(FUENTE).toContain("email_worker.redespacho_no_llego");
    expect(FUENTE).toContain("extraction_pending: true");
  });

  it("el aviso es de nivel error, no una línea más del log", () => {
    // El nivel era un campo del objeto (`level: "error"`) y ahora es el método
    // del logger, así que queda ANTES del nombre del evento y no adentro.
    const i = FUENTE.indexOf('"email_worker.redespacho_no_llego"');
    expect(i).toBeGreaterThan(-1);
    const alrededor = FUENTE.slice(Math.max(0, i - 400), i);
    expect(alrededor).toContain("logger.error(");
  });
});

describe("y cuando SÍ llega, no toca nada", () => {
  it("hay un camino de salida temprana para el caso bueno", () => {
    /*
     * El control. Una versión que remarcara siempre dejaría todos los casos
     * pendientes para siempre, y cada corrida re-despacharía la anterior: el
     * arreglo se convierte en un bucle.
     */
    expect(FUENTE).toContain("if (llegó) return;");
  });
});

describe("y no se paga con el tiempo de la corrida que lo lanza", () => {
  /*
   * `POST /api/worker/extract` no es un aviso: corre la extracción ENTERA y
   * recién ahí contesta, y acá se la espera. La corrida hija sale del tiempo
   * que le quede a la invocación de la madre.
   *
   * Dos corridas de 10-20 s adentro de una función de 60 s entran; tres no. Y
   * la cadena no tiene tope: cada mensaje que llega a mitad de corrida agrega
   * un eslabón, todos anidados en la misma invocación. Cuando se acaba el
   * tiempo mueren todas juntas, la de más adentro a mitad de una escritura.
   */
  it("recibe cuánto queda, no lo adivina", () => {
    expect(FUENTE).toContain("restanteMs: number");
    expect(FUENTE).toContain("redispatchExtraction(caseId, tenantId, tenantCtx, restanteMs())");
  });

  it("por debajo del piso ni lo intenta", () => {
    expect(FUENTE).toContain("restanteMs < MINIMO_PARA_REDESPACHAR_MS");
  });

  it("y si contesta tarde, tampoco lo espera para siempre", () => {
    expect(FUENTE).toContain("AbortSignal.timeout(restanteMs)");
  });

  it("las dos salidas caen en el mismo camino que ya existía", () => {
    // Ni el piso ni el plazo inventan una recuperación nueva: dejan `llegó` en
    // false y siguen por donde ya sale el redespacho que no llegó.
    const i = FUENTE.indexOf("if (llegó) return;");
    const antes = FUENTE.slice(0, i);
    expect(antes).toContain("sin_tiempo_");
  });
});
