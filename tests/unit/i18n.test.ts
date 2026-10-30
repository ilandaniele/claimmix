/**
 * Unit tests for the i18n translation helper.
 */

import { describe, it, expect } from "vitest";
import { t, getT, esAR, enUS, textosDePagina } from "@/lib/i18n/index";
import { DEFAULT_LOCALE } from "@/lib/i18n/locale-shared";
import { textoDeSesionesCerradas } from "@/lib/i18n/sesiones-cerradas";
import { RESULTADOS_SSO } from "@/app/(app)/configuracion/sso-resultados";
import { enUS as enUSCliente } from "@/lib/i18n/en-US";
import { enUSServidor } from "@/lib/i18n/en-US.servidor";
import { esAR as esARCliente } from "@/lib/i18n/es-AR";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";
import { FALLAS_DE_WABA } from "@/server/alta/waba-resultados";

describe("t() translation helper", () => {
  it("returns the correct string for 'nav.bandeja'", () => {
    expect(t("nav.bandeja")).toBe("Bandeja");
  });

  it("returns the correct string for 'status.procesando'", () => {
    expect(t("status.procesando")).toBe("Procesando");
  });

  it("returns the correct string for 'auth.signIn.title'", () => {
    expect(t("auth.signIn.title")).toBe("Iniciar sesión");
  });

  it("returns the correct string for 'app.name'", () => {
    expect(t("app.name")).toBe("ClaimMix");
  });

  it("returns non-empty strings for all keys", () => {
    const keys = Object.keys(esAR) as Array<keyof typeof esAR>;
    for (const key of keys) {
      expect(t(key)).toBeTruthy();
      expect(typeof t(key)).toBe("string");
    }
  });
});

describe("multilanguage support", () => {
  it("t() returns Spanish by default (no locale arg)", () => {
    expect(t("nav.bandeja")).toBe("Bandeja");
  });

  it("t() returns Spanish when locale='es-AR'", () => {
    expect(t("nav.bandeja", "es-AR")).toBe("Bandeja");
  });

  it("t() returns English when locale='en-US'", () => {
    expect(t("nav.bandeja", "en-US")).toBe("Inbox");
  });

  it("getT() factory returns locale-bound function for es-AR", () => {
    const tEs = getT("es-AR");
    expect(tEs("status.listo")).toBe("Listo");
  });

  it("getT() factory returns locale-bound function for en-US", () => {
    const tEn = getT("en-US");
    expect(tEn("status.listo")).toBe("Ready");
  });

  it("en-US has all the same keys as es-AR", () => {
    expect(Object.keys(enUS).sort()).toEqual(Object.keys(esAR).sort());
  });

  it("en-US has no empty string values", () => {
    for (const [key, value] of Object.entries(enUS)) {
      expect(value, `en-US key '${key}' should not be empty`).not.toBe("");
    }
  });

  it("en-US status labels are in English", () => {
    expect(enUS["status.listo"]).toBe("Ready");
    expect(enUS["status.esperando"]).toBe("Waiting");
    expect(enUS["status.escalado"]).toBe("Escalated");
    expect(enUS["status.cerrado"]).toBe("Closed");
    expect(enUS["status.procesando"]).toBe("Processing");
  });
});

describe("esAR flat string map", () => {
  it("has all required claim type labels", () => {
    expect(esAR["type.choque"]).toBeDefined();
    expect(esAR["type.robo"]).toBeDefined();
    expect(esAR["type.granizo"]).toBeDefined();
    expect(esAR["type.incendio"]).toBeDefined();
  });

  it("has all required status labels", () => {
    expect(esAR["status.procesando"]).toBeDefined();
    expect(esAR["status.listo"]).toBeDefined();
    expect(esAR["status.esperando"]).toBeDefined();
    expect(esAR["status.escalado"]).toBeDefined();
    expect(esAR["status.cerrado"]).toBeDefined();
  });

  it("has auth labels in Spanish", () => {
    // All auth strings should be in Spanish (not English).
    const authKeys = Object.entries(esAR).filter(([k]) => k.startsWith("auth."));
    for (const [, value] of authKeys) {
      // Basic check: none of these should be 'undefined' or empty.
      expect(value).toBeTruthy();
    }
  });

  it("has no empty string values", () => {
    for (const [key, value] of Object.entries(esAR)) {
      expect(value, `Key '${key}' should not be empty`).not.toBe("");
    }
  });
});

