/**
 * La frontera de PII, del lado del caso.
 *
 * `/api/customers` y `/api/policies` exigen `CUSTOMER_PII_ROLES` con el
 * comentario «un analista NO entra: acá salen DNI, correo y teléfono». Las
 * rutas del caso devolvían lo mismo por otra puerta, y de ahí salen estas dos
 * funciones. Lo que se prueba acá es el CORTE: quién ve qué.
 */

vi.mock("server-only", () => ({}));

import { describe, it, expect, vi } from "vitest";
import {
  OCULTO,
  mensajesSinPiiSiNoCorresponde,
  sinPiiSiNoCorresponde,
} from "@/server/cases/pii";

const DNI = "27.654.321";
const POLIZA = "POL-8812-R";
const CUERPO = `Hola, soy Ana, DNI ${DNI}, póliza ${POLIZA}. Choqué en Corrientes.`;

const MENSAJE = {
  id: "m-1",
  subject: `Siniestro póliza ${POLIZA}`,
  body_text: CUERPO,
  from_addr: "ana@ejemplo.com",
};

describe("mensajesSinPiiSiNoCorresponde", () => {
  it("a un viewer no le salen los identificadores ni la dirección", () => {
    const [visto] = mensajesSinPiiSiNoCorresponde([MENSAJE], "viewer");

    expect(visto!.body_text).not.toContain(DNI);
    expect(visto!.body_text).not.toContain(POLIZA);
    expect(visto!.subject).not.toContain(POLIZA);
    expect(visto!.from_addr).toBe(OCULTO);
  });

  it("pero sigue leyendo lo que pasó", () => {
    // Enmascarar y no esconder: si el cuerpo se reemplazara entero, la pantalla
    // del caso dejaría de servirle a quien la mira.
    const [visto] = mensajesSinPiiSiNoCorresponde([MENSAJE], "viewer");

    expect(visto!.body_text).toContain("Choqué en Corrientes");
  });

  it("a un analista le sale entero, porque es su pantalla de trabajo", () => {
    // El DNI y la póliza que se taparían acá están, en la misma pantalla, en el
    // panel de campos extraídos y en la fila del caso. Tapar una copia y
    // mostrar la otra no es una frontera.
    for (const rol of ["analyst", "specialist", "admin", "owner"]) {
      const [visto] = mensajesSinPiiSiNoCorresponde([MENSAJE], rol);
      expect(visto).toEqual(MENSAJE);
    }
  });

  it("no toca un mensaje sin cuerpo ni dirección", () => {
    const vacio = { id: "m-2", subject: null, body_text: null, from_addr: null };
    expect(mensajesSinPiiSiNoCorresponde([vacio], "viewer")).toEqual([vacio]);
  });
});

describe("sinPiiSiNoCorresponde", () => {
  const RUN = {
    id: "r-1",
    model: "gemini-2.5-flash",
    input_payload: {
      subject: `Siniestro póliza ${POLIZA}`,
      body: CUERPO,
      sender_email: "ana@ejemplo.com",
    },
  };

  it("un analista NO ve el correo crudo de la corrida", () => {
    // Corte distinto al de la conversación, a propósito: la corrida del agente
    // es el registro de lo que hizo el modelo, no la pantalla del siniestro.
    const visto = sinPiiSiNoCorresponde(RUN, "analyst");

    expect(visto.input_payload.body).not.toContain(DNI);
    expect(visto.input_payload.sender_email).toBe(OCULTO);
  });

  it("un specialist sí, porque es quien puede ver el padrón", () => {
    expect(sinPiiSiNoCorresponde(RUN, "specialist")).toEqual(RUN);
  });

  it("la decisión del modelo queda igual para todos", () => {
    // Lo que se le quita al viewer es el cuerpo crudo, no la corrida.
    const visto = sinPiiSiNoCorresponde(RUN, "viewer");

    expect(visto.model).toBe("gemini-2.5-flash");
    expect(visto.id).toBe("r-1");
  });
});
