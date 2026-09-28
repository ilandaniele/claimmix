/**
 * «Tomar el control» (D-F2) y su espejo «Devolver al agente» (E24): el botón
 * sólo con el permiso, el diálogo de un solo sentido, y el cuerpo exacto del
 * PATCH.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CaseDetailClient } from "../../../src/app/(app)/casos/[id]/CaseDetailClient";
import { LocaleProvider } from "../../../src/lib/i18n/LocaleContext";
import { SIN_ACCIONES } from "../../../src/server/cases/acciones";
import type { CaseStatus } from "../../../src/lib/schemas/cases";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDetalle(puedeTomarElControl: boolean) {
  return render(
    <LocaleProvider locale="es-AR">
      <CaseDetailClient
        caseId="c1"
        status="info_faltante"
        caseNumber="#1"
        paraResponder={false}
        vistoEn="2026-09-25T12:00:00.000Z"
        puedeMarcar={false}
        acciones={SIN_ACCIONES}
        puedeCambiarEstado={true}
        puedeTomarElControl={puedeTomarElControl}
        puedeDevolverAlAgente={false}
      />
    </LocaleProvider>
  );
}

function renderRequiereEspecialista(puedeDevolverAlAgente: boolean) {
  return render(
    <LocaleProvider locale="es-AR">
      <CaseDetailClient
        caseId="c1"
        status={"requiere_especialista" as CaseStatus}
        caseNumber="#1"
        paraResponder={false}
        vistoEn="2026-09-25T12:00:00.000Z"
        puedeMarcar={false}
        acciones={SIN_ACCIONES}
        puedeCambiarEstado={true}
        puedeTomarElControl={false}
        puedeDevolverAlAgente={puedeDevolverAlAgente}
      />
    </LocaleProvider>
  );
}

describe("Tomar el control (D-F2)", () => {
  it("sin el permiso, no aparece el botón", () => {
    renderDetalle(false);
    expect(screen.queryByTestId("action-tomar-el-control")).not.toBeInTheDocument();
  });

  it("con el permiso, el botón abre el diálogo de un solo sentido", () => {
    renderDetalle(true);
    fireEvent.click(screen.getByTestId("action-tomar-el-control"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("al confirmar, el PATCH manda exactamente {status, reason} del contrato", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    renderDetalle(true);

    fireEvent.click(screen.getByTestId("action-tomar-el-control"));
    fireEvent.click(screen.getByTestId("tomar-el-control-confirm-button"));

    await screen.findByText("Situación actualizada.");

    expect(fetchMock).toHaveBeenCalledWith("/api/cases/c1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "requiere_especialista", reason: "tomar_el_control" }),
    });
  });

  it("cancelar cierra el diálogo sin mandar el PATCH", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderDetalle(true);

    fireEvent.click(screen.getByTestId("action-tomar-el-control"));
    fireEvent.click(screen.getByText("Cancelar"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Devolver al agente (E24)", () => {
  it("sin el permiso, no aparece el botón", () => {
    renderRequiereEspecialista(false);
    expect(screen.queryByTestId("action-devolver-al-agente")).not.toBeInTheDocument();
  });

  it("con el permiso, el botón abre el diálogo con el texto de devolver", () => {
    renderRequiereEspecialista(true);
    fireEvent.click(screen.getByTestId("action-devolver-al-agente"));
    expect(screen.getByText("¿Devolver el caso al agente?")).toBeInTheDocument();
    expect(screen.getByTestId("devolver-al-agente-confirm-button")).toBeInTheDocument();
  });

  it("al confirmar, el PATCH manda exactamente {status, reason} del contrato", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    renderRequiereEspecialista(true);

    fireEvent.click(screen.getByTestId("action-devolver-al-agente"));
    fireEvent.click(screen.getByTestId("devolver-al-agente-confirm-button"));

    await screen.findByText("Situación actualizada.");

    expect(fetchMock).toHaveBeenCalledWith("/api/cases/c1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "info_faltante", reason: "devolver_al_agente" }),
    });
  });
});
