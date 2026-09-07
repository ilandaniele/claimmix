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
import { contactDocsToClose } from "@/server/cases/documents";

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

/**
 * El teléfono de quien escribe por WhatsApp ya lo sabemos.
 *
 * Es el número desde el que está hablando: más confiable que si lo escribiera.
 * Igual se pedía, porque el par de contacto sólo miraba lo que apareciera en el
 * texto — y no se notaba porque el número entraba en el campo `email` y dejaba
 * el par satisfecho con un dato falso.
 *
 * Preguntarle a alguien el teléfono desde el que está escribiendo es de las
 * cosas que hacen que un asegurado deje de contestar.
 */
describe("parseEmailClaimFields — el teléfono del remitente", () => {
  function phoneField(fields: Array<{ field_key: string; field_value: string }>) {
    return fields.find((f) => f.field_key === "phone")?.field_value ?? null;
  }

  it("toma el número de quien escribe por WhatsApp", () => {
    const fields = parseEmailClaimFields({
      subject: "",
      body: "Hola, se me llenó el auto de abolladuras por el granizo.",
      senderEmail: "5491100000000",
    });

    expect(phoneField(fields)).toBe("5491100000000");
  });

  it("un remitente de mail no es un teléfono", () => {
    const fields = parseEmailClaimFields({
      subject: "Denuncia",
      body: "Choqué ayer.",
      senderEmail: "Ana Ruiz <ana.ruiz@correo.com.ar>",
    });

    expect(phoneField(fields)).toBeNull();
  });

  it("lo que escribió la persona le gana al remitente", () => {
    // Alguien puede escribir desde un teléfono y pedir que lo llamen a otro.
    const fields = parseEmailClaimFields({
      subject: "",
      body: "Choqué ayer. Teléfono: 11 2345-6789",
      senderEmail: "5491100000000",
    });

    expect(phoneField(fields)).not.toBe("5491100000000");
  });

  it("un identificador que no tiene forma de teléfono no se guarda", () => {
    const fields = parseEmailClaimFields({
      subject: "",
      body: "Choqué ayer.",
      senderEmail: "wamid-abc",
    });

    expect(phoneField(fields)).toBeNull();
  });
});

/**
 * Un contacto que ya tenemos no se pide.
 *
 * `telefono_contacto` se siembra desde la configuración del asegurador. Por
 * WhatsApp ese teléfono es el remitente — lo sabemos con más certeza que si lo
 * escribiera — y el pedido quedaba abierto igual. Un pedido abierto se
 * pregunta tarde o temprano.
 *
 * Sólo el par de contacto, y no cualquier dato pendiente: el contacto es la
 * identidad del transporte, un hecho; la hora del siniestro es una lectura del
 * texto. Cerrar un pedido por una interpretación es marcar como recibido algo
 * que nadie confirmó, y eso desaparece de la lista del analista sin que nadie
 * se entere.
 */
describe("contactDocsToClose", () => {
  it("cierra el teléfono cuando lo tenemos, con su alias", () => {
    const out = contactDocsToClose([{ field_key: "phone", field_value: "5491100000000" }]);
    expect(out).toContain("phone");
    expect(out).toContain("telefono_contacto");
  });

  it("no cierra un dato que no es contacto", () => {
    const out = contactDocsToClose([
      { field_key: "hora_siniestro", field_value: "20:30" },
      { field_key: "lugar_siniestro", field_value: "Alem al 500" },
    ]);
    expect(out).toHaveLength(0);
  });

  it("un valor vacío no cuenta como tenerlo", () => {
    expect(contactDocsToClose([{ field_key: "phone", field_value: "   " }])).toHaveLength(0);
    expect(contactDocsToClose([{ field_key: "phone", field_value: null }])).toHaveLength(0);
  });

  it("el mail también, que es la otra mitad del par", () => {
    const out = contactDocsToClose([{ field_key: "email", field_value: "ana@correo.com.ar" }]);
    expect(out).toContain("email");
  });
});

