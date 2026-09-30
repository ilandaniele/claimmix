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
import { SIN_ACCIONES } from "../../src/server/cases/acciones";

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
  acciones: SIN_ACCIONES,
  puedeCambiarEstado: true,
  onConfirmarListo: vi.fn(),
  onRevisadoListo: vi.fn(),
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

// ── listo_para_core / requiere_especialista — confirmación de una persona (P6) ──

describe("StatusActions — listo_para_core", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sin confirmar y con permiso, el botón confirma", () => {
    renderStatus("listo_para_core");
    fireEvent.click(screen.getByTestId("action-confirmar-listo"));
    expect(defaultProps.onConfirmarListo).toHaveBeenCalledOnce();
  });

  it("confirmado, muestra «Confirmado por Ana» y no el botón", () => {
    renderStatus("listo_para_core", {
      acciones: { ...SIN_ACCIONES, confirmado: true, confirmadoPor: "Ana" },
    });
    expect(screen.getByText("Confirmado por Ana")).toBeInTheDocument();
    expect(screen.queryByTestId("action-confirmar-listo")).not.toBeInTheDocument();
  });

  it("sin permiso, no muestra el botón de confirmar", () => {
    renderStatus("listo_para_core", { puedeCambiarEstado: false });
    expect(screen.queryByTestId("action-confirmar-listo")).not.toBeInTheDocument();
    expect(screen.getByTestId("action-re-analizar")).toBeInTheDocument();
  });
});

describe("StatusActions — requiere_especialista", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("con permiso, muestra los dos botones y cada uno llama a su handler", () => {
    renderStatus("requiere_especialista");
    fireEvent.click(screen.getByTestId("action-revisado-listo"));
    expect(defaultProps.onRevisadoListo).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId("action-cerrar"));
    expect(defaultProps.onClose).toHaveBeenCalledOnce();
  });

  it("sin permiso, sólo queda re-analizar", () => {
    renderStatus("requiere_especialista", { puedeCambiarEstado: false });
    expect(screen.queryByTestId("action-revisado-listo")).not.toBeInTheDocument();
    expect(screen.queryByTestId("action-cerrar")).not.toBeInTheDocument();
    expect(screen.getByTestId("action-re-analizar")).toBeInTheDocument();
  });

  // E24
  it("con puedeDevolverAlAgente, muestra el botón y llama a su handler", () => {
    const onDevolverAlAgente = vi.fn();
    renderStatus("requiere_especialista", { puedeDevolverAlAgente: true, onDevolverAlAgente });
    fireEvent.click(screen.getByTestId("action-devolver-al-agente"));
    expect(onDevolverAlAgente).toHaveBeenCalledOnce();
  });

  it("sin puedeDevolverAlAgente, no aparece el botón", () => {
    renderStatus("requiere_especialista");
    expect(screen.queryByTestId("action-devolver-al-agente")).not.toBeInTheDocument();
  });
});

// ── SALIDAS_A_MANO (B25) — una persona saca el caso de la entrega al Core ──

