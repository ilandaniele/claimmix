/**
 * El campo `email` tiene que tener un mail adentro.
 *
 * El último recurso del parser era el identificador del remitente tal cual
 * venía, sin preguntarse si era una dirección. Guardaba dos cosas que no lo son:
 *
 *   · por mail, el encabezado entero — `Ilan Daniele <ilan@…>` — porque eso es
 *     lo que manda un cliente de correo;
 *   · por WhatsApp, el número de teléfono, que de mail no tiene nada.
 *
 * Los dos se vieron con mensajes reales el 24 de agosto, mandados a mano por
 * los dos canales. Ninguno rompía una respuesta —el envío usa la casilla
 * conectada, no este campo— y los dos ensucian lo que sí se compara: cruzar un
 * cliente por su mail contra `Nombre <dir>` no encuentra a nadie, y contra un
 * teléfono encuentra cualquier cosa.
 *
 * Un dato que parece estar y está mal es peor que vacío: vacío se pide.
 */

import { describe, it, expect } from "vitest";
import { parseEmailClaimFields } from "@/lib/email/claim-parser";

function emailField(fields: Array<{ field_key: string; field_value: string }>) {
  return fields.find((f) => f.field_key === "email")?.field_value ?? null;
}

describe("parseEmailClaimFields — el campo email", () => {
  it("guarda la dirección, no el encabezado con el nombre", () => {
    const fields = parseEmailClaimFields({
      subject: "Choque en Bahía Blanca",
      body: "Ayer choqué en Alem al 2300.",
      senderEmail: "Ana Ruiz <ana.ruiz@correo.com.ar>",
    });

    expect(emailField(fields)).toBe("ana.ruiz@correo.com.ar");
  });

  it("no guarda un teléfono como si fuera un mail", () => {
    // Por WhatsApp el remitente es un número. Antes entraba igual, con 0.9 de
    // confianza, y quedaba en la ficha del asegurado como su dirección.
    const fields = parseEmailClaimFields({
      subject: "",
      body: "Hola, se me llenó el auto de abolladuras por el granizo.",
      senderEmail: "5491100000000",
    });

    expect(emailField(fields)).toBeNull();
  });

  it("una dirección escrita en el mensaje le gana al remitente", () => {
    const fields = parseEmailClaimFields({
      subject: "Denuncia",
      body: "Escribo por mi hermana; respondan a ana.ruiz@correo.com.ar por favor.",
      senderEmail: "Otro Alguien <otro@correo.com.ar>",
    });

    expect(emailField(fields)).toBe("ana.ruiz@correo.com.ar");
  });

  it("sigue entendiendo la dirección pelada de siempre", () => {
    const fields = parseEmailClaimFields({
      subject: "Denuncia",
      body: "Choqué ayer.",
      senderEmail: "ensayo.choque@example.com",
    });

    expect(emailField(fields)).toBe("ensayo.choque@example.com");
  });

  it("sin remitente ni dirección en el texto, no inventa el campo", () => {
    const fields = parseEmailClaimFields({
      subject: "Denuncia",
      body: "Choqué ayer a la tarde.",
      senderEmail: null,
    });

    expect(emailField(fields)).toBeNull();
  });
});
