/**
 * La comprobación del ensayo que marca un «no hubo heridos» que nadie dijo.
 *
 * El 23/09 salió «• ¿Hubo personas lastimadas?: no» en tres escenarios y el
 * ensayo dio verde. Esto fija qué cuenta como proponer el «no» y qué es una
 * pregunta abierta, que tiene que seguir pasando.
 */

import { describe, it, expect } from "vitest";

import { proponeSinHeridos } from "../../scripts/lib/propone-sin-heridos.mjs";
import { readable } from "@/core/email/texto-legible";
import { renderDataConfirmationRequest } from "@/server/email/templates/data-confirmation-request";

const tal = (texto: string) => readable(texto).toLowerCase();

describe("proponeSinHeridos", () => {
  it.each([
    "• ¿Hubo personas lastimadas?: no",
    "• ¿No hubo personas lastimadas? no",
    "No hubo personas lastimadas, ¿es correcto?",
    "¿Es correcto que nadie resultó lastimado?",
    "Entendemos que fue sin heridos.",
    '• Si hubo personas lastimadas: entendimos "no"',
    "Campo: Si hubo personas lastimadas\n\nObtuvimos el siguiente dato de tu correo: no.",
  ])("propone: %s", (texto) => {
    expect(proponeSinHeridos(tal(texto))).toBe(true);
  });

  it.each([
    "¿Hubo personas lastimadas?",
    "• ¿Alguien resultó lastimado?",
    "¿Hubo o no hubo personas lastimadas?",
    "Decinos si hubo personas lastimadas.",
    "Contanos si no hubo heridos",
    "• ¿Hubo personas lastimadas? No hace falta que sepas los nombres.",
    "• Fecha: no la sabemos",
    "Campo: Si hubo personas lastimadas\nDecinos si alguien salió lastimado.",
  ])("pregunta abierto: %s", (texto) => {
    expect(proponeSinHeridos(tal(texto))).toBe(false);
  });

  it("marca el piso de confirmación tal como sale", () => {
    const { html } = renderDataConfirmationRequest({
      caseId: "0001",
      fieldKey: "hay_heridos",
      proposedValue: "no",
    });

    expect(proponeSinHeridos(tal(html))).toBe(true);
  });

  it("y no la pregunta abierta del mismo piso", () => {
    const { html } = renderDataConfirmationRequest({
      caseId: "0001",
      fieldKey: "hay_heridos",
      proposedValue: "",
    });

    expect(proponeSinHeridos(tal(html))).toBe(false);
  });
});