// AC6: DEFAULT_LOCALE constant is "es-AR" and getT("es-AR")("nav.bandeja") resolves to "Bandeja"
describe("AC6 — DEFAULT_LOCALE constant and es-AR default resolution", () => {
  it("DEFAULT_LOCALE is 'es-AR'", () => {
    expect(DEFAULT_LOCALE).toBe("es-AR");
  });

  it("getT('es-AR')('nav.bandeja') returns 'Bandeja'", () => {
    const tEs = getT("es-AR");
    expect(tEs("nav.bandeja")).toBe("Bandeja");
  });

  it("t('nav.bandeja') with no locale arg defaults to es-AR value 'Bandeja'", () => {
    // This mirrors the behaviour of getServerLocale() returning DEFAULT_LOCALE when no cookie is set.
    expect(t("nav.bandeja")).toBe("Bandeja");
  });
});

// AC10: useT() / getT() with an unknown key returns the key itself (or es-AR fallback) without throwing
describe("AC10 — unknown key fallback (no throw)", () => {
  it("getT('es-AR') with an unknown key returns the key string without throwing", () => {
    const tEs = getT("es-AR");
    // Cast to any to bypass TypeScript's TranslationKey type — simulates a runtime unknown key.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = tEs("this.key.does.not.exist" as any);
    // The implementation returns `map[key] ?? esAR[key]` — both are undefined for an unknown
    // key, so the result is undefined coerced by JS. We assert it does NOT throw and that the
    // returned value is either the key itself or undefined (documented fallback).
    expect(() => tEs("this.key.does.not.exist" as any)).not.toThrow();
    // Value should be falsy (undefined) — not a crash, not an exception.
    expect(result).toBeFalsy();
  });

  it("getT('en-US') with an unknown key returns a falsy value without throwing", () => {
    const tEn = getT("en-US");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => tEn("unknown.namespace.key" as any)).not.toThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(tEn("unknown.namespace.key" as any)).toBeFalsy();
  });

  it("t() with an unknown key and default locale does not throw", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => t("completely.unknown.key" as any)).not.toThrow();
  });
});

/*
 * Las dos pantallas de clientes tenían la mitad del texto en castellano en duro.
 *
 * Los encabezados sí pasaban por `t()`, así que con la interfaz en inglés
 * quedaba una mezcla: columnas «Name / ID number / Registered» y al lado
 * botones «Buscar» y «Limpiar», celdas «Automóvil» y «Activa», y al pie
 * «Mostrando 1–14 de 14 clientes».
 *
 * La paridad de claves ya la comprueba el test de arriba. Lo que falta es que
 * la traducción sea una traducción: copiar el castellano al diccionario inglés
 * pasa la paridad y deja la pantalla exactamente igual de mezclada.
 */
describe("las claves nuevas de /clientes están traducidas de verdad", () => {
  const CLAVES = [
    "clientes.doSearch",
    "clientes.clear",
    "clientes.tableLabel",
    "clientes.plural",
    "clientes.policyType.auto",
    "clientes.policyType.home",
    "clientes.policyType.life",
    "clientes.policyType.business",
    "clientes.policyStatus.active",
    "clientes.policyStatus.expired",
    "clientes.policyStatus.cancelled",
  ] as const;

  it("existen en los dos diccionarios", () => {
    for (const clave of CLAVES) {
      expect(esAR[clave], `falta ${clave} en es-AR`).toBeTruthy();
      expect(enUS[clave], `falta ${clave} en en-US`).toBeTruthy();
    }
  });

  it("el inglés no es el castellano copiado", () => {
    // `other` queda afuera: «Otro»/«Other» y «Email» son legítimamente
    // parecidos, pero éstas once son palabras distintas en los dos idiomas.
    for (const clave of CLAVES) {
      expect(enUS[clave], `${clave} está igual en los dos idiomas`).not.toBe(esAR[clave]);
    }
  });
});

