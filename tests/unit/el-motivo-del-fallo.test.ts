/**
 * Ciento quince fallos con el mismo motivo.
 *
 * En producción, entre el 24 y el 28 de junio de 2026, `audit_log` tiene 115
 * eventos `email.outbound_failed` con el payload IDÉNTICO —los 115 con
 * `{"error": "GMAIL_SEND_FAILED"}`— contra 195 enviados.
 *
 * Ciento quince personas que denunciaron un siniestro y no recibieron respuesta
 * durante cuatro días. Y de por qué no queda nada: los `console.error` de esos
 * días ya no existen, que la retención de Hobby es de una hora. Ese incidente
 * hoy es irreconstruible, y el código que lo hizo irreconstruible era el mismo.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const GMAIL = readFileSync("src/server/email/gmail/gmail-sender.ts", "utf8");
const WHATSAPP = readFileSync("src/server/confirmations/messenger.ts", "utf8");

describe("el emisor de Gmail", () => {
  it("devuelve el código de Google, no una constante", () => {
    /*
     * `err.name` para un error de `googleapis` es siempre «GaxiosError» o
     * «Error». El 401 (token revocado), el 403 (cuota), el 429 (tope de Gmail),
     * el 400 (destinatario inválido) y un ECONNRESET daban la misma fila.
     */
    expect(GMAIL).toContain("`GMAIL_${status}`");
  });

  it("y lo busca en los tres lugares donde googleapis lo pone", () => {
    const fn = GMAIL.slice(GMAIL.indexOf("function errorStatus"), GMAIL.indexOf("export class GmailSender"));
    expect(fn).toContain("e?.status");
    expect(fn).toContain("e?.response?.status");
    expect(fn).toContain("e?.code");
  });

  it("sin el status sigue habiendo un valor, no undefined", () => {
    // El control: un `errorCode` vacío rompería la fila de auditoría, que es
    // justamente lo único que sobrevive a la retención de Hobby.
    expect(GMAIL).toContain(': "GMAIL_SEND_FAILED"');
  });

  it("y no loguea nada del mensaje ni de la credencial", () => {
    const bloque = GMAIL.slice(GMAIL.indexOf("gmail_sender.send_failed") - 400, GMAIL.indexOf("gmail_sender.send_failed") + 400);
    for (const prohibido of ["requestBody", "raw", "to_addr", "accessToken", "refresh"]) {
      expect(bloque, prohibido).not.toContain(prohibido);
    }
  });
});

describe("el mensajero de WhatsApp", () => {
  it("guarda el motivo que sendWhatsAppText le devuelve", () => {
    // `{ ok: false, error: "Cloud API 400: {…}" }` con el cuerpo de Meta
    // adentro, y se descartaba. Acá el valor ya estaba en la mano.
    expect(WHATSAPP).toContain("res.error.slice(0, 200)");
  });

  it("y sólo cuando falló", () => {
    // El control: pegarlo siempre metería el cuerpo de Meta en cada línea de
    // éxito, y ahí adentro va el texto del mensaje que le mandamos a la persona.
    expect(WHATSAPP).toContain("res.ok || !res.error ? {} :");
  });
});
