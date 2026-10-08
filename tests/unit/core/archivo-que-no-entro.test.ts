import { describe, it, expect } from "vitest";
import { MAX_ATTACHMENT_SIZE_BYTES } from "@/core/adjuntos/firma";
import {
  ARCHIVO_QUE_NO_ENTRO,
  conArchivoQueNoEntro,
} from "@/core/mensajes/archivo-que-no-entro";

const TEXTO = "Recibimos tu denuncia.";
const veces = (s: string) => s.split(ARCHIVO_QUE_NO_ENTRO).length - 1;

describe("ARCHIVO_QUE_NO_ENTRO", () => {
  it("el número sale del tope y no de una copia a mano", () => {
    expect(ARCHIVO_QUE_NO_ENTRO).toContain(`${MAX_ATTACHMENT_SIZE_BYTES / (1024 * 1024)} MB`);
    expect(ARCHIVO_QUE_NO_ENTRO).toContain("10 MB");
  });

  it("no dice «rechazado»: el redactor lo prohíbe y el tono tiene que coincidir", () => {
    expect(ARCHIVO_QUE_NO_ENTRO).not.toMatch(/rechazad/i);
  });
});

describe("conArchivoQueNoEntro", () => {
  it("agrega la frase una vez, después del texto", () => {
    expect(conArchivoQueNoEntro(TEXTO, true)).toBe(`${TEXTO}\n\n${ARCHIVO_QUE_NO_ENTRO}`);
  });

  it("aplicarla dos veces es aplicarla una", () => {
    const una = conArchivoQueNoEntro(TEXTO, true);
    expect(conArchivoQueNoEntro(una, true)).toBe(una);
  });

  it("no la repite si el texto ya la trae", () => {
    const piso = `${TEXTO}\n\n${ARCHIVO_QUE_NO_ENTRO}\n\nSaludos.`;
    const out = conArchivoQueNoEntro(piso, true);
    expect(out).toBe(piso);
    expect(veces(out)).toBe(1);
  });

  it.each([false, undefined, null, "true", 1])(
    "sin el aviso (%j) deja el texto intacto",
    (noEntro) => {
      expect(conArchivoQueNoEntro(TEXTO, noEntro)).toBe(TEXTO);
    }
  );
});
