/**
 * El foco de un diálogo, cuando el diálogo no tiene nada enfocable.
 *
 * `ENFOCABLES` excluye lo deshabilitado, y `EscalateDialog` y
 * `CloseConfirmDialog` deshabilitan el textarea y los dos botones mientras
 * `loading` es true. En esa ventana la lista salía VACÍA, `primero` y `ultimo`
 * quedaban `undefined`, ninguna rama disparaba `preventDefault`, y el Tab se
 * escapaba del diálogo a la bandeja de atrás — que tiene filas enfocables, y
 * donde Espacio sigue marcando.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { useDialogoModal } from "../../../src/app/(app)/_components/dialogo-modal";

/** Un diálogo con tres controles que se pueden apagar todos a la vez. */
function Dialogo({
  guardando,
  alCerrar,
}: {
  guardando: boolean;
  alCerrar: () => void;
}) {
  const panel = useDialogoModal<HTMLDivElement>(alCerrar);
  return (
    <div>
      <button type="button">afuera</button>
      <div ref={panel} role="dialog" aria-label="probando">
        <textarea disabled={guardando} aria-label="motivo" />
        <button type="button" disabled={guardando}>
          cancelar
        </button>
        <button type="button" disabled={guardando}>
          confirmar
        </button>
      </div>
    </div>
  );
}

describe("useDialogoModal", () => {
  it("con controles habilitados, el Tab circula adentro", () => {
    render(<Dialogo guardando={false} alCerrar={vi.fn()} />);

    const confirmar = screen.getByRole("button", { name: "confirmar" });
    confirmar.focus();

    // Desde el último, el Tab vuelve al primero y no sale.
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByLabelText("motivo"));
  });

  it("mientras guarda, con todo deshabilitado, el Tab NO se escapa", () => {
    render(<Dialogo guardando alCerrar={vi.fn()} />);

    const panel = screen.getByRole("dialog");
    const afuera = screen.getByRole("button", { name: "afuera" });

    fireEvent.keyDown(document, { key: "Tab" });

    // El foco se queda en el panel. Antes se caía en «afuera», que en la
    // bandeja de verdad es una fila que Espacio marca.
    expect(document.activeElement).toBe(panel);
    expect(document.activeElement).not.toBe(afuera);
  });

  it("Escape cierra igual mientras guarda", () => {
    const alCerrar = vi.fn();
    render(<Dialogo guardando alCerrar={alCerrar} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(alCerrar).toHaveBeenCalledOnce();
  });
});
