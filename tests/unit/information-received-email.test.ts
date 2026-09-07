/**
 * El acuse de recibo por mail.
 *
 * Es el PISO: lo que sale con el redactor apagado y cuando una guarda rebota.
 * Las dos cosas que tiene que hacer son opuestas entre sí y las dos importan:
 * decir que tomamos nota, y no volver a pedir lo que pedimos hace un minuto.
 */

import { describe, it, expect } from "vitest";
import { renderInformationReceived } from "@/server/email/templates/information-received";

const CASE = "11111111-1111-1111-1111-111111111111";

describe("renderInformationReceived", () => {
  it("dice que tomamos nota", () => {
    const mail = renderInformationReceived({ caseId: CASE });
    expect(mail.text.toLowerCase()).toContain("tomamos nota");
    expect(mail.html.toLowerCase()).toContain("tomamos nota");
  });

  it("no inventa un detalle que no tiene", () => {
    // Inventar un detalle para que la frase suene más atenta es la forma más
    // barata de que un mensaje deje de ser creíble. Acá vivía `noted` —el
    // detalle a nombrar— y nadie lo seteó nunca: era un parámetro muerto
    // declarado en los dos canales.
    const mail = renderInformationReceived({ caseId: CASE });
    expect(mail.text).toContain("de lo que nos contaste");
  });

  it("saluda por su nombre cuando el caso ya lo tiene", () => {
    // El orquestador lo mandaba y este armador lo descartaba: el producto
    // saludaba por nombre en un mensaje y en el siguiente no.
    const mail = renderInformationReceived({ caseId: CASE, claimantName: "Diego" });
    expect(mail.text).toContain("Diego, gracias");
    expect(mail.html).toContain("Diego, gracias");
  });

  it("y sin nombre la oración sigue empezando en mayúscula", () => {
    const mail = renderInformationReceived({ caseId: CASE });
    expect(mail.text.startsWith("Gracias, tomamos nota")).toBe(true);
  });

  it("no repite el pedido ni dice que está completo", () => {
    const mail = renderInformationReceived({ caseId: CASE });
    const body = (mail.text + mail.html).toLowerCase();

    expect(body).not.toContain("necesitamos que nos");
    expect(body).not.toContain("póliza");
    expect(body).not.toContain("dni");
    expect(body).not.toContain("todo lo necesario");
  });

  it("lleva el número de caso, como todo lo que sale", () => {
    const mail = renderInformationReceived({ caseId: CASE });
    expect(mail.text).toContain(CASE);
    expect(mail.subject).toContain(CASE);
  });
});
