/**
 * El mail que repetía el pedido y se comía la pregunta.
 *
 * El asegurado escribe «todavía no encuentro la póliza, ¿cuánto tarda esto? lo
 * necesito para trabajar». El agente devuelve `answer_and_ask` con la pregunta
 * adentro, el orquestador la manda en `data`… y `render.ts` no la pasaba al
 * armador de la plantilla. Se caía en ese borde.
 *
 * Lo que le llegaba a la persona era la MISMA lista de datos faltantes de la
 * vuelta anterior, palabra por palabra, abriendo con «Gracias por tu reclamo»
 * por cuarta vez. Es el mensaje más robótico que manda el producto: la señal
 * inequívoca de que del otro lado no hay nadie leyendo.
 *
 * WhatsApp no tenía el problema porque pasa por `compose-reply`, que sí tiene
 * una respuesta honesta escrita para este caso. El correo no pasa por ahí, así
 * que la frase ahora vive en `@/core/mensajes/respuesta-pendiente` y la usan
 * los dos.
 */

import { describe, it, expect } from "vitest";

import { renderTemplate } from "@/server/email/render";
import { RESPUESTA_PENDIENTE } from "@/core/mensajes/respuesta-pendiente";

const CASO = "bbbbbbbb-0000-0000-0000-000000000001";

function armar(data: Record<string, unknown>) {
  return renderTemplate("missing_information_request", {
    caseId: CASO,
    missingFields: ["policy_number"],
    ...data,
  });
}

describe("el mail de datos faltantes contesta lo que preguntaron", () => {
  it("cuando hay pregunta, la respuesta honesta va en el cuerpo", () => {
    const { html, text } = armar({ question: "¿cuánto tarda esto?" });

    expect(text).toContain(RESPUESTA_PENDIENTE);
    expect(html).toContain("todavía no podemos darte una respuesta");
  });

  it("y sigue pidiendo lo que falta: contesta ADEMÁS, no en vez de", () => {
    // Media respuesta también es un defecto. Si contestar la pregunta hiciera
    // desaparecer el pedido, el caso se queda igual de trabado.
    const { text } = armar({ question: "¿cuánto tarda esto?" });

    expect(text).toContain("Número de póliza");
  });

  it("sin pregunta, el mail sale como antes", () => {
    /*
     * El control. Una plantilla que metiera la frase siempre le diría a alguien
     * que no preguntó nada que «todavía no podemos darte una respuesta», que es
     * contestar una pregunta que nadie hizo.
     */
    const { html, text } = armar({});

    expect(text).not.toContain(RESPUESTA_PENDIENTE);
    expect(html).not.toContain("todavía no podemos darte una respuesta");
  });

  it("nunca promete un plazo, ni siquiera contestando por plazos", () => {
    // La pregunta es sobre tiempos: es exactamente donde un redactor honesto
    // podría resbalar. La frase no dice cuánto tarda porque nadie lo sabe.
    const { text } = armar({ question: "¿cuánto tarda esto? lo necesito para trabajar" });

    expect(text).not.toMatch(/\d+\s*(?:horas?|d[íi]as?|semanas?)/i);
  });
});

describe("el mail no saluda como si fuera el primero, cuando no lo es", () => {
  it("en una vuelta posterior no agradece de nuevo", () => {
    const { text } = armar({ isFollowUp: true });

    expect(text).not.toContain("Gracias por tu reclamo");
    expect(text).toContain("Para poder seguir con tu reclamo");
  });

  it("pero el primero sí agradece", () => {
    // El control: no se pierde la apertura del primer contacto.
    const { text } = armar({ isFollowUp: false });

    expect(text).toContain("Gracias por tu reclamo");
  });

  it("y usa el nombre cuando el caso ya lo tiene", () => {
    const { text } = armar({ claimantName: "Diego", isFollowUp: true });

    expect(text).toContain("Diego,");
  });
});

/**
 * La apertura descabezada.
 *
 * Un caso real (7 de septiembre, 18:10) recibió un mail que abría «gracias por
 * tu reclamo.», en minúscula y sin saludo: la apertura era `nombre + ", "` y
 * detrás una frase en minúscula pensada para venir pegada al nombre. Sin nombre
 * quedaba una oración sin cabeza.
 *
 * El test anterior —«sin nombre no deja una coma huérfana»— pasaba por el
 * motivo equivocado: pasaba porque el texto arrancaba descabezado, no porque
 * estuviera bien.
 */
describe("sin nombre, la apertura la escribió una persona", () => {
  for (const esVuelta of [false, true]) {
    it(`empieza en mayúscula y no arranca con coma (isFollowUp: ${esVuelta})`, () => {
      const { text, html } = armar({ isFollowUp: esVuelta });
      const primeraLinea = text.split("\n\n")[1];

      expect(primeraLinea).toMatch(/^[A-ZÁÉÍÓÚÑ]/);
      expect(text).not.toMatch(/^\s*,/m);
      expect(text).not.toMatch(/\n\s*gracias por tu reclamo/);
      expect(html).not.toContain(">gracias");
    });
  }

  it("y con nombre, el nombre va delante y la frase sigue entera", () => {
    const { text } = armar({ claimantName: "Diego", isFollowUp: false });

    expect(text).toContain("Diego, gracias por tu reclamo.");
  });
});

describe("la frase de la pregunta pendiente vive una sola vez", () => {
  it("no aparece dos veces cuando el piso ya la trae", () => {
    // `withUnansweredQuestion` se la pegaba encima al piso, y el piso ya la
    // agrega cuando hay pregunta: la misma frase dos veces seguidas, salida del
    // archivo cuya razón de existir es que viva una sola vez.
    const { text } = armar({ question: "¿cuánto tarda esto?" });
    const veces = text.split(RESPUESTA_PENDIENTE).length - 1;

    expect(veces).toBe(1);
  });
});
