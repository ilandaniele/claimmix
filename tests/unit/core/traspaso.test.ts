/**
 * El aviso de traspaso y el predicado de la guarda.
 *
 * `AVISO_DE_TRASPASO` lo dicen los pisos del cierre y de la derivación en los
 * dos canales; `mencionaElTraspaso` es la guarda del redactor y la comprobación
 * `traspaso` del ensayo. Que los pisos lo traigan lo prueban `template-render`
 * y `whatsapp-messenger` sobre el texto real.
 */

import { describe, it, expect } from "vitest";

import {
  AVISO_DE_TRASPASO,
  NO_HACE_FALTA_CONTESTAR,
  SI_RESPONDES_EL_CORREO,
  SI_VOLVES_A_ESCRIBIR,
  mencionaElTraspaso,
} from "@/core/mensajes/traspaso";
import { CUIDADO, hablaDeLaSalud } from "@/core/mensajes/derivacion";
import { pideAlgo } from "../../../scripts/lib/pide-algo.mjs";

describe("mencionaElTraspaso", () => {
  it.each([
    AVISO_DE_TRASPASO,
    "Con esto terminamos la carga de datos por acá. Alguien del equipo te va a escribir desde otro número.",
    "La carga de datos termina acá; una persona del equipo te contacta desde otra dirección de correo.",
    `${CUIDADO} Ya derivamos tu denuncia a un especialista. ${AVISO_DE_TRASPASO}`,
    // Lo que le sugieren al modelo el brief y el reintento, al pie de la letra.
    "Con esto se cierra la carga de datos por este medio y una persona del equipo te va a escribir desde otro número o desde otra dirección de correo.",
    "La carga de datos se cierra acá. Una persona del equipo te va a escribir desde otro número.",
    "La carga se cierra acá y una persona te va a escribir desde otro número o correo.",
  ])("sí: %s", (texto) => {
    expect(mencionaElTraspaso(texto)).toBe(true);
  });

  it.each([
    // Los cierres de antes.
    "Un analista la va a revisar y te contactamos si hiciera falta algo más.",
    "Recibimos tu denuncia y ya quedó registrada. Por las características de lo que nos contás, " +
      "la derivamos a un especialista que se va a comunicar con vos a la brevedad. " +
      "Si necesitás asistencia urgente, llamá a la línea de emergencias de tu póliza.",
    // Media frase no alcanza.
    "Con esto cerramos la carga de datos por este medio.",
    "Una persona del equipo te va a escribir desde otro número.",
  ])("no: %s", (texto) => {
    expect(mencionaElTraspaso(texto)).toBe(false);
  });
});

describe("AVISO_DE_TRASPASO", () => {
  it("no pide nada ni nombra la salud de nadie", () => {
    expect(pideAlgo(AVISO_DE_TRASPASO.toLowerCase())).toBe(false);
    expect(hablaDeLaSalud(AVISO_DE_TRASPASO)).toBe(false);
  });

  it.each([SI_RESPONDES_EL_CORREO, SI_VOLVES_A_ESCRIBIR, NO_HACE_FALTA_CONTESTAR])(
    "los pies tampoco piden: %s",
    (pie) => {
      expect(pideAlgo(pie.toLowerCase())).toBe(false);
    }
  );

  it("el pie de WhatsApp dice lo mismo que el del correo: lo lee una persona", () => {
    expect(SI_VOLVES_A_ESCRIBIR).toMatch(/lo lee una persona/);
    expect(SI_VOLVES_A_ESCRIBIR).not.toMatch(/denuncia nueva|caso nuevo/i);
  });
});
