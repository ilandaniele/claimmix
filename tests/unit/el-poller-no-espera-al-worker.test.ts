/**
 * El poller larga la extracción y sigue.
 *
 * ── Qué costaba esperarla ──────────────────────────────────────────────────
 *
 * `/api/worker/extract` corre `runIntakeAgent` entero y recién ahí contesta, y
 * tiene su propio techo de 60 s. El poller lo esperaba con `await fetch`, o sea
 * que gastaba SU techo de 60 s en el trabajo del otro. Los dos se morían
 * juntos.
 *
 * Pasó el 2026-09-08 con el correo del timbre: el poller devolvió 504 a los
 * sesenta segundos exactos, y el caso quedó con los campos extraídos y sin un
 * solo evento después de `intake.agent_decision` — al asegurado no le contestó
 * nadie. Por WhatsApp, que ya usaba `after()`, el mismo minuto anduvo bien.
 *
 * El encabezado de `gmail-poller.ts` dice «fire-and-forget» desde siempre. Lo
 * que faltaba era que el código lo hiciera.
 *
 * ── Qué fija esta prueba ───────────────────────────────────────────────────
 *
 * Que el disparo siga siendo un disparo. Es una afirmación sobre el texto del
 * archivo y no sobre su comportamiento, y eso es a propósito: lo que hay que
 * impedir es que alguien vuelva a poner el `await` delante del `fetch`, y eso
 * se ve leyendo. Comprobar el comportamiento pediría levantar un pedido de
 * Next entero para que `after()` no tire, que es mucho armado para vigilar una
 * palabra.
 *
 * La otra mitad —que fuera de un pedido `after()` tira y por eso el respaldo
 * espera como antes— está comprobada abajo, y esa sí es de comportamiento.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FUENTE = readFileSync("src/server/email/gmail/gmail-poller.ts", "utf8");

describe("el poller no espera al worker", () => {
  it("dispara con after() en vez de esperar la respuesta", () => {
    expect(FUENTE).toContain("after(() => llamarAlWorker(caseId, tenantId));");
  });

  it("y no quedó ningún await sobre el fetch del worker", () => {
    // El `await fetch(...)` de adentro de `llamarAlWorker` es correcto: ahí
    // ya estamos del otro lado de `after()`. Lo que no puede volver es que
    // `dispatchExtractionWorker` espere a `llamarAlWorker`.
    const cuerpo = FUENTE.slice(
      FUENTE.indexOf("async function dispatchExtractionWorker"),
      FUENTE.indexOf("async function llamarAlWorker")
    );
    expect(cuerpo).not.toContain("await llamarAlWorker(caseId, tenantId);\n  }\n}");
    expect(cuerpo).toContain("after(");
  });

  it("el encabezado del archivo ya prometía esto", () => {
    // Si alguien saca la promesa del encabezado, esta prueba deja de tener
    // sentido y hay que revisarla en vez de borrarla.
    expect(FUENTE).toContain("Fire extraction worker (fire-and-forget)");
  });
});

describe("el respaldo, para pruebas y guiones", () => {
  it("fuera de un pedido after() tira, así que se espera como antes", async () => {
    // Es lo que quiere una prueba: que al volver de la llamada el trabajo esté
    // hecho. Y es lo que hace que la suite de gmail siga pasando sin cambios.
    const { after } = await import("next/server");

    let corrio = false;
    let tiro = false;
    try {
      after(() => {
        corrio = true;
      });
    } catch {
      tiro = true;
    }

    expect(tiro).toBe(true);
    expect(corrio).toBe(false);
  });
});