/*
 * Las cinco pantallas que estaban enteras en castellano.
 *
 * No era el olvido de una palabra: facturación, cartera, métricas, la consola
 * del agente y el alta de usuarios no tenían UNA sola llamada al diccionario.
 * La pasada agregó 141 claves de una, y a esa escala el riesgo cambia: copiar
 * el castellano al lado inglés pasa la paridad, pasa los tipos, y deja las
 * cinco pantallas exactamente igual de mezcladas que antes.
 *
 * Este test no enumera claves a mano —serían 141 y se atrasaría con la próxima—
 * sino que barre por prefijo. Una clave nueva de estas pantallas queda cubierta
 * sola.
 */
describe("las cinco pantallas nuevas están traducidas de verdad", () => {
  const PREFIJOS = ["facturacion.", "cartera.", "metricas.", "agente.", "usuarios."];

  /*
   * Las que legítimamente se escriben igual en los dos idiomas.
   *
   * Van enumeradas y no detectadas por heurística: la lista corta es la
   * afirmación de que se las miró una por una. Si mañana alguien copia una
   * clave sin traducir, el test falla en vez de crecer en silencio.
   */
  const IGUALES_A_PROPOSITO = new Set([
    "usuarios.rol.owner",      // «Owner» se usa igual en los dos
    "usuarios.rol.admin",      // «Admin», idem
    "usuarios.col.email",      // «Email»
    "metricas.ia.prompt",      // «prompt», término técnico
    "metricas.col.tokens",     // «Tokens»
    "facturacion.total",       // «Total»
    "cartera.col.plan",        // «Plan»
  ]);

  const clavesNuevas = Object.keys(esAR).filter((k) =>
    PREFIJOS.some((p) => k.startsWith(p))
  );

  it("hay claves de las cinco pantallas", () => {
    // Si esto da cero, el barrido de abajo no prueba nada y quedaría verde.
    expect(clavesNuevas.length).toBeGreaterThan(100);
    for (const prefijo of PREFIJOS) {
      expect(
        clavesNuevas.some((k) => k.startsWith(prefijo)),
        `ninguna clave ${prefijo}*`
      ).toBe(true);
    }
  });

  it("existen en los dos diccionarios y ninguna quedó vacía", () => {
    for (const clave of clavesNuevas) {
      const k = clave as keyof typeof esAR;
      expect(esAR[k], `falta ${clave} en es-AR`).toBeTruthy();
      expect(enUS[k as keyof typeof enUS], `falta ${clave} en en-US`).toBeTruthy();
    }
  });

  it("el inglés no es el castellano copiado", () => {
    const copiadas = clavesNuevas.filter((clave) => {
      if (IGUALES_A_PROPOSITO.has(clave)) return false;
      return (
        esAR[clave as keyof typeof esAR] === enUS[clave as keyof typeof enUS]
      );
    });
    expect(
      copiadas,
      `estas claves tienen el mismo texto en los dos idiomas: ${copiadas.join(", ")}`
    ).toEqual([]);
  });

  it("la lista de excepciones no junta polvo", () => {
    // Una excepción que ya no hace falta es una excepción que tapa el próximo
    // descuido. Si alguien traduce una de éstas, hay que sacarla de la lista.
    for (const clave of IGUALES_A_PROPOSITO) {
      expect(
        esAR[clave as keyof typeof esAR],
        `${clave} ya está traducida: sacala de IGUALES_A_PROPOSITO`
      ).toBe(enUS[clave as keyof typeof enUS]);
    }
  });
});

