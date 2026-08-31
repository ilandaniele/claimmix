/**
 * De dónde sale el correo de quien mandó el siniestro.
 *
 * Es la CLAVE de `claim_memory`: sin remitente no se actualiza la memoria y el
 * producto no aprende nada de esa confirmación. `confirm-field` lo leía con su
 * propia consulta a `raw_messages`, y en el canal de correo REAL esa tabla puede
 * no tener ni una fila — el poller de Gmail guarda en `claim_messages`.
 *
 * O sea: un producto que dice aprender de cada confirmación y no aprendía de
 * ninguna, sin fallar ni una vez. La consulta devolvía cero filas, que es
 * indistinguible de «este caso no tiene remitente».
 *
 * ── Qué prueba este archivo, y qué no ───────────────────────────────────────
 *
 * La CASCADA —`raw_messages` primero, `claim_messages` de respaldo— ya está
 * probada de verdad en `inbound-messages.test.ts`, con las dos consultas
 * capturadas. Acá se pincha lo otro: que `confirm-field` la USE en vez de tener
 * su propia copia.
 *
 * Es una afirmación sobre el código fuente y no sobre el comportamiento, y lo
 * digo en lugar de disfrazarlo: montar `resolveFieldConfirmation` entera —caso,
 * confirmación, upsert, auditoría, re-evaluación de estado— para llegar a una
 * línea pediría más andamio que producto. Lo que este test impide es lo que
 * efectivamente pasó: que alguien vuelva a escribir la consulta a mano.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const FUENTE = readFileSync("src/server/cases/confirm-field.ts", "utf8");

describe("confirm-field lee el remitente por la cascada compartida", () => {
  it("usa `mensajesEntrantes`", () => {
    expect(FUENTE).toContain("mensajesEntrantes(ctx, caseId");
  });

  it("y NO vuelve a consultar `raw_messages` por su cuenta", () => {
    /*
     * La consulta vieja era:
     *
     *   .select({ from_addr: rawMessages.from_addr })
     *   .from(rawMessages)
     *
     * Cualquier `from(rawMessages)` en este archivo es esa copia volviendo.
     */
    expect(FUENTE).not.toContain("from(rawMessages)");
  });

  it("pide el más VIEJO, que es quien abrió el caso", () => {
    // El último mensaje puede ser de otra persona del mismo hilo; la memoria se
    // indexa por quien lo abrió.
    expect(FUENTE).toContain('orden: "viejos"');
  });
});
