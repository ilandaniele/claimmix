/**
 * Un timeout del proveedor dejaba al denunciante sin respuesta.
 *
 * Cadena: `AbortSignal.timeout(30s)` → `GeminiExtractionError{code:"TIMEOUT"}`
 * → `escalateCase(..., "provider_error")` → `status = 'escalado'`.
 *
 * Y `escalado` NO está en la lista de estados desde los que el worker puede
 * arrancar, ni lo barre `reap-stuck`, que sólo mira `procesando` y `recibido`.
 * O sea que treinta segundos de lentitud de Vertex exigían que una persona
 * tocara «Re-analizar».
 *
 * Se vio en el ensayo del post-deploy del 10/09: `choque-completo`, turno 4,
 * «esperaba 1 respuesta(s), hubo 0», dos corridas seguidas. El producto hizo lo
 * que estaba escrito; lo que estaba mal era lo escrito.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { esPasajero, GeminiExtractionError } from "@/server/ai/gemini-extractor";

const WORKER = readFileSync("src/server/worker/extract.ts", "utf8");
// El mismo predicado que usa el reconocedor de negativas: un solo criterio.
const REINTENTA = "if (esPasajero(err))";
const MIGRACION = readFileSync(
  "neon/migrations/0030_un_timeout_no_es_una_escalada.sql",
  "utf8"
);

describe("el reintento por timeout", () => {
  it.each([
    ["un TIMEOUT", new GeminiExtractionError("plazo", { code: "TIMEOUT" }), true],
    ["un 429", new GeminiExtractionError("cupo", { status: 429, code: "RESOURCE_EXHAUSTED" }), true],
    ["una conexión que no abrió", new GeminiExtractionError("red", { code: "ECONNRESET", red: true }), true],
    ["un 400", new GeminiExtractionError("400", { status: 400, code: "INVALID_ARGUMENT" }), false],
    ["un error que no es del proveedor", Object.assign(new Error("x"), { cause: { status: 429 } }), false],
  ])("sólo para TIMEOUT, 429 y red, no para cualquier error: %s", (_, err, pasajero) => {
    // Vertex es pospago sobre un cupo compartido y dinámico: un 429 es tan
    // transitorio como un TIMEOUT, con el mismo tope de por vida. Un socket
    // que no abrió tras los reintentos de transporte también. Un 400 sigue
    // escalando.
    expect(esPasajero(err)).toBe(pasajero);
    expect(WORKER).toContain(REINTENTA);
  });

  it("un 429 va a la cola, un 400 no", () => {
    const i = WORKER.indexOf(REINTENTA);
    const bloque = WORKER.slice(i, WORKER.indexOf("await escalateCase(", i));
    expect(bloque).not.toContain("400");
  });

  it("marca pendiente para que lo levante el barrido", () => {
    const fn = WORKER.slice(
      WORKER.indexOf("async function reintentarPorTimeout"),
      WORKER.indexOf("export async function runEmailExtractionWorker")
    );
    expect(fn).toContain("extraction_pending: true");
  });

  it("y el tope va en el WHERE, no en un if sobre lo leído", () => {
    /*
     * Leer el contador y después decidir son dos transacciones, y en el medio
     * entra otra corrida: las dos leen dos, las dos escriben tres, y el caso se
     * reintenta cuatro veces. Con el predicado adentro del UPDATE, la base
     * serializa y la fila devuelta dice si nos tocó.
     */
    const fn = WORKER.slice(
      WORKER.indexOf("async function reintentarPorTimeout"),
      WORKER.indexOf("export async function runEmailExtractionWorker")
    );
    expect(fn).toContain("lt(cases.intentos_de_extraccion, MAX_REINTENTOS_POR_TIMEOUT)");
    expect(fn).toContain("returning({ id: cases.id })");
  });

  it("con los intentos agotados sí escala", () => {
    // El control. Sin esto, un mensaje que agota el plazo SIEMPRE se
    // reintentaría en cada barrido, pagando una llamada cada vez.
    // Desde el if hacia adelante:  se DEFINE antes en el archivo,
    // así que buscarlo desde el principio da un tramo vacío.
    const i = WORKER.indexOf(REINTENTA);
    const bloque = WORKER.slice(i, WORKER.indexOf("await escalateCase(", i));
    expect(bloque).toContain("if (reintentado)");
    expect(bloque).toContain("return;");
  });

  it("y el tope es el mismo que el resto del repo usa para lo mismo", () => {
    expect(WORKER).toContain("MAX_REINTENTOS_POR_TIMEOUT = 3");
  });
});

describe("la migración 0030", () => {
  it("es aditiva y las filas viejas arrancan en cero", () => {
    expect(MIGRACION).toContain("ADD COLUMN IF NOT EXISTS");
    expect(MIGRACION).toContain("DEFAULT 0");
  });
});