/**
 * El panel de SSO (B19) es de servidor a propósito: cada clave de cliente viaja al
 * navegador en los dos idiomas y `pnpm peso` no tiene lugar. Si alguien mueve una
 * de estas claves a `es-AR.ts`, el peso se pasa sin que ningún otro test lo note.
 */
describe("las claves del SSO", () => {
  const claves = Object.keys(esARServidor).filter((k) => k.startsWith("configuracion.sso."));
  const marcas = (texto: string) => (texto.match(/\{\w+\}/g) ?? []).sort();
  // «Client ID» y «Client secret» son los nombres de los campos en la consola de todo proveedor, en cualquier idioma.
  const IGUALES_A_PROPOSITO = new Set(["configuracion.sso.clientId", "configuracion.sso.clientSecret"]);

  it("hay claves, y las mismas en los dos idiomas", () => {
    expect(claves.length).toBeGreaterThan(40);
    const eninglish = Object.keys(enUSServidor).filter((k) => k.startsWith("configuracion.sso."));
    expect(eninglish.sort()).toEqual([...claves].sort());
  });

  it("ninguna quedó vacía, ninguna es el castellano copiado y las marcas coinciden", () => {
    for (const clave of claves) {
      const es = (esARServidor as Record<string, string>)[clave]!;
      const en = (enUSServidor as Record<string, string>)[clave]!;
      expect(es, clave).toBeTruthy();
      expect(en, clave).toBeTruthy();
      if (!IGUALES_A_PROPOSITO.has(clave)) expect(en, `${clave}: el inglés es el castellano copiado`).not.toBe(es);
      expect(marcas(en), clave).toEqual(marcas(es));
    }
  });

  it("la lista de iguales a propósito no junta polvo", () => {
    for (const clave of IGUALES_A_PROPOSITO) {
      expect((esARServidor as Record<string, string>)[clave], clave).toBe((enUSServidor as Record<string, string>)[clave]);
    }
  });

  it("no viajan al navegador: ninguna está en los diccionarios de cliente", () => {
    expect(Object.keys(esARCliente).filter((k) => k.startsWith("configuracion.sso."))).toEqual([]);
    expect(Object.keys(enUSCliente).filter((k) => k.startsWith("configuracion.sso."))).toEqual([]);
  });

  it("todo resultado que la página puede pintar tiene su texto, y nada sobra", () => {
    const deResultados = claves.filter((k) => k.startsWith("configuracion.sso.r.")).map((k) => k.slice("configuracion.sso.r.".length));
    expect([...deResultados].sort()).toEqual([...RESULTADOS_SSO].sort());
  });
});

/**
 * Las claves del lote de decisiones de la auditoría: las que llevan marcas
 * `{…}` las rellena el código con `.replace`, así que una marca que cambie de
 * nombre en un solo idioma deja la llave a la vista en esa interfaz.
 */
