/**
 * Quién tiene el caso y cómo cambiarlo desde la ficha (B9).
 *
 * El componente es un espejo de `puedeAsignar`: la decisión es de la ruta, pero
 * no ofrece lo que ella rechazaría.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AsignarCaso } from "@/app/(app)/casos/[id]/_components/AsignarCaso";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

const fetchMock = vi.fn();

const CARGA = [
  { id: "user-2", full_name: "Beto Bravo", role: "analyst", abiertos: 1 },
  { id: "user-1", full_name: "Ana Analista", role: "specialist", abiertos: 4 },
];

interface Props {
  rol?: string;
  asignadoA?: string | null;
  nombreAsignado?: string | null;
  carga?: typeof CARGA;
}

function mostrar({ rol = "owner", asignadoA = null, nombreAsignado = null, carga = CARGA }: Props = {}) {
  render(
    <LocaleProvider locale="es-AR">
      <AsignarCaso
        caseId="caso-1"
        rol={rol}
        miId="user-me"
        asignadoA={asignadoA}
        nombreAsignado={nombreAsignado}
        carga={carga}
      />
    </LocaleProvider>
  );
}

const cuerpoEnviado = () => JSON.parse(fetchMock.mock.calls[0][1].body);

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("AsignarCaso: quien asigna a terceros", () => {
  it.each(["owner", "admin", "specialist"])("%s elige entre sin asignar y cada persona, con su carga", (rol) => {
    mostrar({ rol });

    const select = screen.getByLabelText("Asignar el caso a");
    const opciones = Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);
    expect(opciones).toEqual(["Sin asignar", "Beto Bravo (1 abiertos)", "Ana Analista (4 abiertos)"]);
    expect(screen.queryByRole("button", { name: "Tomar" })).toBeNull();
  });

  it("elegir a alguien manda el PATCH del caso con su id y refresca", async () => {
    mostrar();

    fireEvent.change(screen.getByLabelText("Asignar el caso a"), { target: { value: "user-2" } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/cases/caso-1");
    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
    expect(cuerpoEnviado()).toEqual({ assigned_to: "user-2" });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("elegir «Sin asignar» manda null", async () => {
    mostrar({ asignadoA: "user-1", nombreAsignado: "Ana Analista" });

    fireEvent.change(screen.getByLabelText("Asignar el caso a"), { target: { value: "" } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(cuerpoEnviado()).toEqual({ assigned_to: null });
  });

  it("el select arranca en quien tiene el caso", () => {
    mostrar({ asignadoA: "user-1", nombreAsignado: "Ana Analista" });

    expect((screen.getByLabelText("Asignar el caso a") as HTMLSelectElement).value).toBe("user-1");
  });

  it("quien lo tiene y ya no edita no desaparece del select", () => {
    mostrar({ asignadoA: "user-9", nombreAsignado: "Carla Vieja", carga: [CARGA[0]] });

    const select = screen.getByLabelText("Asignar el caso a") as HTMLSelectElement;
    expect(select.value).toBe("user-9");
    expect(Array.from(select.options).map((o) => o.textContent)).toContain("Carla Vieja");
  });

  it("si no se pudo leer el nombre, la opción dice «Asignado»", () => {
    mostrar({ asignadoA: "user-9", nombreAsignado: null, carga: [] });

    expect(screen.getByRole("option", { name: "Asignado" })).toBeInTheDocument();
  });

  it("un rechazo muestra el aviso y refresca igual para ver quién lo tiene ahora", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 403 });
    mostrar();

    fireEvent.change(screen.getByLabelText("Asignar el caso a"), { target: { value: "user-2" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cambiar la asignación.");
    expect(refresh).toHaveBeenCalled();
  });

  it("sin red también muestra el aviso", async () => {
    fetchMock.mockRejectedValue(new Error("sin red"));
    mostrar();

    fireEvent.change(screen.getByLabelText("Asignar el caso a"), { target: { value: "user-2" } });

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cambiar la asignación.");
  });
});

describe("AsignarCaso: analista", () => {
  it("con el caso libre, «Tomar» lo asigna a sí mismo", async () => {
    mostrar({ rol: "analyst", carga: [] });

    expect(screen.getByText("Sin asignar")).toBeInTheDocument();
    expect(screen.queryByLabelText("Asignar el caso a")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Tomar" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(cuerpoEnviado()).toEqual({ assigned_to: "user-me" });
  });

  it("con un caso propio, «Soltar» lo deja sin asignar", async () => {
    mostrar({ rol: "analyst", asignadoA: "user-me", nombreAsignado: "Yo Mismo", carga: [] });

    expect(screen.getByText("Yo Mismo")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Soltar" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(cuerpoEnviado()).toEqual({ assigned_to: null });
  });

  it("con el caso de otro, ve el nombre y ningún botón", () => {
    mostrar({ rol: "analyst", asignadoA: "user-1", nombreAsignado: "Ana Analista", carga: [] });

    expect(screen.getByText("Ana Analista")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
