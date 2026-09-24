/**
 * Las comprobaciones del ensayo `goteo` que marcan el eco y la hora pedida de
 * dos formas.
 *
 * El 23/09 a «Fue un choque, ayer a la tarde» se le contestó «¿Fue a la tarde,
 * correcto?» y en la vuelta siguiente «Más o menos a qué hora fue.», y el
 * ensayo dio verde. Esto fija qué cuenta como devolverle lo que dijo y qué es
 * confirmar algo inferido, que tiene que seguir pasando.
 */

import { describe, it, expect } from "vitest";

import { confirmaLoDicho, formaDePedirLaHora } from "../../scripts/lib/ensayo-confirmaciones.mjs";
import { readable } from "@/core/email/texto-legible";

const tal = (texto: string) => readable(texto).toLowerCase();

const CHOQUE = "Fue un choque, ayer a la tarde";
const NOMBRE = "Soy Roberto Paz, DNI 25.888.101";
const CRASH = "It was a crash, yesterday afternoon";

describe("confirmaLoDicho", () => {
  // Los valores que teníamos de lo que se le pidió en la vuelta anterior.
  const TARDE = ["tarde"];

  it.each([
    [CHOQUE, "¡Gracias! ¿Fue a la tarde, correcto? Para seguir, decinos tu nombre completo.", TARDE],
    [CHOQUE, "Entendimos que fue a la tarde. ¿Correcto?", TARDE],
    [CHOQUE, '• Hora aproximada: entendimos "tarde"', TARDE],
    [NOMBRE, "¿Tu nombre es Roberto Paz, correcto?", ["Roberto Paz", "25888101"]],
    [CHOQUE, "¿Me confirmás que fue a la tarde?", TARDE],
    [CRASH, "So it happened yesterday afternoon, right?", ["afternoon"]],
    ["My policy is POL-3311-B", "Your policy is POL-3311-B. Is that right?", ["POL-3311-B"]],
    // Goteo, 23/09: el ensayo dio verde porque «entendemos» contaba como valor.
    ["La póliza es POL-3311-B", "Entendemos que tu póliza es POL-3311-B, ¿es correcto?", ["POL-3311-B"]],
    ["La póliza es POL-3311-B", "Entendemos que el número es POL-3311-B, ¿es correcto?", ["POL-3311-B"]],
    ["My policy is POL-3311-B", "We understand your policy is POL-3311-B, correct?", ["POL-3311-B"]],
    // Con punto o con dos puntos es la misma hora.
    ["Fue a las 18.30", "¿Fue a las 18:30, correcto?", ["18:30"]],
  ])("a «%s» le devuelve lo que dijo: %s", (say, respuesta, pedidos) => {
    expect(confirmaLoDicho(tal(respuesta), say, pedidos)).not.toBeNull();
  });

  it.each([
    // Inferido: la persona dijo «ayer», no la fecha.
    [CHOQUE, "¿El choque fue el 22 de septiembre, correcto?", ["2026-09-22"]],
    [CHOQUE, "Más o menos a qué hora fue.", TARDE],
    [CHOQUE, "¿A qué hora fue el choque?", TARDE],
    // Pedir un dato no es confirmarlo, aunque la oración de antes nombre a la persona.
    [NOMBRE, "Gracias, Roberto. ¿Me confirmás tu número de póliza?", ["Roberto Paz"]],
    [CHOQUE, "¿Me confirmás a qué hora de la tarde fue, más o menos?", TARDE],
    [CRASH, "What time did it happen, roughly?", ["afternoon"]],
    // No se lo pedimos: de qué campo es lo infirió el extractor, y el orquestador lo pregunta.
    [CHOQUE, "¿Fue un choque, correcto?", TARDE],
    [NOMBRE, "¿Tu nombre es Roberto Paz, correcto?", []],
    // Un número suelto puede ser el DNI, la póliza o el teléfono: el orquestador lo pregunta.
    [NOMBRE, '• DNI: entendimos "25888101"', ["Roberto Paz", "25888101"]],
  ])("a «%s» no le devuelve nada: %s", (say, respuesta, pedidos) => {
    expect(confirmaLoDicho(tal(respuesta), say, pedidos)).toBeNull();
  });
});

describe("formaDePedirLaHora", () => {
  it.each([
    ["¿Fue a la tarde, correcto?", ["confirma-franja"]],
    ["Más o menos a qué hora fue.", ["pide-hora"]],
    ["¿Sabés la hora exacta?", ["pide-hora"]],
    // Aclarar que alcanza con una aproximada es la misma pregunta.
    ["¿A qué hora fue? Si no sabés la hora exacta, más o menos", ["pide-hora"]],
    ["¿Más o menos a qué hora fue? Si no te acordás la hora exacta, está bien", ["pide-hora"]],
    ["¿Me confirmás a qué hora de la tarde fue, más o menos?", ["pide-hora"]],
    ["What time did it happen, roughly?", ["pide-hora"]],
    ["¿Tu nombre es Roberto Paz, correcto?", []],
    // Un resumen de lo que tenemos no pide nada.
    ["• Hora aproximada: tarde", []],
  ])("%s", (respuesta, formas) => {
    expect([...formaDePedirLaHora(tal(respuesta))]).toEqual(formas);
  });

  it("las dos vueltas del 23/09 piden la hora de dos formas", () => {
    const formas = new Set([
      ...formaDePedirLaHora(tal("¿Fue a la tarde, correcto?")),
      ...formaDePedirLaHora(tal("Más o menos a qué hora fue.")),
    ]);

    expect(formas.size).toBe(2);
  });
});
