/**
 * La reserva se tomaba y `extraction_pending` quedaba como estaba.
 *
 * Finding (a) del mapa: al tomar una reserva vencida, el UPDATE original
 * sólo tocaba `extraction_lease_at`. Si la corrida anterior había marcado
 * pendiente y murió sin liberarla, esa marca sobrevivía a la retoma —aunque
 * nada nuevo hubiera llegado mientras corría—, y al liberar disparaba un
 * rerun entero de más. Ahora las tres formas de tomarla limpian la marca en
 * el mismo UPDATE que la toma.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const WORKER = readFileSync("src/server/worker/extract.ts", "utf8");

const ACQUIRE = WORKER.slice(
  WORKER.indexOf("async function acquireExtractionLease"),
  WORKER.indexOf("async function releaseExtractionLease")
);

describe("la reserva limpia la marca al tomarla", () => {
  it("todas las formas de tomarla ponen extraction_pending: false", () => {
    expect(ACQUIRE).toContain("extraction_pending: false");
  });

  it("distingue la heredada de una corrida muerta, con el filtro sobre la marca", () => {
    expect(ACQUIRE).toContain('"heredada"');
    expect(ACQUIRE).toContain("eq(cases.extraction_pending, false)");
  });

  it("el barrido (retoma) no remarca una reserva que sigue viva", () => {
    expect(ACQUIRE).toContain("email_worker.retoma_ya_tomada");
  });
});

describe("la liberación sigue limpiando la reserva", () => {
  it("todavía deja el lease en null al soltarla", () => {
    const release = WORKER.slice(
      WORKER.indexOf("async function releaseExtractionLease"),
      WORKER.indexOf("async function redispatchExtraction")
    );
    expect(release).toContain("extraction_lease_at: null");
  });
});
