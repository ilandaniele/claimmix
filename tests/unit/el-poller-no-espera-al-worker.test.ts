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

/*
 * Normalizado, porque el archivo llega con CRLF en Windows y con LF en el
 * checkout de CI. Una afirmación sobre el texto no puede depender de eso: la
 * primera versión de esta prueba pasaba acá y fallaba en CI por ese motivo.
 */
const FUENTE = readFileSync("src/server/email/gmail/gmail-poller.ts", "utf8").replace(
  /\r\n/g,
  "\n"
);

describe("el poller no espera al worker", () => {
  it("dispara con after() en vez de esperar la respuesta", () => {
    expect(FUENTE).toContain("after(() => llamarAlWorker(caseId, tenantId));");
  });

  it("y el único await al worker es el del respaldo", () => {
    /*
     * La primera versión de esta prueba prohibía `await llamarAlWorker` a
     * secas, y estaba mal en dos sentidos: dependía de los finales de línea
     * —pasaba en Windows y fallaba en CI— y prohibía justamente el respaldo
     * que el cambio agrega a propósito.
     *
     * Lo que hay que fijar es el ORDEN: primero se agenda con `after()`, y
     * el `await` sólo aparece después, adentro del `catch`. Así se ve la
     * diferencia entre el respaldo y una vuelta atrás.
     */
    const cuerpo = FUENTE.slice(
      FUENTE.indexOf("async function dispatchExtractionWorker"),
      FUENTE.indexOf("async function llamarAlWorker")
    );

    expect(cuerpo).toMatch(
      /after\(\(\) => llamarAlWorker\([^)]*\)\);\s*\}\s*catch\s*\{\s*await llamarAlWorker\(/
    );

    // Y una sola vez cada uno: nada de esperarlo además de agendarlo.
    expect(cuerpo.split("await llamarAlWorker(").length - 1).toBe(1);
    expect(cuerpo.split("after(() => llamarAlWorker(").length - 1).toBe(1);
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
