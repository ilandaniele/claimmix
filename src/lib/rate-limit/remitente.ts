/**
 * La clave del cupo de un remitente, sin el remitente en claro.
 *
 * Un teléfono o una dirección de mail es un dato personal, y `rate_limit_counters`
 * no tiene RLS por inquilino: la clave se guarda tal cual. Por eso va el hash
 * (sha256 de inquilino, canal y remitente, 32 hex) y no el remitente.
 *
 * La usan WhatsApp y el mail; una sola forma de armar la huella, como
 * `claveDeCupo` es la única forma de armar la clave.
 */
import { createHash } from "node:crypto";
import { claveDeCupo } from "./clave";

export function claveDelRemitente(
  ambito: "whatsapp" | "email",
  tenantId: string,
  channel: string,
  remitente: string
): string {
  const huella = createHash("sha256")
    .update(`${tenantId}:${channel}:${remitente}`)
    .digest("hex")
    .slice(0, 32);
  return claveDeCupo(ambito, huella);
}
