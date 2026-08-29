/**
 * Lo que escribe un desconocido no puede salir como marcado en un correo
 * nuestro.
 *
 * ── Qué se podía hacer sin esto ─────────────────────────────────────────────
 *
 * Todo lo que estas plantillas interpolan viene, directa o indirectamente, de
 * un correo que escribió alguien de afuera: el nombre del asegurado, el lugar
 * del siniestro, la patente, y hasta el NOMBRE del campo —el modelo puede
 * inventar una clave y `humanizeKey` la muestra tal cual—.
 *
 * Un nombre como `Juan <a href="https://evil.tld">Cobrá acá</a>` salía entero
 * adentro de un `<strong>`. Y el destinatario lo elegía el mismo atacante: el
 * mail sale a la dirección del `From` del correo entrante, que nadie verifica.
 * Alcanzaba con escribirle al buzón de ingreso poniendo en el From la casilla
 * de la víctima, y la aseguradora le mandaba —desde su propio dominio, firmado
 * con su DKIM— el enlace que el atacante eligió.
 *
 * Eso es phishing con la reputación de la aseguradora. En los clientes de
 * correo que todavía ejecutan script además es XSS.
 *
 * ── Qué se afirma acá ───────────────────────────────────────────────────────
 *
 * Que el HTML que sale no contenga las cargas sin escapar. NO que no contenga
 * `<` —el HTML de la plantilla tiene etiquetas de verdad— sino que lo que
 * ENTRÓ como dato salga convertido en entidades.
 *
 * Y que la versión `text` NO se escape, que es igual de deliberado: un correo
 * en texto plano no interpreta marcado, y ahí `&amp;` se leería literal.
 */

import { describe, it, expect } from "vitest";

import { escapeHtml, renderTemplate } from "@/server/email/render";

/** Las cargas que un atacante pondría. */
const CARGAS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  '<a href="https://evil.tld">Cobrá tu indemnización acá</a>',
  "<img src='https://evil.tld/px.gif'>",
];

describe("escapeHtml", () => {
  it("convierte los cinco caracteres que importan", () => {
    expect(escapeHtml('<a href="x">&\'</a>')).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;"
    );
  });

  it("escapa el ampersand PRIMERO, o rompería las entidades que acaba de crear", () => {
    // Si `&` se escapara al final, `<` ya sería `&lt;` y quedaría `&amp;lt;`.
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("no toca un texto normal", () => {
    expect(escapeHtml("Juan Pérez, Av. Corrientes 1234")).toBe(
      "Juan Pérez, Av. Corrientes 1234"
    );
  });
});

describe("las plantillas no dejan pasar marcado ajeno", () => {
  it.each(CARGAS)("data_confirmation_request con %s", (carga) => {
    const r = renderTemplate("data_confirmation_request", {
      caseId: "caso-1",
      fieldKey: "full_name",
      proposedValue: carga,
      conflictWithValue: carga,
    });

    expect(r.html).not.toContain(carga);
    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("evil.tld\">");
    // La otra mitad: el dato SÍ está, escapado. Una plantilla que tirara el
    // valor también pasaría la afirmación de arriba.
    expect(r.html).toContain("&lt;");
  });

  it.each(CARGAS)("missing_information_request con %s", (carga) => {
    const r = renderTemplate("missing_information_request", {
      caseId: "caso-1",
      missingFields: [carga],
    });

    expect(r.html).not.toContain(carga);
    expect(r.html).not.toContain("<script>");
  });

  it.each(CARGAS)("confirmation_received con %s", (carga) => {
    const r = renderTemplate("confirmation_received", {
      caseId: carga,
      claimType: "choque",
      policyNumber: carga,
    });

    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("evil.tld\">");
  });

  it.each(CARGAS)("specialist_escalation con %s", (carga) => {
    const r = renderTemplate("specialist_escalation", {
      caseId: carga,
      severity: "high",
    });

    expect(r.html).not.toContain("<script>");
    expect(r.html).not.toContain("evil.tld\">");
  });

  it("un nombre de campo inventado por el modelo tampoco pasa", () => {
    /*
     * Éste es el que menos se ve venir: la ETIQUETA del campo.
     *
     * `humanizeKey` toma una clave desconocida, la pasa a minúscula y parte por
     * `_ - .`. No escapa nada. Y la clave la puede influenciar quien escribe el
     * correo, porque la inventa el modelo leyendo ese texto.
     */
    const r = renderTemplate("data_confirmation_request", {
      caseId: "caso-1",
      fieldKey: "<img src=x onerror=alert(1)>",
      proposedValue: "Juan Pérez",
    });

    expect(r.html).not.toContain("<img src=x");
  });
});

describe("la versión en texto plano NO se escapa", () => {
  it("porque ahí las entidades se leerían literales", () => {
    const r = renderTemplate("data_confirmation_request", {
      caseId: "caso-1",
      fieldKey: "full_name",
      proposedValue: "Juan & Asociados",
    });

    // En el texto va el ampersand de verdad…
    expect(r.text).toContain("Juan & Asociados");
    expect(r.text).not.toContain("&amp;");
    // …y en el HTML, la entidad.
    expect(r.html).toContain("&amp;");
  });
});
