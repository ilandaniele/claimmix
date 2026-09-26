/**
 * Unit tests for the P8 hunks of StatusActions: reenviar pedido / reabrir y
 * reenviar.
 *
 * Aparte de `status-actions.test.tsx` (P6) para no tocar sus tests.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { StatusActions } from "../../src/app/(app)/casos/[id]/components/StatusActions";
import type { CaseStatus } from "../../src/lib/schemas/cases";
import { SIN_ACCIONES } from "../../src/server/cases/acciones";

vi.mock(
  "../../src/app/(app)/casos/[id]/components/ExportToCorePanel",
  () => ({
    ExportToCorePanel: () => <div data-testid="export-core-button" />,
  })
);

const defaultProps = {
  caseId: "00000000-0000-0000-0000-000000000001",
  caseNumber: "SIN-ABCD-1234",
  onClose: vi.fn(),
  onEscalate: vi.fn(),
  onTransition: vi.fn(),
  onError: vi.fn(),
  onReAnalyze: vi.fn(),
  reAnalyzing: false,
  dialogOpen: false,
  acciones: SIN_ACCIONES,
  puedeCambiarEstado: true,
  onConfirmarListo: vi.fn(),
  onRevisadoListo: vi.fn(),
};

function renderStatus(status: CaseStatus, overrides: Record<string, unknown> = {}) {
  return render(<StatusActions {...defaultProps} status={status} {...overrides} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("StatusActions — info_faltante / confirmacion_pendiente (P8)", () => {
  it("muestra el botón de reenviar y llama a onReenviar(false)", () => {
    const onReenviar = vi.fn();
    renderStatus("info_faltante", {
      onReenviar,
      acciones: { ...SIN_ACCIONES, puedeReenviar: true },
    });
    fireEvent.click(screen.getByTestId("action-reenviar-pedido"));
    expect(onReenviar).toHaveBeenCalledWith(false);
  });

  it("confirmacion_pendiente también muestra el botón de reenviar", () => {
    renderStatus("confirmacion_pendiente", {
      onReenviar: vi.fn(),
      acciones: { ...SIN_ACCIONES, puedeReenviar: true },
    });
    expect(screen.getByTestId("action-reenviar-pedido")).toBeInTheDocument();
  });

  it("con motivo, el botón queda deshabilitado y se ve el motivo", () => {
    renderStatus("info_faltante", {
      onReenviar: vi.fn(),
      acciones: { ...SIN_ACCIONES, puedeReenviar: false, motivoSinReenvio: "nada_pendiente" },
    });
    const boton = screen.getByTestId("action-reenviar-pedido");
    expect(boton).toBeDisabled();
    expect(boton).toHaveAttribute("aria-describedby", "motivo-reenvio");
    expect(screen.getByText("No queda nada por pedir")).toBeInTheDocument();
  });

  it("sin onReenviar, no hay botón de reenviar (sólo re-analizar)", () => {
    renderStatus("info_faltante");
    expect(screen.queryByTestId("action-reenviar-pedido")).not.toBeInTheDocument();
    expect(screen.getByTestId("action-re-analizar")).toBeInTheDocument();
  });
});

describe("StatusActions — cerrado (P8)", () => {
  it("reabrible, muestra «Reabrir y reenviar» y llama a onReenviar(true)", () => {
    const onReenviar = vi.fn();
    renderStatus("cerrado", {
      onReenviar,
      acciones: { ...SIN_ACCIONES, reabrible: true, puedeReenviar: true },
    });
    fireEvent.click(screen.getByTestId("action-reabrir-reenviar"));
    expect(onReenviar).toHaveBeenCalledWith(true);
    // El banner de sólo lectura sigue ahí.
    expect(screen.getByRole("status", { name: /siniestro cerrado/i })).toBeInTheDocument();
  });

  it("sin reabrible, sólo el banner", () => {
    renderStatus("cerrado", {
      onReenviar: vi.fn(),
      acciones: { ...SIN_ACCIONES, reabrible: false },
    });
    expect(screen.queryByTestId("action-reabrir-reenviar")).not.toBeInTheDocument();
    expect(screen.getByText(/siniestro cerrado/i)).toBeInTheDocument();
  });

  it("sin permiso para cambiar el estado, sólo el banner", () => {
    renderStatus("cerrado", {
      onReenviar: vi.fn(),
      puedeCambiarEstado: false,
      acciones: { ...SIN_ACCIONES, reabrible: true, puedeReenviar: true },
    });
    expect(screen.queryByTestId("action-reabrir-reenviar")).not.toBeInTheDocument();
  });

  it("sin onReenviar, sólo el banner aunque sea reabrible", () => {
    renderStatus("cerrado", {
      acciones: { ...SIN_ACCIONES, reabrible: true, puedeReenviar: true },
    });
    expect(screen.queryByTestId("action-reabrir-reenviar")).not.toBeInTheDocument();
  });
});
