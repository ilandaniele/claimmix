/**
 * El texto de la plantilla `reabrir_denuncia` que Meta aprueba para escribir
 * después de la ventana de 24 h.
 */

import { describe, it, expect } from "vitest";
import { CUERPO_REABRIR, textoDeReabrir } from "@/core/mensajes/reabrir-denuncia";

describe("textoDeReabrir", () => {
  it("llena las dos variables", () => {
    expect(textoDeReabrir(["abc", "la foto"])).toBe(
      "Hola. Te escribimos por tu denuncia con número de referencia abc. Para poder seguir, todavía necesitamos: la foto. Podés responder a este mensaje; las fotos o archivos mandalos por este mismo chat."
    );
  });

  it("un $& en el parámetro se inserta literal", () => {
    expect(textoDeReabrir(["$&", "la foto"])).toContain("referencia $&.");
  });

  it("el cuerpo tiene exactamente un {{1}} y un {{2}}", () => {
    expect(CUERPO_REABRIR.match(/\{\{1\}\}/g)).toHaveLength(1);
    expect(CUERPO_REABRIR.match(/\{\{2\}\}/g)).toHaveLength(1);
  });
});
