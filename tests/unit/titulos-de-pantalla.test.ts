/**
 * H45: cada pantalla del panel pone su propio título (WCAG 2.4.2).
 *
 * Con el título del layout raíz todas las pestañas decían «ClaimMix — FNOL» y el
 * lector de pantalla no avisaba del cambio de ruta. Ahora la pantalla aporta su
 * nombre, en el idioma de la cuenta, y el layout del panel le suma la marca.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ idioma: "es-AR" as "es-AR" | "en-US" }));

vi.mock("@/server/i18n/idioma-de-la-cuenta", () => ({ getAccountLocale: async () => h.idioma }));

import { tituloDePantalla } from "@/app/(app)/_components/titulo-de-pantalla";
import { generateMetadata as tituloDelCaso } from "@/app/(app)/casos/[id]/page";
import { metadata as marca } from "@/app/(app)/layout";
import { getT } from "@/lib/i18n";

beforeEach(() => {
  h.idioma = "es-AR";
});

describe("tituloDePantalla", () => {
  it("devuelve el nombre de la pantalla en el idioma de la cuenta", async () => {
    expect(await tituloDePantalla("nav.bandeja")()).toEqual({ title: getT("es-AR")("nav.bandeja") });

    h.idioma = "en-US";
    const enIngles = await tituloDePantalla("nav.bandeja")();
    expect(enIngles).toEqual({ title: getT("en-US")("nav.bandeja") });
    expect(enIngles.title).not.toBe(getT("es-AR")("nav.bandeja"));
  });
});

describe("el título del caso", () => {
  it("es su número, calculado del id sin leer la base", async () => {
    const id = "0b8f3c2e-1111-4222-8333-123456789abc";
    expect(await tituloDelCaso({ params: Promise.resolve({ id }) })).toEqual({ title: "SIN-5678-9ABC" });
  });
});

describe("la marca del panel", () => {
  it("el layout suma «ClaimMix» a cada título y deja uno por defecto", () => {
    expect(marca.title).toEqual({ template: "%s — ClaimMix", default: "ClaimMix" });
  });
});

describe("las pantallas del panel", () => {
  const APP = "src/app/(app)";
  const paginas = (readdirSync(APP, { recursive: true, encoding: "utf8" }) as string[])
    .filter((f) => /(^|[\\/])page\.tsx$/.test(f))
    .map((f) => join(APP, f));

  it("hay pantallas que revisar", () => {
    expect(paginas.length).toBeGreaterThan(10);
  });

  it.each(paginas)("%s exporta su generateMetadata (o sólo redirige)", (pagina) => {
    const fuente = readFileSync(pagina, "utf8");
    const soloRedirige = /\bredirect\("[^"]+"\);\s*\}\s*$/.test(fuente.trimEnd());
    expect(soloRedirige || /export (const|async function) generateMetadata\b/.test(fuente)).toBe(true);
  });
});
