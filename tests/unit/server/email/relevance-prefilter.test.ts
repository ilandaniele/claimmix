import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { classifyInboundEmailForIntake } from "@/server/email/relevance-prefilter";

describe("classifyInboundEmailForIntake", () => {
  it("skips empty Meta for Business notifications", () => {
    expect(
      classifyInboundEmailForIntake({
        fromAddr: "Meta for Business <notification@facebookmail.com>",
        subject: "Meta for Business notification",
        bodyText: "",
        bodyHtml: "",
      })
    ).toMatchObject({
      action: "skip",
      category: "automated_non_claim",
    });
  });

  it("allows messages with claim signals even from automated-looking senders", () => {
    expect(
      classifyInboundEmailForIntake({
        fromAddr: "notificaciones@example.com",
        subject: "Nuevo siniestro por choque",
        bodyText: "El asegurado informa una poliza y patente.",
        bodyHtml: "",
      })
    ).toEqual({ action: "allow" });
  });

  it("allows ordinary thin messages instead of dropping ambiguous mail", () => {
    expect(
      classifyInboundEmailForIntake({
        fromAddr: "cliente@example.com",
        subject: "Consulta",
        bodyText: "Hola",
        bodyHtml: "",
      })
    ).toEqual({ action: "allow" });
  });

  it("skips bulk mail with no claim signal", () => {
    expect(
      classifyInboundEmailForIntake({
        fromAddr: "news@example.com",
        subject: "Monthly update",
        bodyText: "Product newsletter",
        bodyHtml: "",
        headers: [{ name: "List-Unsubscribe", value: "<mailto:unsubscribe@example.com>" }],
      })
    ).toMatchObject({
      action: "skip",
      category: "bulk_non_claim",
    });
  });
});

/*
 * El newsletter del rubro, que es el único que este filtro no podía frenar.
 *
 * La señal de siniestro devolvía `allow` de entrada y las cabeceras no se
 * miraban nunca. Un newsletter de seguros habla de seguros, así que «Novedades
 * del sector asegurador» contenía «asegurado» y pasaba de largo: llegaba al
 * modelo, gastaba diez mil tokens y volvía clasificado como irrelevante.
 *
 * El ensayo tenía un escenario para esto desde siempre y no lo agarraba, porque
 * afirmaba `replies: 0` y el agente se quedaba callado igual.
 */
describe("un newsletter que habla de seguros", () => {
  it("se frena por la cabecera, aunque el texto tenga señal de siniestro", () => {
    expect(
      classifyInboundEmailForIntake({
        fromAddr: "novedades@camara-aseguradores.example.com",
        subject: "NEWSLETTER SEPTIEMBRE — Novedades del sector asegurador",
        bodyText: "Siniestralidad del trimestre, nuevas polizas y cobertura de granizo.",
        bodyHtml: "",
        headers: [{ name: "List-Unsubscribe", value: "<https://x.example.com/baja>" }],
      })
    ).toMatchObject({
      action: "skip",
      reason: "mailing_list_unsubscribe_header",
    });
  });

  it("y una denuncia de verdad con las mismas palabras sigue entrando", () => {
    // La mitad que importa. Un filtro que frena de más no se nota hasta que
    // alguien reclama que denunció y nadie le contestó, y para entonces el mail
    // no está en ningún lado.
    expect(
      classifyInboundEmailForIntake({
        fromAddr: "carla@example.com",
        subject: "Choque en Bahia Blanca",
        bodyText: "Ayer choqué en Alem al 2300. Soy asegurada, poliza POL-8812-C.",
        bodyHtml: "",
      })
    ).toEqual({ action: "allow" });
  });

  it("la palabra «desuscribirte» en el cuerpo no alcanza para frenar nada", () => {
    // Lo que decide es la cabecera que pone quien manda la lista, no una palabra
    // que un denunciante podría escribir por su cuenta.
    expect(
      classifyInboundEmailForIntake({
        fromAddr: "carla@example.com",
        subject: "Choque",
        bodyText: "Choqué el auto. Avisame cómo seguir, y si querés desuscribirte de algo decime.",
        bodyHtml: "",
      })
    ).toEqual({ action: "allow" });
  });

  it("un mail reenviado en automático con señal de siniestro sigue entrando", () => {
    // `Auto-Submitted` se dejó a propósito DEBAJO de la señal de siniestro: una
    // denuncia reenviada por una regla del buzón la trae, y es una denuncia.
    expect(
      classifyInboundEmailForIntake({
        fromAddr: "mesa@example.com",
        subject: "Reenvío: siniestro de granizo",
        bodyText: "El asegurado reporta granizo sobre el techo del vehículo.",
        bodyHtml: "",
        headers: [{ name: "Auto-Submitted", value: "auto-forwarded" }],
      })
    ).toEqual({ action: "allow" });
  });
});

/**
 * El cuerpo de un `<script>` no es texto que escribió una persona.
 *
 * `visibleHtmlText` sacaba `<script>…</script>` con el `>` pegado al nombre.
 * HTML acepta espacio, salto de línea y hasta atributos antes del cierre, así
 * que un cuerpo que cierre de cualquiera de esas formas se escapaba del primer
 * `replace`, y el segundo —el que borra etiquetas— dejaba el CÓDIGO adentro del
 * texto sobre el que se decide si el correo parece una denuncia.
 *
 * Quien manda el mail elige qué palabras poner ahí. `js/bad-tag-filter`.
 */
describe("el cierre de <script> con espacio o atributos", () => {
  const NEWSLETTER = {
    fromAddr: "novedades@example.com",
    subject: "Newsletter",
    bodyText: "",
    headers: [{ name: "Precedence", value: "bulk" }],
  };

  it("no deja pasar un newsletter que esconde la señal en un script", () => {
    // Sin el arreglo, «siniestro» del cuerpo del script cuenta como señal de
    // denuncia y el newsletter entra: una extracción pagada por mail.
    expect(
      classifyInboundEmailForIntake({
        ...NEWSLETTER,
        bodyHtml: '<script>var x = "siniestro poliza";</script >Promociones',
      })
    ).toMatchObject({ action: "skip" });
  });

  it("tampoco con atributos en la etiqueta de cierre", () => {
    expect(
      classifyInboundEmailForIntake({
        ...NEWSLETTER,
        bodyHtml: '<script>var x = "siniestro poliza";</script foo>Promociones',
      })
    ).toMatchObject({ action: "skip" });
  });

  it("ni con un salto de línea antes del mayor", () => {
    expect(
      classifyInboundEmailForIntake({
        ...NEWSLETTER,
        bodyHtml: '<script>var x = "siniestro poliza";</script\n>Promociones',
      })
    ).toMatchObject({ action: "skip" });
  });

  it("y el cierre normal sigue funcionando", () => {
    // El control: si el primer `replace` dejara de matchear el caso común, los
    // tres de arriba pasarían por el motivo equivocado.
    expect(
      classifyInboundEmailForIntake({
        ...NEWSLETTER,
        bodyHtml: '<script>var x = "siniestro poliza";</script>Promociones',
      })
    ).toMatchObject({ action: "skip" });
  });

  it("pero una denuncia de verdad en el cuerpo visible sí entra", () => {
    // La otra dirección: sacar el script no puede llevarse el texto de al lado.
    expect(
      classifyInboundEmailForIntake({
        ...NEWSLETTER,
        headers: [],
        bodyHtml: "<script>var x = 1;</script ><p>Tuve un siniestro con mi poliza</p>",
      })
    ).toEqual({ action: "allow" });
  });
});
