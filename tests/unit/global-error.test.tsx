/**
 * `global-error`: la pantalla de último recurso, cuando falla hasta el layout raíz.
 *
 * Lo que se prueba:
 *   - que trae su propio documento y dice las dos lenguas sola, cada una con su
 *     `lang`, porque no tiene LocaleContext;
 *   - que reintentar llama al `retry` que da Next;
 *   - que la referencia (`digest`) se muestra sólo si existe.
 *
 * Va en su propio archivo a propósito: se pinta con `container: document`, y si
 * antes se pintó otra cosa en un `<div>`, React ya marcó el documento como
 * escuchado y no le agrega los eventos al root nuevo (el click no llega).
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import GlobalError from "@/app/global-error";

// Trae su propio <html>: se pinta en el documento, no dentro de un <div>.
function pintar(error: Error & { digest?: string }, retry = vi.fn()) {
  render(<GlobalError error={error} retry={retry} />, { container: document });
  return retry;
}

describe("global-error", () => {
  it("dice qué pasó en las dos lenguas, cada una con su lang", () => {
    pintar(new Error("boom"));

    expect(document.documentElement).toHaveAttribute("lang", "es-AR");
    expect(screen.getByText("Ocurrió un error inesperado. Intentá de nuevo.")).not.toHaveAttribute("lang");
    expect(screen.getByText("An unexpected error occurred. Please try again.")).toHaveAttribute("lang", "en-US");
  });

  it("reintenta con el retry de Next", () => {
    const retry = pintar(new Error("boom"));

    fireEvent.click(screen.getByRole("button", { name: /Reintentar/ }));

    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("muestra el digest si lo hay", () => {
    pintar(Object.assign(new Error("boom"), { digest: "abc123" }));

    expect(screen.getByText("Ref. abc123")).toBeInTheDocument();
  });

  it("sin digest no muestra ninguna referencia", () => {
    pintar(new Error("boom"));

    expect(screen.queryByText(/Ref\./)).not.toBeInTheDocument();
  });
});
