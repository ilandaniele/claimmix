/**
 * El checklist de trabajo de la ficha (B11): próximos pasos arriba, hechos
 * abajo, y una casilla que responde al toque aunque el servidor tarde.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PlanDeTrabajo } from "@/app/(app)/casos/[id]/_components/PlanDeTrabajo";
import { LocaleProvider } from "@/lib/i18n/LocaleContext";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh }) }));

const fetchMock = vi.fn();

const PASOS = [
  { clave: "revisar_documentacion", titulo: "Revisar la documentación", orden: 0, auto: null, hecho: true },
  { clave: "pedir_presupuesto", titulo: "Pedir el presupuesto", orden: 1, auto: null, hecho: false },
  { clave: "entregar_a_aseguradora", titulo: "Entregar el caso", orden: 2, auto: "en_liquidacion", hecho: false },
];

const arbol = (pasos: typeof PASOS, puedeCambiarEstado = true) => (
  <LocaleProvider locale="es-AR">
    <PlanDeTrabajo caseId="caso-1" pasos={pasos} puedeCambiarEstado={puedeCambiarEstado} />
  </LocaleProvider>
);

function mostrar(puedeCambiarEstado = true, pasos = PASOS) {
  return render(arbol(pasos, puedeCambiarEstado));
}

beforeEach(() => {
  fetchMock.mockReset();
  refresh.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("PlanDeTrabajo", () => {
  it("los que faltan van arriba, en el orden del plan, y los hechos abajo", () => {
    mostrar();

    const titulos = screen.getAllByRole("checkbox").map((c) => c.closest("label")?.textContent);
    expect(titulos).toEqual(["Pedir el presupuesto", "Entregar el caso", "Revisar la documentación"]);
    expect(screen.getByText("Próximos pasos")).toBeInTheDocument();
    expect(screen.getByText("Hechos")).toBeInTheDocument();
  });

  it("marca las casillas según `hecho`", () => {
    mostrar();

    expect(screen.getByRole("checkbox", { name: "Revisar la documentación" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Pedir el presupuesto" })).not.toBeChecked();
  });

  it("rotula «automático» sólo el paso que se tilda solo", () => {
    mostrar();

    expect(screen.getAllByText("automático")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: "Entregar el caso" }).closest("li")).toHaveTextContent("automático");
  });

  it("sin permiso las casillas quedan a la vista y deshabilitadas", () => {
    mostrar(false);

    for (const c of screen.getAllByRole("checkbox")) expect(c).toBeDisabled();
  });

  it("tildar manda PATCH /plan con la clave y hecho true, y refresca", async () => {
    mostrar();

    fireEvent.click(screen.getByRole("checkbox", { name: "Pedir el presupuesto" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/cases/caso-1/plan");
    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ clave: "pedir_presupuesto", hecho: true });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("destildar manda hecho false", async () => {
    mostrar();

    fireEvent.click(screen.getByRole("checkbox", { name: "Revisar la documentación" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ clave: "revisar_documentacion", hecho: false });
  });

  it("la casilla responde antes de que llegue la respuesta", async () => {
    let responder: (v: { ok: boolean }) => void = () => {};
    fetchMock.mockReturnValue(new Promise((r) => (responder = r)));
    mostrar();

    fireEvent.click(screen.getByRole("checkbox", { name: "Pedir el presupuesto" }));

    expect(screen.getByRole("checkbox", { name: "Pedir el presupuesto" })).toBeChecked();
    responder({ ok: true });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("un rechazo devuelve la casilla a lo que dice el servidor y avisa", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    mostrar();

    fireEvent.click(screen.getByRole("checkbox", { name: "Pedir el presupuesto" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo actualizar el paso.");
    // useOptimistic revierte cuando termina la transición, que puede ser después del aviso.
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Pedir el presupuesto" })).not.toBeChecked());
    expect(refresh).toHaveBeenCalled();
  });

  it("sin red vale lo mismo que un rechazo", async () => {
    fetchMock.mockRejectedValue(new Error("sin red"));
    mostrar();

    fireEvent.click(screen.getByRole("checkbox", { name: "Pedir el presupuesto" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("checkbox", { name: "Pedir el presupuesto" })).not.toBeChecked());
  });

  it("lo que se tocó acá no tapa un cambio que llega después de otra persona", async () => {
    const { rerender } = mostrar();
    const presupuesto = () => screen.getByRole("checkbox", { name: "Pedir el presupuesto" });

    fireEvent.click(presupuesto());
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // El servidor confirma la marca...
    rerender(arbol(PASOS.map((p) => (p.clave === "pedir_presupuesto" ? { ...p, hecho: true } : p))));
    expect(presupuesto()).toBeChecked();
    // ...y otra persona la destilda: manda lo que dice la página, no lo que se tocó acá.
    rerender(arbol(PASOS));
    expect(presupuesto()).not.toBeChecked();
  });

  it("con todo hecho no pinta la sección de próximos pasos", () => {
    mostrar(true, PASOS.map((p) => ({ ...p, hecho: true })));

    expect(screen.queryByText("Próximos pasos")).toBeNull();
    expect(screen.getByText("Hechos")).toBeInTheDocument();
  });
});
