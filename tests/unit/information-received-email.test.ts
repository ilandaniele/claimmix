/**
 * El acuse de recibo por mail.
 *
 * El correo no pasa por el redactor: arma HTML con la plantilla, así que lo
 * que diga la plantilla es literalmente lo que lee la persona. Las dos cosas
 * que tiene que hacer son opuestas entre sí y las dos importan: decir que
 * tomamos nota, y no volver a pedir lo que pedimos hace un minuto.
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

  it("nombra lo que anotó cuando lo sabe", () => {
    const mail = renderInformationReceived({ caseId: CASE, noted: "un choque de ayer a la tarde" });
    expect(mail.text).toContain("un choque de ayer a la tarde");
  });

  it("sin dato concreto no inventa uno", () => {
    // Inventar un detalle para que la frase suene más atenta es la forma más
    // barata de que un mensaje deje de ser creíble.
    const mail = renderInformationReceived({ caseId: CASE, noted: null });
    expect(mail.text).toContain("de lo que nos contaste");
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
