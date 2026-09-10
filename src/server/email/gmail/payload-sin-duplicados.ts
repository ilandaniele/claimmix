/**
 * El mensaje de Gmail, sin el cuerpo que ya guardamos decodificado al lado.
 *
 * `raw_payload` guarda el JSON verbatim que devuelve Gmail (AC4). Adentro, cada
 * parte `text/plain` y `text/html` trae su `body.data`: el mismo cuerpo, en
 * base64url. Y ese cuerpo YA está en la fila, decodificado, en `body_text` y
 * `body_html`.
 *
 * O sea que cada correo se guardaba dos veces, y la copia inútil es la más
 * grande porque base64 pesa un tercio más que el texto.
 *
 * ── Medido en producción, no estimado ───────────────────────────────────────
 *
 *   claim_messages           13 MB con 430 filas   (31 kB por fila)
 *   raw_payload de gmail    6,3 MB con 396 filas   (18 kB por fila)
 *
 * Sobre una muestra de 60 mensajes reales, sacar esos `body.data` deja el
 * payload en el 21 % de lo que pesaba. Un mensaje concreto pasó de 70.852 a
 * 5.872 bytes.
 *
 * ── Qué NO se saca ──────────────────────────────────────────────────────────
 *
 * Sólo el `data` de las partes de texto, que es exactamente lo que está
 * duplicado. La estructura MIME, los encabezados, los ids, las etiquetas, el
 * `snippet` y el `attachmentId` de cada adjunto quedan enteros: eso no está en
 * ninguna otra columna, y `attachmentId` es por donde el adaptador se baja los
 * archivos.
 *
 * Un adjunto chico que Gmail devuelva inline —con `data` en vez de
 * `attachmentId`— tampoco se toca: su mimeType no es de texto. Es una regla
 * sobre lo que está duplicado, no sobre lo que es grande.
 */

import "server-only";

/** Las dos partes cuyo contenido termina en `body_text` y `body_html`. */
const YA_DECODIFICADAS = new Set(["text/plain", "text/html"]);

interface ParteDeGmail {
  mimeType?: string | null;
  body?: { data?: string | null; [k: string]: unknown } | null;
  parts?: ParteDeGmail[] | null;
  [k: string]: unknown;
}

function limpiarParte(parte: ParteDeGmail): ParteDeGmail {
  const mime = parte.mimeType ?? "";
  const hijas = parte.parts?.map(limpiarParte);

  // El `data` se saca de la copia; nada muta el objeto que llegó, que es el
  // mismo que el poller sigue usando para decodificar el cuerpo.
  const cuerpo =
    parte.body && YA_DECODIFICADAS.has(mime)
      ? Object.fromEntries(
          Object.entries(parte.body).filter(([clave]) => clave !== "data")
        )
      : parte.body;

  return {
    ...parte,
    ...(parte.body !== undefined ? { body: cuerpo as ParteDeGmail["body"] } : {}),
    ...(hijas ? { parts: hijas } : {}),
  };
}

/**
 * @param msg el `gmail_v1.Schema$Message` tal como vino.
 * @returns una copia sin los cuerpos de texto en base64. El original no se toca.
 */
export function sinLosCuerposYaDecodificados<T>(msg: T): T {
  if (!msg || typeof msg !== "object") return msg;

  const m = msg as { payload?: ParteDeGmail | null };
  if (!m.payload) return msg;

  return { ...msg, payload: limpiarParte(m.payload) } as T;
}