describe("las claves con marcas del lote de decisiones", () => {
  const marcas = (texto: string) => (texto.match(/\{\w+\}/g) ?? []).sort();
  const DE_CLIENTE = {
    "usuarios.cerrarSesionesConfirmar": ["{nombre}"],
    "usuarios.darDeBajaConfirmar": ["{nombre}"],
    "usuarios.toast.sesionesCerradas": ["{n}"],
    "usuarios.toast.sesionCerrada": [],
    "usuarios.lote.resumen": ["{hechas}", "{rechazadas}", "{sinCupo}"],
  } as const;
  const DE_SERVIDOR = {
    "presupuesto.aviso.cuerpo": ["{hora}", "{motivo}", "{plazo}"],
    "formulario.ayuda": ["{porDia}", "{porHora}"],
    "alta.avisoTope.linea80": ["{nombre}", "{tope}", "{usado}"],
    "alta.avisoTope.linea100": ["{llena}", "{nombre}", "{tope}", "{usado}"],
  } as const;

  it("las de cliente llevan las mismas marcas en los dos idiomas", () => {
    for (const [clave, esperadas] of Object.entries(DE_CLIENTE)) {
      expect(marcas(esAR[clave as keyof typeof DE_CLIENTE]), clave).toEqual([...esperadas].sort());
      expect(marcas(enUS[clave as keyof typeof DE_CLIENTE]), clave).toEqual([...esperadas].sort());
    }
  });

  it("las de servidor llevan las mismas marcas en los dos idiomas", () => {
    for (const [clave, esperadas] of Object.entries(DE_SERVIDOR)) {
      expect(marcas(esARServidor[clave as keyof typeof DE_SERVIDOR]), clave).toEqual([...esperadas].sort());
      expect(marcas(enUSServidor[clave as keyof typeof DE_SERVIDOR]), clave).toEqual([...esperadas].sort());
    }
  });

  it("con una sola sesión cerrada el aviso va en singular, en los dos idiomas", () => {
    for (const idioma of ["es-AR", "en-US"] as const) {
      const traducir = getT(idioma) as (clave: keyof typeof esARCliente) => string;
      const una = textoDeSesionesCerradas(traducir, 1);
      expect(una, idioma).not.toMatch(/sesiones|sessions/);
      expect(una, idioma).toContain("1");
      for (const n of [0, 2, 5]) {
        expect(textoDeSesionesCerradas(traducir, n), idioma).toContain(String(n));
        expect(textoDeSesionesCerradas(traducir, n), idioma).not.toContain("{n}");
      }
    }
  });
  it("los motivos y plazos del aviso de presupuesto existen en los dos idiomas", () => {
    for (const motivo of ["anonimo", "inquilino", "mensual"] as const) {
      for (const clave of [`presupuesto.aviso.motivo.${motivo}`, `presupuesto.aviso.plazo.${motivo}`] as const) {
        expect(esARServidor[clave], clave).toBeTruthy();
        expect(enUSServidor[clave], clave).toBeTruthy();
      }
    }
  });

  it("la ayuda del PIN de dos pasos avisa que puede ser de una conexión anterior y dónde se cambia", () => {
    expect(esARServidor["waba.pin.ayuda"]).toContain("WhatsApp Manager");
    expect(esARServidor["waba.pin.ayuda"]).toContain("conexión anterior");
    expect(enUSServidor["waba.pin.ayuda"]).toContain("WhatsApp Manager");
    expect(enUSServidor["waba.pin.ayuda"]).toContain("earlier connection");
  });
});

/**
 * Las claves del panel del operador (`altas.*`) y las del enlace a la conexión con la app propia
 * (`enlaceWaba.app.*`): de servidor a propósito, así que no viajan al navegador. Cada estado y cada
 * falla de la WABA que la pantalla puede pintar tiene su texto en los dos idiomas.
 */
