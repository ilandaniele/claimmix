/**
 * La frase de cuidado de la derivación y los predicados de la guarda.
 *
 * `CUIDADO` la usan los pisos de mail y WhatsApp y el redactor; los predicados,
 * la guarda del redactor. Que los pisos sin heridos no la digan lo prueban
 * `template-render` y `whatsapp-messenger` sobre el texto real.
 */

import { describe, it, expect } from "vitest";

import { CUIDADO, diceCuidado, hablaDeLaSalud, pideDatos } from "@/core/mensajes/derivacion";
import { AVISO_DE_TRASPASO, SI_RESPONDES_EL_CORREO } from "@/core/mensajes/traspaso";

describe("diceCuidado", () => {
  it.each([
    CUIDADO,
    "Hola, Laura. Lamentamos mucho lo que están pasando",
    "Lo lamento mucho.",
    "Sentimos mucho lo que pasó.",
  ])("sí: %s", (texto) => {
    expect(diceCuidado(texto)).toBe(true);
  });

  it.each(["Lamentablemente no tengo fotos", "sencillamente"])("no: %s", (texto) => {
    expect(diceCuidado(texto)).toBe(false);
  });
});

describe("CUIDADO", () => {
  it("no pide nada, no le pone género a nadie, no pregunta y es breve", () => {
    expect(pideDatos(CUIDADO)).toBe(false);
    expect(/(?<!\p{L})(?:él|ella)\s+(?:se|te|va)\b/iu.test(CUIDADO)).toBe(false);
    expect(CUIDADO).not.toContain("?");
    expect(CUIDADO.length).toBeLessThan(60);
  });

  it("no nombra la salud de nadie", () => {
    expect(hablaDeLaSalud(CUIDADO)).toBe(false);
  });
});

describe("pideDatos", () => {
  it.each([
    "Para avanzar necesitamos que nos mandes el DNI.",
    "Envianos las fotos.",
    "Mandanos el parte.",
  ])("sí: %s", (texto) => {
    expect(pideDatos(texto)).toBe(true);
  });

  it.each([AVISO_DE_TRASPASO, SI_RESPONDES_EL_CORREO])(
    "no: el aviso y el pie de los pisos, que no piden nada: %s",
    (texto) => {
      expect(pideDatos(texto)).toBe(false);
    }
  );
});

/*
 * incendio-grave: con «mi señora está internada con quemaduras» en el prompt y
 * la consigna de cuidado, lo fácil es devolverlo. Eso repite y pronostica.
 */
describe("hablaDeLaSalud", () => {
  it.each([
    "Lamentamos mucho que tu señora esté internada con quemaduras.",
    "Lamentamos mucho lo de tu señora, esperamos que se recupere pronto.",
    "Esperamos que se mejore pronto.",
    "Lamentamos mucho lo de las heridas.",
    "Sentimos mucho que haya personas lastimadas.",
    "Esperamos que la lesión no sea grave.",
    "Deseamos una pronta recuperación.",
    "Lamentamos que esté en el hospital.",
    "Lo importante ahora es su salud.",
    "Les deseamos una pronta mejoría.",
    "Esperamos que tu señora esté bien.",
    "Ojalá se encuentren mejor pronto.",
  ])("sí: %s", (texto) => {
    expect(hablaDeLaSalud(texto)).toBe(true);
  });

  it.each([
    `Hola, Laura. ${CUIDADO} Ya derivamos tu denuncia a un especialista.`,
    "Si necesitás asistencia urgente, llamá a la línea de emergencias de tu póliza.",
    "Saludos, el equipo de siniestros.",
    "Un especialista va a revisar este bien asegurado.",
  ])("no: %s", (texto) => {
    expect(hablaDeLaSalud(texto)).toBe(false);
  });
});
