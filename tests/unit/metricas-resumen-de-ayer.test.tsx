/**
 * El resumen de ayer de /metricas, dibujado.
 *
 * Server component sin estado: lo que se afirma es que los siete números
 * lleguen a la pantalla con el rótulo que les toca, en los dos idiomas.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResumenDeAyer } from "@/app/(app)/metricas/_components/ResumenDeAyer";

const RESUMEN = {
  reclamos: 3,
  whatsapps: 5,
  mails: 2,
  escalados: 1,
  cerrados: 4,
  para_responder: 7,
  confirmacion_pendiente: 6,
};

describe("ResumenDeAyer", () => {
  it("en es-AR muestra los títulos y cada número", () => {
    render(<ResumenDeAyer resumen={RESUMEN} locale="es-AR" />);

    expect(screen.getByText("Resumen de ayer")).toBeInTheDocument();
    expect(screen.getByText("Pendientes ahora")).toBeInTheDocument();
    expect(screen.getByText("Para responder")).toBeInTheDocument();
    expect(screen.getByText("Confirmación pendiente")).toBeInTheDocument();
    for (const n of Object.values(RESUMEN)) {
      expect(screen.getByText(String(n))).toBeInTheDocument();
    }
  });

  it("en en-US traduce los títulos", () => {
    render(<ResumenDeAyer resumen={RESUMEN} locale="en-US" />);

    expect(screen.getByText("Yesterday's summary")).toBeInTheDocument();
    expect(screen.getByText("Needs reply")).toBeInTheDocument();
  });
});