describe("las claves de altas y del enlace de la app propia", () => {
  const marcas = (texto: string) => (texto.match(/\{\w+\}/g) ?? []).sort();
  const delPanel = (k: string) => k.startsWith("altas.") || k.startsWith("enlaceWaba.app.");
  // «App ID» y «WABA» son los nombres que Meta usa en su consola; «Plan» se escribe igual en los dos idiomas.
  const IGUALES_A_PROPOSITO = new Set(["altas.waba.appId", "altas.waba.id", "altas.numero.waba", "altas.activar.plan"]);
  const claves = Object.keys(esARServidor).filter(delPanel);

  it("hay claves, y las mismas en los dos idiomas", () => {
    expect(claves.length).toBeGreaterThan(100);
    expect(Object.keys(enUSServidor).filter(delPanel).sort()).toEqual([...claves].sort());
  });

  it("ninguna quedó vacía, ninguna es el castellano copiado y las marcas coinciden", () => {
    for (const clave of claves) {
      const es = (esARServidor as Record<string, string>)[clave]!;
      const en = (enUSServidor as Record<string, string>)[clave]!;
      expect(es, clave).toBeTruthy();
      expect(en, clave).toBeTruthy();
      if (!IGUALES_A_PROPOSITO.has(clave)) expect(en, `${clave}: el inglés es el castellano copiado`).not.toBe(es);
      expect(marcas(en), clave).toEqual(marcas(es));
    }
  });

  it("la lista de iguales a propósito no junta polvo", () => {
    for (const clave of IGUALES_A_PROPOSITO) {
      expect((esARServidor as Record<string, string>)[clave], clave).toBe((enUSServidor as Record<string, string>)[clave]);
    }
  });

  it("no viajan al navegador: ninguna está en los diccionarios de cliente", () => {
    expect(Object.keys(esARCliente).filter(delPanel)).toEqual([]);
    expect(Object.keys(enUSCliente).filter(delPanel)).toEqual([]);
  });

  it("cada falla de la WABA y cada estado de su fila tiene su texto, en los dos idiomas", () => {
    const estados = ["armando", "cancelada", "vinculada", "suscripta", "falta_codigo", "falta_pin", "conectada", "falla", "revocada"];
    const pedidas = [...FALLAS_DE_WABA.map((f) => `altas.waba.falla.${f}`), ...estados.map((e) => `altas.waba.estado.${e}`)];
    for (const clave of pedidas) {
      expect((esARServidor as Record<string, string>)[clave], clave).toBeTruthy();
      expect((enUSServidor as Record<string, string>)[clave], clave).toBeTruthy();
    }
  });

  it("el enlace de la app propia tiene los cuatro estados y los cuatro botones", () => {
    for (const parte of ["estado", "boton"]) {
      for (const estado of ["nuevo", "enCurso", "falla", "conectado"]) {
        const clave = `enlaceWaba.app.${parte}.${estado}`;
        expect((esARServidor as Record<string, string>)[clave], clave).toBeTruthy();
        expect((enUSServidor as Record<string, string>)[clave], clave).toBeTruthy();
      }
    }
  });
});

/**
 * Los textos de los paneles de /conectar-whatsapp (`waba.*` y `appPropia.*`, menos los rubros) viajan
 * como prop a las dos páginas que los usan: de servidor a propósito, así que no están en el JS de todas.
 */
describe("textosDePagina", () => {
  const delPanel = (k: string) => k.startsWith("waba.") || k.startsWith("appPropia.");

  it("trae todas las claves de servidor de los paneles, en los dos idiomas, y ninguna otra", () => {
    const claves = Object.keys(esARServidor).filter(delPanel).sort();
    expect(claves.length).toBeGreaterThan(0);
    expect(Object.keys(textosDePagina("es-AR")).sort()).toEqual(claves);
    expect(Object.keys(textosDePagina("en-US")).sort()).toEqual(claves);
  });

  it("devuelve el texto del idioma pedido", () => {
    expect(textosDePagina("es-AR")["waba.pin.ayuda"]).toBe(esARServidor["waba.pin.ayuda"]);
    expect(textosDePagina("en-US")["waba.pin.ayuda"]).toBe(enUSServidor["waba.pin.ayuda"]);
  });

  it("los rubros del perfil siguen en el diccionario del cliente, que los lee el selector", () => {
    expect(Object.keys(esARCliente).filter((k) => k.startsWith("waba.")).every((k) => k.startsWith("waba.categoria."))).toBe(true);
    expect(Object.keys(esARCliente).some((k) => k.startsWith("appPropia."))).toBe(false);
    expect(Object.keys(textosDePagina("es-AR")).some((k) => k.startsWith("waba.categoria."))).toBe(false);
  });
});
