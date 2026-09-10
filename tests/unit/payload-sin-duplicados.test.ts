/**
 * El correo no se guarda dos veces.
 *
 * `raw_payload` guardaba el JSON verbatim de Gmail, y adentro cada parte de
 * texto trae su `body.data` en base64 — el mismo cuerpo que la fila ya tiene
 * decodificado en `body_text` y `body_html`. Medido en producción:
 * `claim_messages` pesa 13 MB con 430 filas, y 6,3 MB de eso son los
 * `raw_payload` de 396 correos. 18 kB por correo, el 79 % duplicado.
 */

vi.mock("server-only", () => ({}));

import { describe, it, expect, vi } from "vitest";
import { sinLosCuerposYaDecodificados } from "@/server/email/gmail/payload-sin-duplicados";

/** Un cuerpo en base64 del largo que tienen los de verdad. */
const base64 = (n: number) => "Q".repeat(n);

const CORREO = {
  id: "18f0",
  threadId: "18f0",
  snippet: "Choqué en Corrientes",
  labelIds: ["INBOX"],
  payload: {
    mimeType: "multipart/mixed",
    headers: [{ name: "Subject", value: "Siniestro" }],
    body: {},
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/plain", body: { size: 900, data: base64(1_200) } },
          { mimeType: "text/html", body: { size: 4200, data: base64(5_600) } },
        ],
      },
      {
        mimeType: "image/jpeg",
        filename: "frente.jpg",
        body: { size: 220_000, attachmentId: "ANGjdJ_x" },
      },
    ],
  },
};

describe("sinLosCuerposYaDecodificados", () => {
  it("saca el base64 de las partes de texto", () => {
    const limpio = sinLosCuerposYaDecodificados(CORREO);
    const alternativa = limpio.payload.parts[0]!.parts!;

    expect(alternativa[0]!.body).not.toHaveProperty("data");
    expect(alternativa[1]!.body).not.toHaveProperty("data");
  });

  it("pero conserva el resto de la parte", () => {
    // El `size` dice cuánto pesaba el cuerpo original y no está en ninguna otra
    // columna.
    const limpio = sinLosCuerposYaDecodificados(CORREO);
    const texto = limpio.payload.parts[0]!.parts![0]!;

    expect(texto.mimeType).toBe("text/plain");
    expect(texto.body.size).toBe(900);
  });

  it("no toca el adjunto: `attachmentId` es por donde se baja el archivo", () => {
    const limpio = sinLosCuerposYaDecodificados(CORREO);
    const adjunto = limpio.payload.parts[1]!;

    expect(adjunto.body!.attachmentId).toBe("ANGjdJ_x");
    expect(adjunto.filename).toBe("frente.jpg");
  });

  it("un adjunto chico que viene inline tampoco se toca", () => {
    // La regla es sobre lo que está DUPLICADO, no sobre lo que es grande: un
    // `image/png` con `data` no está en ninguna otra parte de la fila.
    const conInline = {
      payload: {
        mimeType: "multipart/mixed",
        parts: [{ mimeType: "image/png", body: { data: "iVBORw0KGgo=" } }],
      },
    };

    const limpio = sinLosCuerposYaDecodificados(conInline);

    expect(limpio.payload.parts[0]!.body.data).toBe("iVBORw0KGgo=");
  });

  it("los encabezados, el id y las etiquetas quedan enteros", () => {
    const limpio = sinLosCuerposYaDecodificados(CORREO);

    expect(limpio.id).toBe("18f0");
    expect(limpio.labelIds).toEqual(["INBOX"]);
    expect(limpio.payload.headers).toEqual([{ name: "Subject", value: "Siniestro" }]);
  });

  it("no muta el mensaje que le pasaron", () => {
    // El poller sigue usando `msg` para decodificar el cuerpo DESPUÉS de esto.
    // Mutarlo le vaciaría el correo al que lo lee.
    const antes = JSON.stringify(CORREO);
    sinLosCuerposYaDecodificados(CORREO);

    expect(JSON.stringify(CORREO)).toBe(antes);
  });

  it("aguanta un mensaje sin payload", () => {
    expect(sinLosCuerposYaDecodificados({ id: "x" })).toEqual({ id: "x" });
    expect(sinLosCuerposYaDecodificados(null)).toBeNull();
  });

  it("achica de verdad", () => {
    /*
     * La afirmación que justifica el cambio.
     *
     * Sobre 60 correos de producción el payload quedó en el 21 % de lo que
     * pesaba, y un mensaje concreto pasó de 70.852 a 5.872 bytes. Acá el
     * fixture tiene cuerpos del largo que tienen los de verdad, así que el
     * umbral es el mismo orden: si alguien deja de sacar una de las dos partes
     * de texto, esto se cae.
     */
    const antes = JSON.stringify(CORREO).length;
    const despues = JSON.stringify(sinLosCuerposYaDecodificados(CORREO)).length;

    expect(despues).toBeLessThan(antes * 0.25);
  });
});
