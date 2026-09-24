/**
 * Lo que la persona acaba de escribir, y la hora que dijo sin precisar.
 *
 * El ensayo del 23/09 contestó «¿Fue a la tarde, correcto?» a «Fue un choque,
 * ayer a la tarde», y en la vuelta siguiente cambió esa pregunta por «Más o
 * menos a qué hora fue.».
 */

import { describe, it, expect } from "vitest";
import {
  confirmaLoQueEscribio,
  contestaSinHora,
  dichoRecien,
  esValorVago,
} from "@/core/mensajes/lo-dicho";

describe("dichoRecien", () => {
  it.each([
    ["tarde", "Fue un choque, ayer a la tarde"],
    ["a la tarde", "Fue un choque, ayer A LA TARDE"],
    ["Roberto Paz", "Soy Roberto Paz, DNI 25.888.101"],
    // La coma corta la frase: el «no» es de la anterior.
    ["Roberto Paz", "No, soy Roberto Paz"],
    ["POL-3311-B", "La póliza es POL-3311-B"],
    ["Bahía Blanca", "choqué en bahia blanca"],
    ["afternoon", "It was a crash, yesterday afternoon"],
    ["robo", "no fue un choque, fue un robo"],
    ["18:30", "fue a las 18:30"],
    // Con punto es la misma hora, y en es-AR se escribe así.
    ["18:30", "fue a las 18.30"],
  ])("«%s» está en «%s»", (valor, texto) => {
    expect(dichoRecien(valor, texto)).toBe(true);
  });

  it.each([
    // Inferido: la persona dijo «ayer», no la fecha.
    ["2026-09-22", "Fue un choque, ayer a la tarde"],
    ["choque de vehículo", "Fue un choque"],
    // Una parte de una palabra no es la palabra.
    ["tar", "a la tarde"],
    ["Paz", "Soy Roberto Pazos"],
    // Muy corto para saber: un «sí» o un «no» está en cualquier mensaje.
    ["no", "no sé"],
    ["null", "null"],
    // Negado: lo escribió para decir que no.
    ["Roberto Paz", "No, no soy Roberto Paz"],
    ["choque", "no fue un choque, fue un robo"],
    ["Roberto Paz", "That isn't Roberto Paz"],
    // Un número suelto: la duda es si es el DNI, la póliza o el teléfono.
    ["25888101", "mi número es 25888101"],
    ["25888101", "Soy Roberto Paz, DNI 25.888.101"],
    ["25.888.101", "dni 25 888 101"],
  ])("«%s» no está en «%s»", (valor, texto) => {
    expect(dichoRecien(valor, texto)).toBe(false);
  });

  it("sin mensaje no se dijo nada", () => {
    expect(dichoRecien("tarde", undefined)).toBe(false);
    expect(dichoRecien("tarde", "")).toBe(false);
  });
});

describe("esValorVago", () => {
  it.each(["tarde", "a la tarde", "por la mañana", "de noche", "in the afternoon"])(
    "«%s» es una franja, no una hora",
    (valor) => {
      expect(esValorVago("hora_siniestro", valor)).toBe(true);
    }
  );

  it.each(["18:00", "a eso de las 6", "a las seis", "al mediodía", "around noon", "6pm"])(
    "«%s» es una hora",
    (valor) => {
      expect(esValorVago("hora_siniestro", valor)).toBe(false);
    }
  );

  it("sólo la hora del siniestro puede ser vaga, y un vacío no es un valor", () => {
    expect(esValorVago("accident_location", "a la tarde")).toBe(false);
    expect(esValorVago("hora_siniestro", "null")).toBe(false);
    expect(esValorVago("hora_siniestro", undefined)).toBe(false);
  });
});