/**
 * El nombre que el canal ya entrega.
 *
 * Un caso real (7 de septiembre) recibió un mail que pedía «Nombre completo»
 * teniendo el nombre en el sobre: el `From` decía `Ilan Daniele <ilan…>` y el
 * único lugar de donde salía `full_name` era el texto del mensaje.
 *
 * Entra con confianza de banda media a propósito: desde 0.60 el analizador de
 * huecos lo cuenta como presente —o sea, deja de pedirse— y por debajo de 0.85
 * cae solo en `claim_field_confirmations` y sale como «entendimos "X"». Un
 * nombre visible lo configura quien escribe y no lo verifica nadie: alcanza
 * para saludar, no para darlo por cierto.
 */
describe("parseEmailClaimFields — el nombre del sobre", () => {
  function nombre(fields: ReturnType<typeof parseEmailClaimFields>) {
    return fields.find((f) => f.field_key === "full_name");
  }

  it("usa el nombre visible del From cuando el cuerpo no lo dice", () => {
    const campos = parseEmailClaimFields({
      subject: "Denuncia",
      body: "Buenas, ayer choqué en Alem al 2300. No hubo heridos. Póliza POL-4471-A.",
      senderEmail: "Ilan Daniele <ilan.daniele@gmail.com>",
    });

    expect(nombre(campos)?.field_value).toBe("Ilan Daniele");
  });

  it("con una confianza que lo hace preguntable y no incuestionable", () => {
    const campos = parseEmailClaimFields({
      subject: "",
      body: "Choqué ayer.",
      senderEmail: "Ilan Daniele <ilan.daniele@gmail.com>",
    });

    const campo = nombre(campos)!;
    expect(campo.confidence).toBeGreaterThanOrEqual(0.6);
    expect(campo.confidence).toBeLessThan(0.85);
    expect(campo.source).toBe("canal");
  });

  it("lo que escribió la persona le gana al sobre", () => {
    const campos = parseEmailClaimFields({
      subject: "",
      body: "Nombre completo: Martín Sosa - DNI: 30.145.882",
      senderEmail: "Ilan Daniele <ilan.daniele@gmail.com>",
    });

    expect(nombre(campos)?.field_value).toBe("Martín Sosa");
    expect(nombre(campos)?.source).toBe("ai");
  });

  it("un sobre que no trae un nombre de persona no produce campo", () => {
    // Peor que no tener nombre es tener uno malo: saluda mal, entra al prompt
    // del redactor y puede fabricar un conflicto contra el padrón.
    for (const sobre of [
      "iPhone de Juan <x@y.com>",
      "Transportes del Sur S.R.L. <ventas@sur.com>",
      "ana.ruiz@correo.com.ar",
    ]) {
      const campos = parseEmailClaimFields({ subject: "", body: "Choqué ayer.", senderEmail: sobre });
      expect(nombre(campos), sobre).toBeUndefined();
    }
  });

  it("por WhatsApp entra por el mismo camino, con el nombre de perfil", () => {
    // Ahí `senderEmail` es el teléfono pelado: el nombre viaja aparte.
    const campos = parseEmailClaimFields({
      subject: "WhatsApp",
      body: "Choqué ayer en Alem.",
      senderEmail: "5491100000000",
      senderName: "MARTIN SOSA",
    });

    // `titleCase` lo formatea: un perfil que grita no le grita al asegurado.
    expect(nombre(campos)?.field_value).toBe("Martin Sosa");
    expect(nombre(campos)?.source).toBe("canal");
  });

  it("y un nombre de perfil basura tampoco", () => {
    const campos = parseEmailClaimFields({
      subject: "WhatsApp",
      body: "Choqué ayer en Alem.",
      senderEmail: "5491100000000",
      senderName: "iPhone",
    });

    expect(nombre(campos)).toBeUndefined();
  });
});
