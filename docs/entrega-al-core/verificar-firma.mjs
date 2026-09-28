// Verificación de la firma de ClaimMix del lado del receptor. Node puro, sin
// dependencias: copiá este archivo tal cual. Los tests de ClaimMix lo importan,
// así que si la firma cambia, este ejemplo cambia con ella.
//
//   verificarFirma({
//     secreto,                              // el que muestra /configuracion una sola vez
//     encabezado: req.headers["x-claimmix-signature"],
//     body,                                 // el cuerpo CRUDO, antes de JSON.parse
//   })  // -> true | false, nunca tira
import { createHmac, timingSafeEqual } from "node:crypto";

export function verificarFirma({ secreto, encabezado, body, ahora = Math.floor(Date.now() / 1000), tolerancia = 300 }) {
  if (typeof secreto !== "string" || !secreto || typeof encabezado !== "string") return false;
  if (typeof body !== "string" && !Buffer.isBuffer(body)) return false;

  const partes = Object.fromEntries(
    encabezado.split(",").map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? [p.trim(), ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    })
  );
  if (!/^\d{1,12}$/.test(partes.t ?? "") || !/^[0-9a-f]{64}$/.test(partes.v1 ?? "")) return false;

  // Fuera de la ventana es un pedido viejo reenviado, aunque la firma cierre.
  const ts = Number(partes.t);
  if (Math.abs(ahora - ts) > tolerancia) return false;

  const esperada = createHmac("sha256", secreto)
    .update(`${partes.t}.`)
    .update(body)
    .digest();
  const recibida = Buffer.from(partes.v1, "hex");
  return recibida.length === esperada.length && timingSafeEqual(recibida, esperada);
}
