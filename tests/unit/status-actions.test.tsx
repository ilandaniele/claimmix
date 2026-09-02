/**
 * Unit tests for StatusActions component.
 *
 * AC15: Verifies correct buttons are shown per FSM status:
 *   listo:      "Cerrar siniestro" + "Escalar" + ExportToCore
 *   esperando:  "Marcar completo" + "Escalar" + "Cerrar"
 *   escalado:   "Resolver escalado → Listo" + "Cerrar"
 *   procesando: No action buttons — spinner
 *   cerrado:    Read-only "Siniestro cerrado" banner
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import { StatusActions } from "../../src/app/(app)/casos/[id]/components/StatusActions";
import type { CaseStatus } from "../../src/lib/schemas/cases";

// Stub ExportToCorePanel to avoid network calls
vi.mock(
  "../../src/app/(app)/casos/[id]/components/ExportToCorePanel",
  () => ({
    ExportToCorePanel: ({ caseId }: { caseId: string }) => (
      <button data-testid="export-core-button" data-case-id={caseId}>
        Exportar al Core
      </button>
    ),
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
};

function renderStatus(status: CaseStatus, overrides: Record<string, unknown> = {}) {
  return render(
    <StatusActions {...defaultProps} status={status} {...overrides} />
  );
}

describe("StatusActions — listo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows Cerrar siniestro button", () => {
    renderStatus("listo");
    expect(
      screen.getByRole("button", { name: /cerrar siniestro/i })
    ).toBeInTheDocument();
  });

  it("shows Escalar button", () => {
    renderStatus("listo");
    expect(
      screen.getByRole("button", { name: /escalar/i })
    ).toBeInTheDocument();
  });

  it("shows Exportar al Core button", () => {
    renderStatus("listo");
    expect(screen.getByTestId("export-core-button")).toBeInTheDocument();
  });

  it("calls onClose when Cerrar is clicked", () => {
    renderStatus("listo");
    fireEvent.click(screen.getByTestId("action-cerrar"));
    expect(defaultProps.onClose).toHaveBeenCalledOnce();
  });

  it("calls onEscalate when Escalar is clicked", () => {
    renderStatus("listo");
    fireEvent.click(screen.getByTestId("action-escalar"));
    expect(defaultProps.onEscalate).toHaveBeenCalledOnce();
  });

  it("disables buttons when dialogOpen=true", () => {
    renderStatus("listo", { dialogOpen: true });
    expect(screen.getByTestId("action-cerrar")).toBeDisabled();
    expect(screen.getByTestId("action-escalar")).toBeDisabled();
  });
});

describe("StatusActions — esperando", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows Marcar completo button", () => {
    renderStatus("esperando");
    expect(
      screen.getByRole("button", { name: /marcar completo/i })
    ).toBeInTheDocument();
  });

  it("shows Escalar button", () => {
    renderStatus("esperando");
    expect(
      screen.getByRole("button", { name: /^escalar$/i })
    ).toBeInTheDocument();
  });

  it("shows gray Cerrar button", () => {
    renderStatus("esperando");
    expect(screen.getByTestId("action-cerrar")).toBeInTheDocument();
  });

  it("calls onTransition with 'listo' when Marcar completo is clicked", () => {
    renderStatus("esperando");
    fireEvent.click(screen.getByTestId("action-marcar-completo"));
    expect(defaultProps.onTransition).toHaveBeenCalledWith("listo");
  });

  it("calls onEscalate when Escalar is clicked", () => {
    renderStatus("esperando");
    fireEvent.click(screen.getByTestId("action-escalar"));
    expect(defaultProps.onEscalate).toHaveBeenCalledOnce();
  });

  it("calls onClose when Cerrar is clicked", () => {
    renderStatus("esperando");
    fireEvent.click(screen.getByTestId("action-cerrar"));
    expect(defaultProps.onClose).toHaveBeenCalledOnce();
  });
});

describe("StatusActions — escalado", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows Resolver escalado button", () => {
    renderStatus("escalado");
    expect(screen.getByTestId("action-resolver-escalado")).toBeInTheDocument();
  });

  it("shows Cerrar button", () => {
    renderStatus("escalado");
    expect(screen.getByTestId("action-cerrar")).toBeInTheDocument();
  });

  it("does NOT show Escalar button", () => {
    renderStatus("escalado");
    expect(screen.queryByTestId("action-escalar")).not.toBeInTheDocument();
  });

  it("calls onTransition with 'listo' when Resolver is clicked", () => {
    renderStatus("escalado");
    fireEvent.click(screen.getByTestId("action-resolver-escalado"));
    expect(defaultProps.onTransition).toHaveBeenCalledWith("listo");
  });

  it("calls onClose when Cerrar is clicked", () => {
    renderStatus("escalado");
    fireEvent.click(screen.getByTestId("action-cerrar"));
    expect(defaultProps.onClose).toHaveBeenCalledOnce();
  });
});

describe("StatusActions — procesando", () => {
  it("shows processing spinner, no action buttons", () => {
    renderStatus("procesando");
    // Spinner / status message is present
    expect(screen.getByRole("status")).toBeInTheDocument();
    // No action buttons
    expect(screen.queryByTestId("action-cerrar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("action-escalar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("action-resolver-escalado")).not.toBeInTheDocument();
  });
});

describe("StatusActions — cerrado", () => {
  it("shows read-only closed banner", () => {
    renderStatus("cerrado");
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(/siniestro cerrado/i)).toBeInTheDocument();
  });

  it("shows no action buttons", () => {
    renderStatus("cerrado");
    expect(screen.queryByTestId("action-cerrar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("action-escalar")).not.toBeInTheDocument();
  });
});
