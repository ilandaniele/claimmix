/**
 * El ancho de una barra, como clase y no como atributo `style`.
 *
 * Existe para poder sacar `unsafe-inline` de `style-src`. Con esa directiva
 * puesta, cualquier punto de inyección de HTML permite meter CSS: exfiltrar
 * datos con selectores de atributo más `background-image`, tapar botones,
 * dibujar encima de lo que la persona cree que está apretando. Con `script-src`
 * ya cerrado, el CSS inyectado es la palanca que queda.
 *
 * Un nonce no alcanza —vale para bloques `<style>`, no para atributos `style`
 * del marcado— y se comprobó en el navegador: con `style-src 'self' 'nonce-…'`
 * el atributo queda en el DOM y NO se aplica, así que la barra medía lo que
 * midiera su contenedor. Silencioso y equivocado.
 */

import { describe, it, expect } from "vitest";

import { anchoDeBarra } from "@/lib/ui/ancho-de-barra";

describe("anchoDeBarra", () => {
  it("los extremos usan las clases enteras de Tailwind", () => {
    expect(anchoDeBarra(0)).toBe("w-0");
    expect(anchoDeBarra(100)).toBe("w-full");
  });

  it("redondea al 5% más cercano", () => {
    // El costo declarado: una barra al 5% más cercano. El número exacto se
    // sigue mostrando en texto al lado.
    expect(anchoDeBarra(42)).toBe("w-[40%]");
    expect(anchoDeBarra(43)).toBe("w-[45%]");
    expect(anchoDeBarra(87.5)).toBe("w-[90%]");
  });

  it("acota lo que se sale del rango en vez de devolver basura", () => {
    expect(anchoDeBarra(-10)).toBe("w-0");
    expect(anchoDeBarra(150)).toBe("w-full");
  });

  it("un número que no es número da la barra vacía, no una clase rota", () => {
    /*
     * `Number(undefined)` es NaN y sale de los bordes: una confianza que la
     * base entregó como texto, un campo sin valor. Sin esto, la clase sería
     * `undefined` y en el `className` quedaría la palabra «undefined».
     *
     * Una barra que no se dibuja es mejor que una que se dibuja mal.
     */
    expect(anchoDeBarra(NaN)).toBe("w-0");
    expect(anchoDeBarra(Infinity)).toBe("w-0");
  });

  it("todas las clases que puede devolver son literales del módulo", async () => {
    /*
     * Tailwind compila sólo las clases que encuentra ESCRITAS en el código. Una
     * armada con plantilla —`w-[${pct}%]`— no existiría en la hoja de estilos y
     * la barra no tendría ancho.
     *
     * Esto comprueba que ninguna salida se arma dinámicamente: las veintiuna
     * tienen que estar en el archivo, tal cual.
     */
    const { readFileSync } = await import("node:fs");
    const fuente = readFileSync("src/lib/ui/ancho-de-barra.ts", "utf8");

    for (let pct = 0; pct <= 100; pct++) {
      const clase = anchoDeBarra(pct);
      expect(fuente).toContain(`"${clase}"`);
    }
  });

  it("cubre los 21 escalones, sin huecos", () => {
    const vistas = new Set(
      Array.from({ length: 101 }, (_, i) => anchoDeBarra(i))
    );
    expect(vistas.size).toBe(21);
  });
});
