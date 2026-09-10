/**
 * El transcripto del ensayo, que es lo único que una persona lee de verdad.
 *
 * Los tests de la corrida afirman sobre estados y claves. Lo que NO pueden ver
 * es una respuesta que pasa todas las afirmaciones y suena mal, y para eso está
 * el transcripto — así que si el transcripto miente, esa red no existe.
 *
 * Esta función se cambió cuatro veces en un día. Vivía adentro de
 * `rehearse-conversations.mts`, un script de top-level await que no se puede
 * importar sin correrlo, así que cada cambio se verificó a mano en un archivo
 * temporal que se borró al cerrar la sesión. Ahora está afuera y esto es la
 * verificación que queda.
 */

import { describe, it, expect } from "vitest";

import {
  readable,
  sinEntidades,
  sinEtiquetas,
  unaPasada,
} from "../../scripts/lib/texto-legible.mjs";

describe("lo que el transcripto tiene que mostrar bien", () => {
  it("un correo con formato se lee como texto", () => {
    const html = "<div><p>Tuve un choque en Corrientes</p><p>Ayer a la tarde</p></div>";
    expect(readable(html)).toBe("Tuve un choque en Corrientes\nAyer a la tarde");
  });

  it("una lista de documentos queda como lista", () => {
    const html = "<ul><li>El DNI</li><li>Fotos de los daños</li></ul>";
    expect(readable(html)).toBe("• El DNI\n• Fotos de los daños");
  });

  it("el texto sin marcado sale igual y sin tocar", () => {
    expect(readable("Hola, tuve un choque.")).toBe("Hola, tuve un choque.");
  });

  it("las comillas y el ampersand se leen, no como entidad", () => {
    // Se veían crudas en el transcripto: «entendimos &quot;16/08/2026&quot;».
    expect(readable("<p>entendimos &quot;16/08/2026&quot; &amp; la patente</p>")).toBe(
      'entendimos "16/08/2026" & la patente'
    );
  });
});

describe("lo que el transcripto NO puede tapar", () => {
  it("un `<` bien escapado no se lee igual que uno crudo", () => {
    /*
     * `&amp;lt;` es un `<` que escribió un desconocido y el escape convirtió
     * BIEN. Si el decode del ampersand corriera primero, volvería a `<` y el
     * transcripto se leería igual de tranquilizador estuviera bien o mal
     * escapado — que es justo lo que no puede pasar.
     */
    expect(sinEntidades("&amp;lt;b&amp;gt;")).toBe("&lt;b&gt;");
  });

  it("un script escondido en entidades no sobrevive", () => {
    // El decode corría al FINAL: `&lt;script&gt;` atravesaba entero el borrado
    // de etiquetas —no hay ninguna que borrar— y recién ahí se volvía markup.
    // Se va el bloque entero, no sólo las etiquetas: una vez decodificado, la
    // regla de `<script>…</script>` lo reconoce y se lleva el cuerpo también.
    expect(readable("&lt;script&gt;alert(1)&lt;/script&gt;Hola")).toBe("Hola");
  });

  it("el cierre con espacio o atributos también cierra", () => {
    // `</script >` no matcheaba, así que el cuerpo del script terminaba en el
    // transcripto como si lo hubiera escrito una persona.
    for (const cierre of ["</script >", "</script foo>", "</script\n>"]) {
      expect(readable(`<script>var x = 1;</script${cierre.slice(8)}Hola`)).not.toContain("var x");
    }
    expect(readable("<script>var x = 1;</script >Hola")).toBe("Hola");
  });

  it("una etiqueta anidada no se reconstruye al borrar", () => {
    // Borrar `<…>` una sola vez deja `<<a>script>` convertido en `<script>`:
    // la pasada construye lo que venía a sacar.
    expect(sinEtiquetas("<<a>script>x")).not.toContain("<script>");
  });

  it("y `<script>` partido por otra etiqueta tampoco", () => {
    expect(sinEtiquetas("<scr<script>ipt>alert(1)</script>Hola")).not.toContain("script>alert");
  });
});

describe("el bucle termina", () => {
  it("ninguna pasada alarga el texto", () => {
    /*
     * La propiedad de la que depende que el bucle SIN TOPE termine: cada pasada
     * o borra, o cambia una secuencia por una más corta (`</p>` y `<br>` por un
     * salto, `<li…>` por «• »). Un largo que no puede crecer y que corta al
     * repetirse termina siempre.
     *
     * Si alguien agrega un reemplazo que alarga —una etiqueta por una palabra,
     * digamos— esto se cae antes de que el ensayo se cuelgue.
     */
    const muestras = [
      "<p>a</p>",
      "<li>x</li>",
      "<br/>",
      "<<a>script>x</script>",
      "<scr<script>ipt>y</script>",
      "texto pelado",
      "<div><span>z</span></div>",
      '<li class="una clase larguísima">z',
      "<head><meta/></head>cuerpo",
    ];
    for (const m of muestras) {
      expect(unaPasada(m).length).toBeLessThanOrEqual(m.length);
    }
  });

  it("un texto ya limpio es punto fijo en la primera vuelta", () => {
    expect(unaPasada("Hola, tuve un choque")).toBe("Hola, tuve un choque");
  });
});

describe("lo que se conserva", () => {
  it("no se come el texto que está al lado de un script", () => {
    expect(readable("<script>var x = 1;</script ><p>Tuve un siniestro</p>")).toBe(
      "Tuve un siniestro"
    );
  });

  it("no deja líneas en blanco de más", () => {
    // Un transcripto con tres saltos entre cada frase es un transcripto que
    // nadie lee, que es la mitad del punto de esto.
    expect(readable("<p>una</p><br/><br/><br/><p>otra</p>")).toBe("una\n\notra");
  });
});
