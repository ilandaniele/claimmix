// @vitest-environment node
/**
 * El panel para conectar el WhatsApp con un código, en /configuracion: qué
 * formularios pinta, qué dice cada resultado y que sigue siendo de servidor: el
 * único JavaScript de cliente son los botones (`BotonDeEnvio`), porque `pnpm peso`
 * no tiene lugar para más.
 */

import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/(app)/configuracion/numero-actions", () => ({
  pedirCodigoDelNumero: vi.fn(),
  verificarCodigoDelNumero: vi.fn(),
}));

import { NumeroPanel } from "@/app/(app)/configuracion/NumeroPanel";
import { getT } from "@/lib/i18n";
import { enUS as enUSCliente } from "@/lib/i18n/en-US";
import { enUSServidor } from "@/lib/i18n/en-US.servidor";
import { esAR as esARCliente } from "@/lib/i18n/es-AR";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";
import { RESULTADOS_DEL_NUMERO, type ResultadoDelNumero } from "@/server/alta/numero-resultados";

const es = getT("es-AR");
const en = getT("en-US");

describe("NumeroPanel con los formularios", () => {
  const html = renderToStaticMarkup(<NumeroPanel t={es} resultado={null} formularios />);

  it("pide el código por SMS o por llamada, con el método en el botón", () => {
    expect(html).toMatch(/<button[^>]*value="SMS"[^>]*name="metodo"/);
    expect(html).toMatch(/<button[^>]*value="VOICE"[^>]*name="metodo"/);
    expect(html).toContain("Por SMS");
    expect(html).toContain("Por llamada");
  });

  it("el código: seis números, para que el teléfono lo sugiera solo", () => {
    // React escribe los atributos en camelCase; al navegador le da lo mismo.
    const campo = html.toLowerCase().match(/<input[^>]*>/)?.[0] ?? "";

    expect(campo).toContain('id="wa-codigo"');
    expect(campo).toContain('name="codigo"');
    expect(campo).toContain('pattern="[0-9]{6}"');
    expect(campo).toContain('maxlength="6"');
    expect(campo).toContain('autocomplete="one-time-code"');
    expect(campo).toContain('inputmode="numeric"');
    expect(campo).toContain("required");
    expect(campo).toContain('aria-label="código"');
    expect(html).toContain('for="wa-codigo"');
    expect(html).toContain(">Conectar<");
  });

  it("avisa lo de la app de WhatsApp y de qué nombre van a ver los clientes", () => {
    expect(html).toContain("Conectá tu WhatsApp");
    expect(html).toContain("el número no puede estar en uso en la app de WhatsApp ni en WhatsApp Business");
    expect(html).toContain("Los chats de esa cuenta se pierden");
    expect(html).toContain("Tus clientes van a ver el nombre de la plataforma");
  });

  it("no promete el nombre de la empresa: el nombre visible sale del número de la plataforma", () => {
    expect(html).not.toContain("nombre de tu empresa como nombre del número");
    expect(html).not.toContain("Meta lo revisa antes de mostrarlo");
  });

  it("son dos formularios, y sin resultado no hay aviso", () => {
    expect(html.match(/<form /g)).toHaveLength(2);
    expect(html).not.toContain('role="status"');
  });

  it("en inglés, en inglés", () => {
    const enHtml = renderToStaticMarkup(<NumeroPanel t={en} resultado={null} formularios />);

    expect(enHtml).toContain("Connect your WhatsApp");
    expect(enHtml).toContain("By SMS");
    expect(enHtml).toContain("By phone call");
    expect(enHtml).toContain("Enter the 6-digit code you received.");
    expect(enHtml).not.toContain("Pedí el código");
  });
});