describe("contestaSinHora", () => {
  it.each([
    "a la tarde",
    "Fue a la tarde",
    "No sé bien, a la tarde",
    "Creo que fue a la tarde, más o menos",
    "no me acuerdo la hora",
    "No sé la hora exacta",
    "ni idea",
    "In the afternoon",
    "I don't remember",
    "I'm not sure about the exact time",
    "No tengo idea",
    "No tengo ni idea",
    "No sabría decirte",
    "Tipo a la tarde",
    "Como a la tarde",
    "A media tarde",
    "Ya era de noche",
    "Al atardecer",
    "Capaz que fue a la tarde",
    "Quizás a la tarde",
    "Tal vez a la tarde",
    "I have no idea",
    "I can't remember",
    "Can't remember",
    "Sometime in the afternoon",
    "Late afternoon",
    "Early morning",
    "Maybe in the afternoon",
  ])("«%s» contesta la hora sin dar una", (texto) => {
    expect(contestaSinHora(texto)).toBe(true);
  });

  it.each([
    // La franja, pero de otra cosa.
    "esta tarde te mando las fotos",
    "I'll send the photos this afternoon",
    // Que no sabe, pero otra cosa.
    "no me acuerdo el número de póliza",
    "no sé si te llegaron las fotos",
    "no tengo idea de la póliza",
    "I'd like to know the status",
    // Negar la franja no es contestar con ella.
    "no fue a la tarde",
    // Otros datos, sin la hora.
    "Soy Roberto Paz, DNI 25.888.101",
    "bien, gracias",
    "",
  ])("«%s» no contesta la hora", (texto) => {
    expect(contestaSinHora(texto)).toBe(false);
  });
});

/*
 * Goteo, 23/09: a «La póliza es POL-3311-B» se le contestó «Entendemos que tu
 * póliza es POL-3311-B, ¿es correcto?». La póliza no estaba en la lista: el
 * redactor la sacó del último mensaje.
 */
describe("confirmaLoQueEscribio", () => {
  const POLIZA = "La póliza es POL-3311-B";
  const NOMBRE = "Soy Roberto Paz, DNI ****8101";

  it.each([
    ["Entendemos que tu póliza es POL-3311-B, ¿es correcto?", POLIZA],
    ["Entendemos que el número es POL-3311-B. ¿Correcto?", POLIZA],
    ["¿Me confirmás que tu póliza es la POL-3311-B?", POLIZA],
    ["Gracias. ¿Tu nombre es Roberto Paz, es así?", NOMBRE],
    ["¿Es correcto que fue a las 18:30?", "fue a las 18.30"],
  ])("«%s» a «%s» le devuelve lo que escribió", (mensaje, texto) => {
    expect(confirmaLoQueEscribio(mensaje, texto, [])).toBe(true);
  });

  it.each([
    // Lo eligió confirmar el orquestador: viene entre los conocidos.
    ["Entendemos que tu póliza es POL-3311-B, ¿es correcto?", POLIZA, ["POL-3311-B"]],
    ["Entendemos que tu DNI es ****8101, ¿es correcto?", NOMBRE, ["25888101"]],
    ["¿Es correcto que fue el 22/09/2026?", "fue el 22/09/2026", ["2026-09-22"]],
    // El nombre de pila en el saludo o como vocativo no es confirmarlo.
    ["Roberto, ¿es correcto que el choque fue en Villa Mitre?", `${NOMBRE}. Choqué en Villa Mitre`, ["Villa Mitre"]],
    ["¡Gracias, Roberto Paz! Para seguir necesitamos las fotos de los daños.", NOMBRE, []],
    // Pedir no es confirmar.
    ["¿Me confirmás tu número de póliza?", POLIZA, []],
    ["No encontramos la póliza POL-3311-B. ¿Nos la pasás de nuevo?", POLIZA, []],
    // Sin nada que se copie tal cual: lo mira el orquestador.
    ["¿Fue a la tarde, correcto?", "Fue un choque, ayer a la tarde", []],
  ])("«%s» a «%s» no le devuelve nada", (mensaje, texto, conocidos) => {
    expect(confirmaLoQueEscribio(mensaje, texto, conocidos)).toBe(false);
  });

  it("sin mensaje no se escribió nada", () => {
    expect(confirmaLoQueEscribio("¿Tu póliza es POL-3311-B, correcto?", undefined, [])).toBe(false);
  });
});
