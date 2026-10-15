/**
 * Las pantallas de error y de «no existe»: `not-found` y el `error` del shell.
 * `global-error` tiene su propio archivo (global-error.test.tsx).
 *
 * Antes no había ninguna y un error de render o un 404 mostraban la pantalla
 * genérica de Next, sin idioma ni marca. Lo que se prueba:
 *   - cada una dice qué pasó, en el idioma que le toca, y ofrece una salida;
 *   - que reintentar llama al `retry` que da Next;
 *   - que el `digest` se muestra sólo si existe, para buscarlo en los registros.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ locale: vi.fn() }));

vi.mock("next/headers", () => ({ cookies: async () => ({}) }));
vi.mock("@/lib/i18n/locale", () => ({ getServerLocale: h.locale }));

import ErrorDelShell from "@/app/(app)/error";
import NotFound from "@/app/not-found";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";

beforeEach(() => {
  vi.clearAllMocks();
  h.locale.mockResolvedValue("es-AR");
});

describe("error de una pantalla del shell", () => {
  function pintar(locale: "es-AR" | "en-US", error: Error & { digest?: string }, retry = vi.fn()) {
    render(
      <LocaleProvider locale={locale}>
        <ErrorDelShell error={error} retry={retry} />
      </LocaleProvider>
    );
    return retry;
  }

  it("dice qué pasó en castellano y reintenta con el retry de Next", () => {
    const retry = pintar("es-AR", new Error("boom"));

    expect(screen.getByRole("heading", { name: "Algo salió mal" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Ocurrió un error inesperado. Intentá de nuevo.");

    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("habla en el idioma de la cuenta", () => {
    pintar("en-US", new Error("boom"));

    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("muestra el digest para soporte, y no el mensaje del error", () => {
    const error = Object.assign(new Error("detalle interno que no se muestra"), { digest: "1234567890" });

    pintar("es-AR", error);

    expect(screen.getByText("Código para soporte: 1234567890")).toBeInTheDocument();
    expect(screen.queryByText(/detalle interno/)).not.toBeInTheDocument();
  });

  it("sin digest no muestra ningún código", () => {
    pintar("es-AR", new Error("boom"));

    expect(screen.queryByText(/Código para soporte/)).not.toBeInTheDocument();
  });
});

describe("not-found", () => {
  it("dice que no existe la página y manda al inicio, en castellano", async () => {
    const { container } = render(await NotFound());

    expect(screen.getByRole("heading", { name: "No encontramos esa página" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ir al inicio" })).toHaveAttribute("href", "/");
    expect(container.querySelector("main")).toHaveAttribute("lang", "es-AR");
  });

  it("sigue la cookie del dispositivo: en en-US sale en inglés", async () => {
    h.locale.mockResolvedValue("en-US");

    const { container } = render(await NotFound());

    expect(screen.getByRole("heading", { name: "We couldn't find that page" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the home page" })).toHaveAttribute("href", "/");
    expect(container.querySelector("main")).toHaveAttribute("lang", "en-US");
  });
});