describe("NumeroPanel con un resultado", () => {
  it("conectado: aviso verde con el texto, y sin formularios", () => {
    const html = renderToStaticMarkup(<NumeroPanel t={es} resultado="conectado" formularios={false} />);

    expect(html).toContain('role="status"');
    expect(html).toContain("Listo: tu WhatsApp quedó conectado.");
    expect(html).toContain("border-green-200");
    expect(html).not.toContain("<form");
    expect(html).not.toContain('name="codigo"');
  });

  it("revisión: aviso rojo con el texto, y los formularios siguen", () => {
    const html = renderToStaticMarkup(<NumeroPanel t={es} resultado="revision" formularios />);

    expect(html).toContain("No pudimos conectarlo desde acá. Lo revisamos nosotros y te avisamos.");
    expect(html).toContain("border-red-200");
    expect(html).toContain('name="codigo"');
  });

  it("el código enviado cuenta como bueno", () => {
    const html = renderToStaticMarkup(<NumeroPanel t={es} resultado="codigo_enviado" formularios />);

    expect(html).toContain("Te mandamos el código.");
    expect(html).toContain("border-green-200");
  });

  it("en inglés, el resultado en inglés", () => {
    const html = renderToStaticMarkup(<NumeroPanel t={en} resultado="conectado" formularios={false} />);

    expect(html).toContain("Done: your WhatsApp is connected.");
  });

  it.each(RESULTADOS_DEL_NUMERO)("%s tiene su texto en los dos idiomas, y distinto", (resultado: ResultadoDelNumero) => {
    const deEs = renderToStaticMarkup(<NumeroPanel t={es} resultado={resultado} formularios={false} />);
    const deEn = renderToStaticMarkup(<NumeroPanel t={en} resultado={resultado} formularios={false} />);

    expect(deEs).toContain('role="status"');
    expect(deEs).not.toContain("configuracion.numero");
    expect(deEn).not.toContain("configuracion.numero");
    expect(deEn).not.toBe(deEs);
  });
});

describe("los textos del número", () => {
  const claves = Object.keys(esARServidor).filter((k) => k.startsWith("configuracion.numero."));
  const marcas = (texto: string) => (texto.match(/\{\w+\}/g) ?? []).sort();

  it("están en los dos idiomas, ninguna vacía ni copiada, y las marcas coinciden", () => {
    expect(claves.length).toBeGreaterThan(10);
    expect(Object.keys(enUSServidor).filter((k) => k.startsWith("configuracion.numero.")).sort()).toEqual([...claves].sort());
    for (const clave of claves) {
      const deEs = (esARServidor as Record<string, string>)[clave]!;
      const deEn = (enUSServidor as Record<string, string>)[clave]!;
      expect(deEs, clave).toBeTruthy();
      expect(deEn, clave).toBeTruthy();
      expect(deEn, `${clave}: el inglés es el castellano copiado`).not.toBe(deEs);
      expect(marcas(deEn), clave).toEqual(marcas(deEs));
    }
  });

  it("todo resultado que la página puede pintar tiene su texto, y nada sobra", () => {
    const deResultados = claves.filter((k) => k.startsWith("configuracion.numero.r.")).map((k) => k.slice("configuracion.numero.r.".length));

    expect([...deResultados].sort()).toEqual([...RESULTADOS_DEL_NUMERO].sort());
  });

  it("no viajan al navegador: ninguna está en los diccionarios de cliente", () => {
    for (const diccionario of [esARCliente, enUSCliente]) {
      expect(Object.keys(diccionario).filter((k) => k.startsWith("configuracion.numero."))).toEqual([]);
      expect(Object.keys(diccionario)).not.toContain("configuracion.prueba.ayuda.pedidoAutomatico");
    }
  });
});

describe("NumeroPanel como código", () => {
  it("es de servidor: no baja JavaScript al navegador", () => {
    const fuente = readFileSync("src/app/(app)/configuracion/NumeroPanel.tsx", "utf8");

    expect(fuente).not.toMatch(/["']use client["']/);
    expect(fuente).not.toMatch(/\buse(State|Effect|T|Transition|ActionState)\b/);
  });

  it("los tres botones son BotonDeEnvio, el único componente de cliente que usa", () => {
    const fuente = readFileSync("src/app/(app)/configuracion/NumeroPanel.tsx", "utf8");

    expect(fuente.match(/<BotonDeEnvio\b/g)).toHaveLength(3);
    expect(fuente).not.toMatch(/<button\b/);
    expect(readFileSync("src/app/(app)/configuracion/BotonDeEnvio.tsx", "utf8")).toMatch(/^"use client"/);
  });

  it("no muestra ningún número ni id: sólo recibe la clave del resultado", () => {
    const fuente = readFileSync("src/app/(app)/configuracion/NumeroPanel.tsx", "utf8");

    expect(fuente).not.toMatch(/numero_e164|phone_number_id|waba_id|token/);
  });
});
