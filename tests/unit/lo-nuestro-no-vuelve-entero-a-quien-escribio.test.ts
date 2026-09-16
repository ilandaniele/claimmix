/**
 * Lo que tenemos guardado de un asegurado no vuelve entero a quien escribió.
 *
 * El mensaje de conflicto sale cuando un mensaje entrante coincide con un
 * cliente por DNI o por póliza y el nombre o el correo NO coinciden. Con el
 * nombre y el correo del padrón enteros adentro, quien tuviera —o adivinara—
 * un DNI se llevaba los datos del titular sin autenticarse contra nada.
 *
 * `enmascararCampo` es el único lugar que decide esto, y lo usan los dos
 * canales: el correo (a través de `data-confirmation-request.ts`) y WhatsApp
 * (a través de `messenger.ts`). Acá se prueba la función sola y, después, que
 * la plantilla de correo —el único canal que arma HTML— la respete.
 */

import { describe, it, expect } from "vitest";
import { enmascararCampo, maskFullName, renderTemplate } from "../../src/server/email/render";

describe("enmascararCampo", () => {
  it("el nombre de nuestro padrón sale en iniciales, no entero", () => {
    expect(enmascararCampo("full_name", "Roberto Paz", "padron")).toBe("R*** P***");
  });

  it("y el correo, sin la casilla", () => {
    expect(enmascararCampo("email", "algo@example.com", "padron")).toBe("a***@example.com");
  });

  it("lo que escribió el remitente vuelve como lo escribió", () => {
    // Repetirle a alguien lo que acaba de mandar no le revela nada, y sin el
    // valor propuesto a la vista el mensaje no dice qué hay que corregir.
    expect(enmascararCampo("full_name", "Roberto Paz", "remitente")).toBeNull();
    expect(enmascararCampo("email", "algo@example.com", "remitente")).toBeNull();
  });

  it("el documento y la póliza se enmascaran vengan de donde vengan", () => {
    expect(enmascararCampo("dni", "12345678", "remitente")).toBe("****5678");
    expect(enmascararCampo("dni", "12345678", "padron")).toBe("****5678");
    expect(enmascararCampo("policy_number", "POL-12345678", "remitente")).toBe("POL-****5678");
    expect(enmascararCampo("policy_number", "POL-12345678", "padron")).toBe("POL-****5678");
  });

  it("un campo que no es de nadie no se toca", () => {
    expect(enmascararCampo("accident_date", "16/08/2026", "padron")).toBeNull();
  });
});

describe("el mensaje de conflicto", () => {
  it("no le devuelve a quien escribió el nombre ni el correo que tenemos guardados", () => {
    const { html, text } = renderTemplate("data_confirmation_request", {
      caseId: "c-1",
      fields: [
        { fieldKey: "full_name", proposedValue: "Pedro García", conflictWithValue: "Roberto Paz" },
        { fieldKey: "email", proposedValue: "pedro@example.com", conflictWithValue: "algo@example.com" },
      ],
    });

    for (const cuerpo of [html, text]) {
      expect(cuerpo).not.toContain("Roberto Paz");
      expect(cuerpo).not.toContain("algo@example.com");
      expect(cuerpo).toContain("R*** P***");
      expect(cuerpo).toContain("a***@example.com");
      expect(cuerpo).toContain("Pedro García");
    }
  });
});