describe("StatusActions — salidas a mano", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listo_para_core con permiso: «Entregado por fuera» pide confirmación y recién ahí pasa a liquidación", () => {
    renderStatus("listo_para_core");
    fireEvent.click(screen.getByTestId("action-liquidacion"));
    expect(defaultProps.onTransition).not.toHaveBeenCalled();
    expect(screen.getByText("No se puede deshacer. ¿Confirmás?")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("action-liquidacion-confirmar"));
    expect(defaultProps.onTransition).toHaveBeenCalledExactlyOnceWith("en_liquidacion");
    expect(screen.getByTestId("action-liquidacion")).toBeInTheDocument();
  });

  it("«Cancelar» vuelve al botón sin mandar nada", () => {
    renderStatus("listo_para_core");
    fireEvent.click(screen.getByTestId("action-liquidacion"));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(defaultProps.onTransition).not.toHaveBeenCalled();
    expect(screen.queryByTestId("action-liquidacion-confirmar")).not.toBeInTheDocument();
    expect(screen.getByTestId("action-liquidacion")).toBeInTheDocument();
  });

  it("listo_para_core con permiso: «Cerrar» abre el diálogo de cierre y re-analizar sigue", () => {
    renderStatus("listo_para_core");
    fireEvent.click(screen.getByTestId("action-cerrar"));
    expect(defaultProps.onClose).toHaveBeenCalledOnce();
    expect(screen.getByTestId("action-re-analizar")).toBeInTheDocument();
  });

  it("con el diálogo abierto, la salida queda deshabilitada", () => {
    renderStatus("listo_para_core", { dialogOpen: true });
    expect(screen.getByTestId("action-liquidacion")).toBeDisabled();
    expect(screen.getByTestId("action-cerrar")).toBeDisabled();
  });

  it.each(["listo_para_core", "error_core", "enviado_a_core", "en_liquidacion"] as CaseStatus[])(
    "%s sin puedeCambiarEstado: ninguna salida a mano",
    (status) => {
      renderStatus(status, { puedeCambiarEstado: false });
      for (const id of ["action-liquidacion", "action-pagado", "action-rechazado", "action-cerrar"]) {
        expect(screen.queryByTestId(id)).not.toBeInTheDocument();
      }
    }
  );

  it("error_core con permiso: liquidación, cerrar y re-analizar", () => {
    renderStatus("error_core");
    expect(screen.getByText("Entregado por fuera: pasar a liquidación")).toBeInTheDocument();
    expect(screen.getByTestId("action-cerrar")).toBeInTheDocument();
    expect(screen.getByTestId("action-re-analizar")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("action-liquidacion"));
    fireEvent.click(screen.getByTestId("action-liquidacion-confirmar"));
    expect(defaultProps.onTransition).toHaveBeenCalledExactlyOnceWith("en_liquidacion");
  });

  it("enviado_a_core con permiso: pasar a liquidación y cerrar, sin re-analizar", () => {
    renderStatus("enviado_a_core");
    expect(screen.getByText("Pasar a liquidación")).toBeInTheDocument();
    expect(screen.getByTestId("action-cerrar")).toBeInTheDocument();
    expect(screen.queryByTestId("action-re-analizar")).not.toBeInTheDocument();
  });

  it("en_liquidacion con permiso: pagado, rechazado y cerrar, sin re-analizar", () => {
    renderStatus("en_liquidacion");
    expect(screen.queryByTestId("action-re-analizar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("action-liquidacion")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("action-pagado"));
    fireEvent.click(screen.getByTestId("action-pagado-confirmar"));
    expect(defaultProps.onTransition).toHaveBeenLastCalledWith("pagado");

    fireEvent.click(screen.getByTestId("action-rechazado"));
    fireEvent.click(screen.getByTestId("action-rechazado-confirmar"));
    expect(defaultProps.onTransition).toHaveBeenLastCalledWith("rechazado");

    fireEvent.click(screen.getByTestId("action-cerrar"));
    expect(defaultProps.onClose).toHaveBeenCalledOnce();
  });

  // Con dos «Sí, confirmar» iguales a la vista se podía marcar rechazado
  // queriendo pagado, y ninguno se deshace.
  it("en_liquidacion: armar rechazado desarma pagado y la confirmación dice cuál es", () => {
    renderStatus("en_liquidacion");
    fireEvent.click(screen.getByTestId("action-pagado"));
    fireEvent.click(screen.getByTestId("action-rechazado"));

    expect(screen.queryByTestId("action-pagado-confirmar")).not.toBeInTheDocument();
    expect(screen.getByTestId("action-pagado")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Sí, confirmar" })).toHaveLength(1);
    expect(screen.getByRole("group", { name: "Marcar rechazado" })).toHaveTextContent(
      "Marcar rechazado"
    );

    fireEvent.click(screen.getByTestId("action-rechazado-confirmar"));
    expect(defaultProps.onTransition).toHaveBeenCalledExactlyOnceWith("rechazado");
  });

  // Otro analista lo pasó a liquidación con la confirmación armada acá: sin
  // la key, quedaba armado «Marcar pagado», que está en el mismo lugar.
  it("si el estado cambia con una confirmación armada, la siguiente salida arranca sin armar", () => {
    const { rerender } = renderStatus("enviado_a_core");
    fireEvent.click(screen.getByTestId("action-liquidacion"));
    expect(screen.getByTestId("action-liquidacion-confirmar")).toBeInTheDocument();

    rerender(<StatusActions {...defaultProps} status="en_liquidacion" />);

    expect(screen.queryByTestId("action-pagado-confirmar")).not.toBeInTheDocument();
    expect(screen.getByTestId("action-pagado")).toBeInTheDocument();
  });

  it.each([
    ["pagado", "Siniestro pagado"],
    ["rechazado", "Siniestro rechazado"],
  ] as [CaseStatus, string][])("%s: sólo el banner, sin botones", (status, banner) => {
    renderStatus(status);
    expect(screen.getByRole("status")).toHaveTextContent(banner);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
