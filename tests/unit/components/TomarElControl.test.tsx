/**
 * «Tomar el control» (D-F2) y su espejo «Devolver al agente» (E24): el botón
 * sólo con el permiso, el diálogo de un solo sentido, y el cuerpo exacto del
 * PATCH. Y dejar un caso listo con faltantes, que pide confirmar antes del PATCH.
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

describe("Marcar como relevante", () => {
  function renderDescartado(puedeMarcarRelevante: boolean) {
    return render(
      <LocaleProvider locale="es-AR">
        <CaseDetailClient
          caseId="c1"
          status={"no_relevante" as CaseStatus}
          caseNumber="#1"
          paraResponder={false}
          vistoEn="2026-09-25T12:00:00.000Z"
          puedeMarcar={false}
          acciones={SIN_ACCIONES}
          puedeCambiarEstado={true}
          puedeTomarElControl={false}
          puedeDevolverAlAgente={false}
          puedeMarcarRelevante={puedeMarcarRelevante}
        />
      </LocaleProvider>
    );
  }

  it("sin el permiso, no aparece el botón", () => {
    renderDescartado(false);
    expect(screen.queryByTestId("action-marcar-relevante")).not.toBeInTheDocument();
  });

  it("al hacer clic, el POST a re-analyze manda {marcar_relevante: true} y avisa", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);
    renderDescartado(true);

    fireEvent.click(screen.getByTestId("action-marcar-relevante"));

    await screen.findByText("Marcado como relevante: vuelve al agente");

    expect(fetchMock).toHaveBeenCalledWith("/api/cases/c1/re-analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marcar_relevante: true }),
    });
  });

  it("si el servidor dice 409 o 403, el aviso es el de «cambio no válido»", async () => {
    for (const status of [409, 403]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status }));
      const { unmount } = renderDescartado(true);

      fireEvent.click(screen.getByTestId("action-marcar-relevante"));

      await screen.findByText("Ese cambio de situación no es válido.");
      unmount();
    }
  });
});

describe("Dejarlo listo con faltantes", () => {
  const FALTANTES = ["Fotos de los daños", "Hora aproximada"];

  function renderListo(status: CaseStatus, faltantes: string[]) {
    return render(
      <LocaleProvider locale="es-AR">
        <CaseDetailClient
          caseId="c1"
          status={status}
          caseNumber="#1"
          paraResponder={false}
          vistoEn="2026-09-25T12:00:00.000Z"
          puedeMarcar={false}
          acciones={SIN_ACCIONES}
          puedeCambiarEstado={true}
          puedeTomarElControl={false}
          puedeDevolverAlAgente={false}
          faltantes={faltantes}
        />
      </LocaleProvider>
    );
  }

  it("«Revisado» con faltantes los nombra y no manda nada hasta confirmar", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    renderListo("requiere_especialista" as CaseStatus, FALTANTES);

    fireEvent.click(screen.getByTestId("action-revisado-listo"));

    expect(screen.getByText("¿Dejarlo listo con faltantes?")).toBeInTheDocument();
    expect(
      screen.getByText("Todavía falta: Fotos de los daños, Hora aproximada. El agente deja de pedirlos.")
    ).toBeInTheDocument();
    expect(screen.getByTestId("action-revisado-listo")).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("listo-con-faltantes-confirm-button"));

    await screen.findByText("Quedó confirmado como listo para entregar");
    expect(fetchMock).toHaveBeenCalledWith("/api/cases/c1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "listo_para_core", confirmar_listo: true }),
    });
  });

  it("«Confirmar y dejar listo» con faltantes pide confirmar y manda sólo {confirmar_listo}", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    renderListo("listo_para_core" as CaseStatus, FALTANTES);

    fireEvent.click(screen.getByTestId("action-confirmar-listo"));
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("listo-con-faltantes-confirm-button"));

    await screen.findByText("Quedó confirmado como listo para entregar");
    expect(fetchMock).toHaveBeenCalledWith("/api/cases/c1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmar_listo: true }),
    });
  });

  it("cancelar cierra el diálogo sin mandar el PATCH", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderListo("requiere_especialista" as CaseStatus, FALTANTES);

    fireEvent.click(screen.getByTestId("action-revisado-listo"));
    fireEvent.click(screen.getByText("Cancelar"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sin faltantes no hay diálogo: el PATCH sale directo", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    renderListo("requiere_especialista" as CaseStatus, []);

    fireEvent.click(screen.getByTestId("action-revisado-listo"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await screen.findByText("Quedó confirmado como listo para entregar");
    expect(fetchMock).toHaveBeenCalledWith("/api/cases/c1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "listo_para_core", confirmar_listo: true }),
    });
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
