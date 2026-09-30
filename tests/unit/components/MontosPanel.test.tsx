/**
 * La tabla de montos (B23): guardar manda sólo lo que la aseguradora cargó, así
 * un cambio en los valores por defecto le llega a lo que no tocó; y media celda
 * vacía usa su lado por defecto en vez de mandar un cero que el servidor rechaza.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MontosPanel } from "@/app/(app)/configuracion/MontosPanel";
import type { RangosDeMonto } from "@/core/case/monto-estimado";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";

const POR_DEFECTO: RangosDeMonto = {
  choque: { low: { minimo: 100, maximo: 200 }, medium: { minimo: 300, maximo: 900 } },
  robo: { low: { minimo: 1000, maximo: 2000 } },
};

const fetchMock = vi.fn();

function mostrar(inicial: RangosDeMonto | null) {
  render(
    <LocaleProvider locale="es-AR">
      <MontosPanel inicial={inicial} porDefecto={POR_DEFECTO} />
    </LocaleProvider>
  );
}

const celda = (nombre: string) => screen.getByLabelText<HTMLInputElement>(nombre);

async function guardarYLeerCuerpo() {
  fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  return JSON.parse(fetchMock.mock.calls[0][1].body);
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("MontosPanel", () => {
  it("el valor por defecto se ve de fondo y guardar no lo congela", async () => {
    mostrar({ robo: { low: { minimo: 1500, maximo: 2500 } } });

    expect(celda("Choque · Bajo · Mínimo").value).toBe("");
    expect(celda("Choque · Bajo · Mínimo").placeholder).toBe("100");
    expect(celda("Robo · Bajo · Mínimo").value).toBe("1500");

    expect(await guardarYLeerCuerpo()).toEqual({ rangos: { robo: { low: { minimo: 1500, maximo: 2500 } } } });
  });

  it("media celda vacía usa su lado por defecto", async () => {
    mostrar(null);
    fireEvent.change(celda("Choque · Medio · Máximo"), { target: { value: "1200" } });

    expect(await guardarYLeerCuerpo()).toEqual({ rangos: { choque: { medium: { minimo: 300, maximo: 1200 } } } });
  });

  it("volver a los de por defecto vacía las celdas", async () => {
    mostrar({ robo: { low: { minimo: 1500, maximo: 2500 } } });
    fireEvent.click(screen.getByRole("button", { name: "Volver a los de por defecto" }));

    await waitFor(() => expect(celda("Robo · Bajo · Mínimo").value).toBe(""));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ rangos: null });
  });
});
