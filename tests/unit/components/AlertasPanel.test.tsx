/**
 * Los recordatorios (B4) se eligen entre tres opciones y viajan en el mismo
 * PATCH que la lista de avisos. Sin poder leerlos, el panel no los muestra ni
 * los manda: guardar la lista no puede apagarlos por accidente.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AlertasPanel } from "@/app/(app)/configuracion/AlertasPanel";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";

const fetchMock = vi.fn();

function mostrar(horasIniciales?: number[]) {
  render(
    <LocaleProvider locale="es-AR">
      <AlertasPanel inicial={["a@b.com"]} horasIniciales={horasIniciales} />
    </LocaleProvider>
  );
}

async function guardarYLeerCuerpo() {
  fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  return JSON.parse(fetchMock.mock.calls[0][1].body);
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ emails: ["a@b.com"] }) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("AlertasPanel: recordatorios", () => {
  it.each([
    ["apagado", []],
    ["h48", [48]],
    ["h48y120", [48, 120]],
  ])("la opción %s manda %j", async (opcion, horas) => {
    mostrar([48]);
    fireEvent.change(screen.getByLabelText("Recordatorios de lo que falta"), { target: { value: opcion } });

    expect(await guardarYLeerCuerpo()).toEqual({ emails: ["a@b.com"], recordatorio_horas: horas });
  });

  it("arranca en la opción que tiene el tenant", () => {
    mostrar([48, 120]);
    expect(screen.getByLabelText<HTMLSelectElement>("Recordatorios de lo que falta").value).toBe("h48y120");
  });

  // Antes caían en «apagado» y guardar sólo la lista los apagaba.
  it.each([[[72]], [[48, 96]]])("horas fuera de las opciones (%j) se muestran y se conservan", async (horas) => {
    mostrar(horas);
    const selector = screen.getByLabelText<HTMLSelectElement>("Recordatorios de lo que falta");
    expect(selector.value).toBe("actual");
    expect(selector.selectedOptions[0].textContent).toBe(`A las ${horas.join(", ")} h (como está hoy)`);

    expect(await guardarYLeerCuerpo()).toEqual({ emails: ["a@b.com"], recordatorio_horas: horas });
  });

  it("con una de las tres no ofrece la opción de «como está hoy»", () => {
    mostrar([48]);
    expect(screen.queryByRole("option", { name: /como está hoy/ })).toBeNull();
  });

  it("sin horas leídas no hay selector ni campo en el PATCH", async () => {
    mostrar();
    expect(screen.queryByLabelText("Recordatorios de lo que falta")).toBeNull();

    expect(await guardarYLeerCuerpo()).toEqual({ emails: ["a@b.com"] });
  });
});
