/**
 * «Demo» abre adentro de la app, con la barra a la vista.
 *
 * `/demo` es la pública, sin sesión y sin barra: apretarla desde el menú hacía
 * perder el menú. `/demostracion` está dentro de `(app)`, reutiliza la misma
 * `DemoPublic` (y su endpoint con tope por IP) y no agrega ninguna ruta de API.
 */

import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ idioma: "es-AR" as "es-AR" | "en-US" }));

vi.mock("@/server/i18n/idioma-de-la-cuenta", () => ({ getAccountLocale: async () => h.idioma }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/demostracion",
  useSearchParams: () => new URLSearchParams(),
}));

import DemostracionPage, { generateMetadata } from "../../src/app/(app)/demostracion/page";
import { Sidebar } from "../../src/app/(app)/_components/Sidebar";
import { LocaleProvider } from "../../src/lib/i18n/LocaleContext";

beforeEach(() => {
  h.idioma = "es-AR";
});

describe("la pantalla «Demo» de la app", () => {
  it("lleva el título «Demo» en el idioma de la cuenta", async () => {
    expect(await generateMetadata()).toEqual({ title: "Demo" });
  });

  it("muestra el h1 y la misma demo pública, con sus regiones vivas", async () => {
    render(
      <LocaleProvider locale="es-AR">{await DemostracionPage()}</LocaleProvider>
    );

    expect(screen.getByRole("heading", { level: 1, name: "Demo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analizar con IA" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("reutiliza el componente de /demo y no trae un endpoint propio", () => {
    const codigo = readFileSync("src/app/(app)/demostracion/page.tsx", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

    expect(codigo).toContain('from "@/app/demo/DemoPublic"');
    expect(codigo).not.toMatch(/fetch\(|\/api\//);
  });
});

describe("la pantalla «Demo» en una cuenta en inglés", () => {
  it("declara es-AR toda la demo, incluidos los textos del diccionario, y deja el título en inglés", async () => {
    h.idioma = "en-US";
    render(<LocaleProvider locale="en-US">{await DemostracionPage()}</LocaleProvider>);

    const titulo = screen.getByRole("heading", { level: 1, name: "Demo" });
    expect(titulo.closest("[lang]")).toBeNull();

    // Lo escrito a mano en castellano (rótulos, ejemplos) queda bajo lang="es-AR", no bajo el de la cuenta.
    expect(screen.getByText("Ejemplos:").closest("[lang]")).toHaveAttribute("lang", "es-AR");
    expect(screen.getByRole("button", { name: "Analizar con IA" }).closest("[lang]")).toHaveAttribute("lang", "es-AR");

    // Lo que sale del diccionario también es castellano: ni inglés suelto bajo es-AR ni castellano bajo en-US.
    const paso = screen.getByText("1. El siniestro llega solo");
    expect(paso.closest("[lang]")).toHaveAttribute("lang", "es-AR");
    expect(screen.queryByText("1. The claim arrives on its own")).not.toBeInTheDocument();
  });
});

describe("el ítem «Demo» de la barra", () => {
  it("apunta a la pantalla de adentro de la app y no a la pública", () => {
    render(
      <LocaleProvider locale="es-AR">
        <Sidebar role="owner" esPro />
      </LocaleProvider>
    );

    expect(screen.getByRole("link", { name: "Demo" })).toHaveAttribute("href", "/demostracion");
  });

  it("queda resaltado cuando se está en esa pantalla", () => {
    render(
      <LocaleProvider locale="es-AR">
        <Sidebar role="owner" esPro />
      </LocaleProvider>
    );

    expect(screen.getByRole("link", { name: "Demo" })).toHaveAttribute("aria-current", "page");
  });
});
