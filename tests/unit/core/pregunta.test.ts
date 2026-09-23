/**
 * La pregunta del último mensaje, cuando el agente no deliberó.
 *
 * Sin plan no hay quién diga «nos preguntó algo», y la pregunta quedaba sin
 * contestar: el caso que el ensayo `pregunta` vio el 22/09 con un 429.
 */

import { describe, it, expect } from "vitest";
import { laPreguntaDelMensaje } from "@/core/mensajes/pregunta";

describe("laPreguntaDelMensaje", () => {
  it("se queda con la pregunta y deja afuera el resto", () => {
    expect(
      laPreguntaDelMensaje("¿Cuánto suele tardar esto? Necesito el auto para trabajar.")
    ).toBe("¿Cuánto suele tardar esto?");
  });

  it("acepta los signos repetidos", () => {
    expect(laPreguntaDelMensaje("cuánto tarda??")).toBe("cuánto tarda??");
  });

  it("acepta la pregunta sin el signo de cierre", () => {
    expect(laPreguntaDelMensaje("¿cuánto tarda esto")).not.toBeNull();
  });

  it("junta varias preguntas", () => {
    expect(laPreguntaDelMensaje("¿Cuánto tarda? ¿Y me cubre?")).toBe(
      "¿Cuánto tarda? ¿Y me cubre?"
    );
  });

  // Un «?» corto antes tapaba la pregunta abierta que venía después.
  it.each([
    ["ok? ¿y cuánto tarda esto", "¿y cuánto tarda esto"],
    ["si? ¿y cuánto tarda esto", "¿y cuánto tarda esto"],
    ["¿Cuánto tarda? ¿y me cubre", "¿Cuánto tarda? ¿y me cubre"],
  ])("ve la pregunta sin cierre en %j", (texto, esperada) => {
    expect(laPreguntaDelMensaje(texto)).toBe(esperada);
  });

  // Por WhatsApp el signo de apertura casi nunca está, y el de cierre viene
  // pegado a lo que sigue.
  it.each([
    ["cuanto tarda?😬", "cuanto tarda?"],
    ["cuanto tarda??🙏", "cuanto tarda??"],
    ["cuanto tarda?, necesito el auto", "cuanto tarda?"],
    ["cuanto tarda?...", "cuanto tarda?"],
    ["(cuanto tarda?)", "(cuanto tarda?"],
    ['"cuanto tarda?"', '"cuanto tarda?'],
    ["«cuanto tarda?»", "«cuanto tarda?"],
  ])("ve la pregunta en %j", (texto, esperada) => {
    expect(laPreguntaDelMensaje(texto)).toBe(esperada);
  });

  it.each([
    undefined,
    null,
    "",
    "   ",
    "ok",
    "ok?",
    "?",
    "si?",
    "gracias",
    "Gracias!",
    "No hubo heridos.",
    "[Imagen adjunta sin texto]",
    "mirá https://x.com/a?b=1",
    "gracias\nhttps://ejemplo.com/?utm=x",
    "gracias, www.ejemplo.com/pagina?utm=x",
    "¿si? dale, gracias",
  ])("no ve una pregunta en %j", (texto) => {
    expect(laPreguntaDelMensaje(texto)).toBeNull();
  });

  it("no pasa de 400 caracteres", () => {
    const larga = "¿" + "a".repeat(998) + "?";
    const out = laPreguntaDelMensaje(larga);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(400);
  });

  // El cuerpo de un mail no tiene tope, y un tramo sin puntuación hacía la
  // búsqueda cuadrática: un mega tardaba minutos y trababa el worker.
  it.each([
    ["letras sin puntuación", "¿Cuánto tarda? " + "a".repeat(1_000_000)],
    ["signos pegados a una letra", "¿Cuánto tarda? " + "?".repeat(1_000_000) + "b"],
  ])("un mensaje enorme de %s no traba nada", (_, texto) => {
    const desde = performance.now();
    expect(laPreguntaDelMensaje(texto)).toBe("¿Cuánto tarda?");
    expect(performance.now() - desde).toBeLessThan(500);
  });

  /*
   * Por mail la respuesta trae citado lo nuestro, y lo nuestro suele terminar
   * en pregunta. Sin «>», la cita de Outlook y Hotmail se leía como del
   * asegurado, y un «Gracias» reenviaba el pedido.
   */
  const NUESTRA = "Diego, ¿el choque fue en Villa Mitre?";
  it.each([
    [
      "Hotmail",
      `Gracias\n\n________________________________\nDe: ClaimMix <siniestros@claimmix.com>\nEnviado: lunes, 22 de septiembre de 2026 10:15\nPara: Diego <diego@example.com>\nAsunto: Re: Choque\n\n${NUESTRA}`,
    ],
    [
      "Outlook de escritorio",
      `Gracias\r\n\r\nDe: ClaimMix <siniestros@claimmix.com>\r\nEnviado el: lunes, 22 de septiembre de 2026 10:15\r\nPara: Diego\r\nAsunto: RE: Choque\r\n\r\n${NUESTRA}`,
    ],
    [
      "Outlook en inglés, en negrita",
      `Thanks\n\n*From:* ClaimMix <siniestros@claimmix.com>\n*Sent:* Monday, September 22, 2026 10:15 AM\n*To:* Diego\n*Subject:* RE: Choque\n\n${NUESTRA}`,
    ],
    [
      "Gmail, cuerpo sin limpiar",
      `Gracias\n\nEl lun, 22 sept 2026 a las 10:15, ClaimMix escribió:\n> ${NUESTRA}`,
    ],
  ])("no toma por del asegurado la pregunta citada por %s", (_, texto) => {
    expect(laPreguntaDelMensaje(texto)).toBeNull();
  });

  // La firma y el pie van en cada mail: con un «?», cada «Gracias» de esa
  // persona reenviaba el pedido.
  it.each([
    ["la firma", "Gracias!\n\n--\nMaría López\n¿Realmente necesitás imprimir este correo?"],
    ["la firma con espacio", "Gracias!\r\n\r\n-- \r\nMaría López\r\n¿Consultas? 291 555-1234"],
    ["el pie sin firma", "Gracias!\n\nMaría López\n¿Realmente necesita imprimir este e-mail?"],
    ["el pie en inglés", "Thanks\n\nMaría\nDo you really need to print this email?"],
  ])("no toma por pregunta %s", (_, texto) => {
    expect(laPreguntaDelMensaje(texto)).toBeNull();
  });

  it("se queda con la pregunta de arriba de la firma", () => {
    expect(
      laPreguntaDelMensaje("¿Cuánto tarda?\n--\nMaría\n¿Realmente necesitás imprimir este correo?")
    ).toBe("¿Cuánto tarda?");
  });

  it("se queda con la pregunta propia y no con la citada", () => {
    expect(
      laPreguntaDelMensaje(
        `¿Cuánto tarda?\n\n________________________________\nDe: ClaimMix\nEnviado: lunes\n\n${NUESTRA}`
      )
    ).toBe("¿Cuánto tarda?");
  });
});
