/**
 * La comprobación `sin-pedido` del ensayo sobre una derivación.
 *
 * Con `pideDatos`, la guarda del redactor, no podía fallar por lo que el
 * redactor escribió: la guarda ya lo había cambiado por el piso. Esto fija que
 * marque los pedidos que la guarda deja pasar y no marque los pisos.
 */

import { describe, it, expect } from "vitest";

import { pideAlgo } from "../../scripts/lib/pide-algo.mjs";
import { readable } from "@/core/email/texto-legible";
import { renderSpecialistEscalation } from "@/server/email/templates/specialist-escalation";
import { CUIDADO } from "@/core/mensajes/derivacion";

const tal = (texto: string) => readable(texto).toLowerCase();

describe("pideAlgo", () => {
  it.each([
    "Contanos cómo sigue todo.",
    "Decinos si necesitás algo más.",
    "Pasanos el número de póliza.",
    "Te pedimos que tengas a mano el DNI.",
    "Necesitamos tu DNI para seguir.",
    "¿Podés mandarnos las fotos?",
    "Podés mandarnos las fotos cuando puedas.",
    "Necesitamos que nos mandes el parte.",
    "Envianos las fotos.",
    "Mandanos el parte.",
    "Si tenés las fotos, podés mandarlas cuando puedas.",
  ])("pide: %s", (texto) => {
    expect(pideAlgo(tal(texto))).toBe(true);
  });

  it.each([
    `Hola, Laura. ${CUIDADO} Ya derivamos tu denuncia a un especialista, que se va a comunicar con vos.`,
    "Si necesitás asistencia urgente, llamá a la línea de emergencias de tu póliza.",
    "No necesitamos nada más de tu parte: un especialista se encarga.",
    "Por las características de lo que nos contás, la derivamos a un especialista.",
    "Por ahora no te pedimos nada más.",
    // El ofrecimiento del piso del mail, dicho por el redactor.
    "Si tenés más información, podés enviarla respondiendo este correo.",
    "Si querés agregar algo, podés contarlo respondiendo este mensaje.",
  ])("no pide: %s", (texto) => {
    expect(pideAlgo(tal(texto))).toBe(false);
  });

  it.each(["critical", "high", undefined])("el piso del mail (%s) no pide nada", (severity) => {
    const { html } = renderSpecialistEscalation({ caseId: "c-1", severity, heridos: true });
    expect(pideAlgo(tal(html))).toBe(false);
  });
});
