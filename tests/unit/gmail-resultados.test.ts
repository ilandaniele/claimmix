/**
 * La lista cerrada de lo que /configuracion le cuenta al admin al volver de conectar
 * Gmail (`?gmail=`), y los textos de la alta corta que viven en el servidor.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  esExitoDeGmail,
  esResultadoGmail,
  RESULTADOS_GMAIL,
} from "@/app/(app)/configuracion/gmail-resultados";
import { enUS as enUSCliente } from "@/lib/i18n/en-US";
import { enUSServidor } from "@/lib/i18n/en-US.servidor";
import { esAR as esARCliente } from "@/lib/i18n/es-AR";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";

const es = esARServidor as Record<string, string>;
const en = enUSServidor as Record<string, string>;
const marcas = (texto: string) => (texto.match(/\{\w+\}/g) ?? []).sort();

describe("esResultadoGmail", () => {
  it.each(RESULTADOS_GMAIL)("%s es un resultado", (resultado) => {
    expect(esResultadoGmail(resultado)).toBe(true);
  });

  it.each([undefined, null, "", "raro", "CONNECTED", "constructor", 1, ["connected"], { connected: true }])("%j no lo es", (valor) => {
    expect(esResultadoGmail(valor)).toBe(false);
  });
});

describe("esExitoDeGmail", () => {
  it("sólo conectar la casilla salió bien", () => {
    expect(RESULTADOS_GMAIL.filter(esExitoDeGmail)).toEqual(["connected"]);
  });
});

describe("los resultados que deja el callback", () => {
  const callback = readFileSync("src/app/api/admin/gmail-accounts/callback/route.ts", "utf8");
  const connect = readFileSync("src/app/api/admin/gmail-accounts/connect/route.ts", "utf8");
  const deLasRutas = new Set(
    [...(callback + connect).matchAll(/\/configuracion\?gmail=([a-z_]+)/g)].map((coincidencia) => coincidencia[1]),
  );

  it("todo lo que redirige a /configuracion?gmail= está en la lista, y nada sobra", () => {
    expect([...deLasRutas].sort()).toEqual([...RESULTADOS_GMAIL].sort());
  });
});

describe("los textos de Gmail en /configuracion", () => {
  const claves = Object.keys(es).filter((k) => k.startsWith("configuracion.gmail."));

  it("todo resultado tiene su texto en los dos idiomas, distinto, y nada sobra", () => {
    const deResultados = claves.filter((k) => k.startsWith("configuracion.gmail.r.")).map((k) => k.slice("configuracion.gmail.r.".length));

    expect([...deResultados].sort()).toEqual([...RESULTADOS_GMAIL].sort());
    for (const clave of claves) {
      expect(es[clave], clave).toBeTruthy();
      expect(en[clave], clave).toBeTruthy();
      expect(en[clave], `${clave}: el inglés es el castellano copiado`).not.toBe(es[clave]);
      expect(marcas(en[clave]!), clave).toEqual(marcas(es[clave]!));
    }
    expect(Object.keys(en).filter((k) => k.startsWith("configuracion.gmail.")).sort()).toEqual([...claves].sort());
  });

  it("ninguno viaja al navegador", () => {
    for (const diccionario of [esARCliente, enUSCliente]) {
      expect(Object.keys(diccionario).filter((k) => k.startsWith("configuracion.gmail.r."))).toEqual([]);
      expect(Object.keys(diccionario)).not.toContain("configuracion.gmail.irABandeja");
    }
  });
});

describe("los textos de los primeros pasos", () => {
  it("los pasos no llevan el número escrito: sobra el 2 cuando falta uno solo", () => {
    for (const clave of ["configuracion.primeros.gmail", "configuracion.primeros.whatsapp"]) {
      expect(es[clave], clave).not.toMatch(/^\d+\./);
      expect(en[clave], clave).not.toMatch(/^\d+\./);
    }
  });

  it("siguen estando en los dos idiomas", () => {
    for (const clave of Object.keys(es).filter((k) => k.startsWith("configuracion.primeros."))) {
      expect(en[clave], clave).toBeTruthy();
      expect(en[clave], clave).not.toBe(es[clave]);
    }
  });
});

describe("los textos de la alta corta", () => {
  it.each(["alta.error.celular", "preparando.whatsapp"])("%s está en los dos idiomas, distinto, y en el servidor", (clave) => {
    expect(es[clave], clave).toBeTruthy();
    expect(en[clave], clave).toBeTruthy();
    expect(en[clave]).not.toBe(es[clave]);
    expect(marcas(en[clave]!)).toEqual(marcas(es[clave]!));
    expect(Object.keys(esARCliente)).not.toContain(clave);
    expect(Object.keys(enUSCliente)).not.toContain(clave);
  });

  it("el aviso del celular muestra un ejemplo con el 9 y no repite lo que escribió la persona", () => {
    expect(es["alta.error.celular"]).toContain("+54 9");
    expect(en["alta.error.celular"]).toContain("+54 9");
    expect(es["alta.error.celular"]).not.toContain("{");
  });
});
