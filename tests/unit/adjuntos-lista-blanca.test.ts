/**
 * Que la deduplicación no sea una puerta de atrás a la lista blanca.
 *
 * ── Qué se podía hacer ──────────────────────────────────────────────────────
 *
 * El orden era: calcular el hash → buscar una copia ya guardada → si la hay,
 * devolver «guardado» → y RECIÉN DESPUÉS validar el tipo.
 *
 * Con eso, alguien mandaba primero un PDF —que pasa la lista blanca— y después
 * los MISMOS bytes declarando `application/x-msdownload`. El hash coincide, la
 * deduplicación contesta que sí, y la fila queda escrita como guardada con un
 * tipo que la lista blanca nunca vio.
 *
 * La deduplicación es una optimización; la lista blanca es una regla. Una
 * optimización no puede saltearse una regla, y el orden de las dos líneas era
 * la única diferencia.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockEnTenant, mockSubir } = vi.hoisted(() => ({
  mockEnTenant: vi.fn(),
  mockSubir: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => ({ enTenant: mockEnTenant }));

import { validateAttachment } from "@/server/email/attachment-validator";

describe("la lista blanca de tipos", () => {
  it("acepta lo que el producto espera recibir", () => {
    expect(validateAttachment("application/pdf", 1000).ok).toBe(true);
    expect(validateAttachment("image/jpeg", 1000).ok).toBe(true);
  });

  it("rechaza un ejecutable", () => {
    const r = validateAttachment("application/x-msdownload", 1000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("content_type_not_allowed");
  });

  it("rechaza HTML: un adjunto no es una página", () => {
    expect(validateAttachment("text/html", 1000).ok).toBe(false);
  });

  it("rechaza SVG, que es XML con script adentro", () => {
    expect(validateAttachment("image/svg+xml", 1000).ok).toBe(false);
  });
});

/*
 * El orden en el código, leído del archivo.
 *
 * Probar el bypass de verdad pide levantar el rehost entero con almacenamiento
 * y base simulados. Lo que de verdad se rompió acá es UNA cosa —cuál de las dos
 * líneas va primero— y eso se puede afirmar directamente sobre el texto, sin
 * montar media aplicación para comprobar un orden.
 *
 * Es un test de forma, y se declara como tal: si mañana el archivo se
 * reescribe, hay que rehacerlo. A cambio, falla el día que alguien mueva la
 * deduplicación arriba de la validación, que es exactamente lo que pasó.
 */
describe("el orden: validar antes de deduplicar", () => {
  let fuente = "";

  beforeEach(async () => {
    const { readFileSync } = await import("node:fs");
    fuente = readFileSync("src/server/email/rehost-attachments.ts", "utf8");
  });

  it("la validación del tipo va antes de la búsqueda por hash", () => {
    // Se buscan las LLAMADAS, no las definiciones: `findExistingByHash` está
    // definida arriba del bucle, y mirar su primera aparición daba un orden que
    // no es el que corre. (Mi primera versión de este test se equivocó así.)
    const validar = fuente.indexOf("validateAttachment(attachment.ContentType");
    const deduplicar = fuente.indexOf("await findExistingByHash(");

    expect(validar).toBeGreaterThan(-1);
    expect(deduplicar).toBeGreaterThan(-1);
    expect(validar).toBeLessThan(deduplicar);
  });

  it("y el `continue` del rechazo también, o validar no serviría de nada", () => {
    // Validar arriba pero seguir de largo sin cortar dejaría el mismo agujero.
    const validar = fuente.indexOf("validateAttachment(attachment.ContentType");
    const corte = fuente.indexOf("reason: validation.reason", validar);
    const deduplicar = fuente.indexOf("await findExistingByHash(");

    expect(corte).toBeGreaterThan(validar);
    expect(corte).toBeLessThan(deduplicar);
  });
});
