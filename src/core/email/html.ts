/**
 * Texto que escribió alguien, convertido en HTML sin dejar de ser texto.
 *
 * Vive en el núcleo porque lo usan las plantillas del servidor y lo prueba una
 * batería sin base ni red, y porque desde que el cuerpo del mail lo redacta el
 * modelo hay dos entradas a escapar y no una: los datos de la plantilla y la
 * prosa que vuelve del redactor.
 */

/**
 * Escapa un valor para meterlo adentro de HTML.
 *
 * ── Por qué hace falta, y qué se podía hacer sin esto ───────────────────────
 *
 * Todo lo que estas plantillas interpolan viene, directa o indirectamente, de
 * un correo que escribió un desconocido: el nombre del asegurado, el lugar del
 * siniestro, la patente, y hasta el NOMBRE de un campo —el modelo puede
 * inventar una clave, y `humanizeKey` la muestra tal cual—.
 *
 * Un nombre como `Juan <a href="https://evil.tld">Cobrá tu indemnización acá</a>`
 * salía entero adentro de un `<strong>`. Y el destinatario lo elige el mismo
 * atacante: el mail sale a la dirección del `From` del correo entrante, que
 * nadie verifica. O sea que alcanza con escribirle al buzón de ingreso poniendo
 * en el From la casilla de la víctima, y la aseguradora le manda —desde su
 * propio dominio, firmado con su DKIM— el enlace que el atacante eligió.
 *
 * Eso es phishing con la reputación de la aseguradora. En los clientes de
 * correo que todavía ejecutan script además es XSS; en los demás es inyección
 * de HTML, que para este producto es igual de grave.
 *
 * ── Sólo para el HTML ───────────────────────────────────────────────────────
 *
 * La versión `text` de cada plantilla NO se escapa, y no es un olvido: ahí
 * `&amp;` se leería literal. Un correo en texto plano no interpreta marcado, así
 * que no hay nada de qué escaparse.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Un cuerpo en texto plano, convertido en los párrafos y la lista que un
 * cliente de correo sabe mostrar.
 *
 * Escapa PRIMERO y envuelve después, y el orden no es negociable: al revés se
 * escapan las etiquetas propias y el asegurado lee `&lt;p&gt;`. Lo que entra
 * acá puede venir del redactor, y lo que el redactor escribe está condicionado
 * por el último mensaje —o sea, por lo que escribió un desconocido—.
 *
 * Las líneas que empiezan con `- ` salen como lista porque es exactamente la
 * forma que el prompt de mail le pide al modelo.
 */
export function textoAHtml(texto: string): string {
  const partes: string[] = [];

  for (const bloque of escapeHtml(texto).split(/\n\s*\n/)) {
    const lineas = bloque
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    let parrafo: string[] = [];
    let items: string[] = [];

    const cerrarParrafo = () => {
      if (parrafo.length === 0) return;
      partes.push(`<p>${parrafo.join("<br />")}</p>`);
      parrafo = [];
    };
    const cerrarLista = () => {
      if (items.length === 0) return;
      partes.push(`<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`);
      items = [];
    };

    for (const linea of lineas) {
      const item = /^[-*•]\s+(.*)$/.exec(linea);
      if (item) {
        cerrarParrafo();
        items.push(item[1]);
      } else {
        cerrarLista();
        parrafo.push(linea);
      }
    }

    cerrarParrafo();
    cerrarLista();
  }

  return partes.join("\n  ");
}
