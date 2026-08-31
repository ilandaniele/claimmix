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
    const i = FUENTE.indexOf("email_worker.redespacho_no_llego");
    const alrededor = FUENTE.slice(Math.max(0, i - 200), i);
    expect(alrededor).toContain('level: "error"');
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
