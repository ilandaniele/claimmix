import { createHmac } from "node:crypto";

/**
 * HMAC-SHA256 en hex sobre `${ts}.${body}`. El ts entra en lo firmado para que
 * un pedido capturado no se pueda reenviar con otra hora; el receptor lo
 * verifica con `docs/entrega-al-core/verificar-firma.mjs`.
 */
export function firmar(secreto: string, ts: number, body: string): string {
  return createHmac("sha256", secreto).update(`${ts}.${body}`).digest("hex");
}

export function encabezadoDeFirma(ts: number, firma: string): string {
  return `t=${ts},v1=${firma}`;
}
