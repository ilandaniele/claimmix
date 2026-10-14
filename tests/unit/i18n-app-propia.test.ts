/**
 * Los textos de la app propia: el asistente (`appPropia.*`, que la página pasa como prop al panel) y las
 * páginas legales de cada espacio (`legal.*`) con el enlace de /preparando y /configuracion
 * (`enlaceWaba.app.*`). Todos están en el diccionario del servidor.
 *
 * Barre por prefijo, como "las cinco pantallas nuevas están traducidas de verdad" en i18n.test.ts:
 * una clave nueva queda cubierta sola. Los tipos ya obligan a que existan en los dos idiomas; esto
 * comprueba lo que los tipos no ven (vacías, copiadas, marcadores que no coinciden).
 */

import { describe, expect, it } from "vitest";

import { enUSServidor } from "@/lib/i18n/en-US.servidor";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";

type Par = { nombre: string; es: Record<string, string>; en: Record<string, string>; prefijos: string[] };

const PARES: Par[] = [
  { nombre: "el asistente (como prop)", es: esARServidor, en: enUSServidor, prefijos: ["appPropia."] },
  {
    nombre: "las páginas legales y el enlace (servidor)",
    es: esARServidor,
    en: enUSServidor,
    prefijos: ["legal.", "enlaceWaba.app.", "waba.ayuda.asuntoApp"],
  },
];

/** `{empresa}`, `{n}`…: lo que el código reemplaza, ordenado para comparar. */
const marcadores = (texto: string) => [...texto.matchAll(/\{[a-zA-Z0-9_]+\}/g)].map((m) => m[0]).sort();

/** «todo» es castellano: la marca va en mayúsculas. */
const PENDIENTE = /\b(TODO|FIXME|XXX)\b|lorem ipsum/;

/*
 * Las que se escriben igual en los dos idiomas a propósito (nombres propios, siglas, URLs). Van
 * enumeradas: la lista corta afirma que se las miró una por una.
 */
const IGUALES_A_PROPOSITO = new Set<string>([
  "appPropia.claves.campoSecreto", // «App secret», el rótulo de Meta tal cual
  "appPropia.webhook.url", // «Callback URL», idem
  "appPropia.webhook.token", // «Verify token», idem
]);

/*
 * Marcadores que sólo lleva el castellano. En inglés `{enMeta}` valdría lo mismo que `{categoria}` (la categoría
 * ya sale en inglés) y la frase afirmaría como hecho el rótulo del formulario de Meta, que no se verificó.
 */
const SOLO_EN_CASTELLANO: Record<string, string[]> = {
  "appPropia.cuenta.categoria": ["{enMeta}"],
};

describe.each(PARES)("textos de la app propia: $nombre", ({ es, en, prefijos }) => {
  const claves = Object.keys(es).filter((k) => prefijos.some((p) => k.startsWith(p)));

  it("hay claves, o el barrido no prueba nada", () => {
    expect(claves.length).toBeGreaterThan(0);
    for (const prefijo of prefijos) {
      expect(
        claves.some((k) => k.startsWith(prefijo)),
        `ninguna clave ${prefijo}*`
      ).toBe(true);
    }
  });

  it("existen en los dos idiomas y ninguna quedó vacía", () => {
    for (const clave of claves) {
      expect(es[clave]?.trim(), `falta ${clave} en es-AR`).toBeTruthy();
      expect(en[clave]?.trim(), `falta ${clave} en en-US`).toBeTruthy();
    }
  });

  it("en-US no trae claves que es-AR no tenga", () => {
    const sobrantes = Object.keys(en).filter((k) => prefijos.some((p) => k.startsWith(p)) && !(k in es));
    expect(sobrantes).toEqual([]);
  });

  it("el inglés no es el castellano copiado", () => {
    const copiadas = claves.filter((k) => !IGUALES_A_PROPOSITO.has(k) && es[k] === en[k]);
    expect(copiadas, `mismo texto en los dos idiomas: ${copiadas.join(", ")}`).toEqual([]);
  });

  it("los dos idiomas llevan los mismos marcadores", () => {
    for (const clave of claves) {
      const propios = SOLO_EN_CASTELLANO[clave] ?? [];
      expect(marcadores(en[clave]), `${clave}: los marcadores de en-US no coinciden con los de es-AR`).toEqual(
        marcadores(es[clave]).filter((m) => !propios.includes(m))
      );
    }
  });

  it("ninguna quedó con una marca de pendiente", () => {
    for (const clave of claves) {
      expect(es[clave], clave).not.toMatch(PENDIENTE);
      expect(en[clave], clave).not.toMatch(PENDIENTE);
    }
  });

  it("el castellano es rioplatense: ninguna forma de «tú» ni de «vosotros»", () => {
    const tuteo = /\b(tienes|puedes|haz clic|pulsa|selecciona|introduce|vuestro|vosotros)\b/i;
    for (const clave of claves) {
      expect(es[clave], `${clave} está en castellano de España o neutro`).not.toMatch(tuteo);
    }
  });
});

describe("textos de la app propia: lo que el código reemplaza", () => {
  it("el asunto del correo de ayuda lleva la empresa", () => {
    expect(marcadores(esARServidor["waba.ayuda.asuntoApp"])).toEqual(["{empresa}"]);
    expect(marcadores(enUSServidor["waba.ayuda.asuntoApp"])).toEqual(["{empresa}"]);
  });

  it("el recordatorio de P2 nombra los dos pedidos de esa ventana: sumar el número y pegar el token", () => {
    const es = esARServidor["alta.recordatorio.paso.P2"];
    const en = enUSServidor["alta.recordatorio.paso.P2"];
    expect(es).toMatch(/número/);
    expect(es).toMatch(/token/);
    expect(en).toMatch(/number/);
    expect(en).toMatch(/token/);
  });

  it("la categoría: el castellano nombra la opción del formulario en inglés y el inglés no afirma cómo la rotula Meta", () => {
    expect(marcadores(esARServidor["appPropia.cuenta.categoria"])).toEqual(["{categoria}", "{enMeta}"]);
    expect(marcadores(enUSServidor["appPropia.cuenta.categoria"])).toEqual(["{categoria}"]);
    expect(enUSServidor["appPropia.cuenta.categoria"]).not.toMatch(/lists it as/);
  });

  it("las páginas legales sólo usan los marcadores que la página reemplaza", () => {
    const permitidos = new Set(["{razonSocial}", "{cuit}", "{contacto}"]);
    const usados = new Set<string>();
    for (const [clave, texto] of Object.entries(esARServidor)) {
      if (!clave.startsWith("legal.")) continue;
      for (const m of marcadores(texto)) {
        usados.add(m);
        expect(permitidos.has(m), `${clave} usa ${m}, que la página no reemplaza`).toBe(true);
      }
    }
    // Si alguno deja de usarse, el dato legal salió de las páginas sin que nadie lo note.
    expect([...usados].sort()).toEqual([...permitidos].sort());
  });

  it("cada página nombra a la empresa, su CUIT y el contacto en algún texto", () => {
    for (const pagina of ["terminos", "privacidad", "borrado"]) {
      const textos = Object.entries(esARServidor)
        .filter(([clave]) => clave.startsWith(`legal.${pagina}.`))
        .map(([, texto]) => texto)
        .join(" ");
      expect(textos, pagina).toContain("{razonSocial}");
      expect(textos, pagina).toContain("{contacto}");
    }
  });
});
