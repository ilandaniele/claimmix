/**
 * La prosa del redactor, convertida en HTML sin volverse marcado.
 *
 * Es la vía nueva y la peligrosa. Lo que el modelo escribe está condicionado
 * por el último mensaje del asegurado —o sea, por lo que escribió un
 * desconocido— y el destinatario lo elige ese mismo desconocido con el `From`
 * del entrante, que nadie verifica. Un `<a href>` que sobreviva sale firmado
 * con el DKIM de la aseguradora.
 *
 * Y `readable()` del ensayo borra las etiquetas: si esto se rompe, el
 * transcripto no lo muestra.
 */

import { describe, it, expect } from "vitest";
import { textoAHtml } from "@/core/email/html";

describe("textoAHtml", () => {
  it("escapa PRIMERO y envuelve después", () => {
    // Al revés se escapan las etiquetas propias y el asegurado lee `&lt;p&gt;`.
    const out = textoAHtml("Hola");
    expect(out).toBe("<p>Hola</p>");
    expect(out).not.toContain("&lt;p&gt;");
  });

  it("un enlace inyectado sale como entidad y no desaparece", () => {
    const out = textoAHtml('Mirá <a href="https://evil.tld">acá</a>');

    expect(out).not.toContain('<a href="https://evil.tld"');
    expect(out).toContain("&lt;a href=&quot;https://evil.tld&quot;&gt;");
  });

  it("no escapa dos veces", () => {
    // `&amp;amp;` le muestra a la persona el literal en vez del ampersand.
    expect(textoAHtml("Juan & Asociados")).toBe("<p>Juan &amp; Asociados</p>");
  });

  it("una línea en blanco produce párrafos de verdad", () => {
    /*
     * Sin esto el ensayo miente: `readable()` corta por los `\n` del fuente, así
     * que el transcripto mostraría párrafos que el cliente de correo no muestra.
     */
    const out = textoAHtml("Primero.\n\nSegundo.");

    expect(out).toContain("<p>Primero.</p>");
    expect(out).toContain("<p>Segundo.</p>");
  });

  it("un salto simple adentro de un párrafo no lo parte", () => {
    expect(textoAHtml("Una línea\ny la otra")).toBe("<p>Una línea<br />y la otra</p>");
  });

  it("las líneas que empiezan con guion salen como lista", () => {
    // Es exactamente la forma que el prompt de mail le pide al modelo.
    const out = textoAHtml("Necesitamos:\n- El DNI\n- La póliza");

    expect(out).toContain("<p>Necesitamos:</p>");
    expect(out).toContain("<ul><li>El DNI</li><li>La póliza</li></ul>");
  });

  it("y lo que sigue a la lista vuelve a ser un párrafo", () => {
    const out = textoAHtml("- Uno\n- Dos\nRespondé este correo.");

    expect(out).toContain("<ul><li>Uno</li><li>Dos</li></ul>");
    expect(out).toContain("<p>Respondé este correo.</p>");
  });

  it("un texto vacío no produce un párrafo vacío", () => {
    expect(textoAHtml("   \n\n  ")).toBe("");
  });
});
