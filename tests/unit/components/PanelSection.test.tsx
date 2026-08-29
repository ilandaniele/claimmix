/**
 * El panel del detalle de caso: que la sección tenga nombre accesible.
 *
 * Esto existía once veces escrito a mano en `casos/[id]/page.tsx`, con el
 * `aria-labelledby` del `<section>` y el `id` del `<h2>` puestos por separado.
 * Si uno de los once pares no coincidía, el lector de pantalla anunciaba
 * «sección» sin nombre y nadie se enteraba: mirando la pantalla se ve igual.
 *
 * Por eso el test central no es «se ve el título» sino «la sección está
 * etiquetada POR ese título» — que es la línea que el componente existe para
 * garantizar.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { PanelSection } from "@/app/(app)/casos/[id]/_components/PanelSection";

describe("PanelSection", () => {
  it("la sección toma su nombre accesible del encabezado", () => {
    render(
      <PanelSection id="datos-asegurado" titulo="Datos del asegurado">
        <p>contenido</p>
      </PanelSection>
    );

    // getByRole("region", { name }) resuelve el aria-labelledby de verdad:
    // si el id no coincidiera con el del h2, no encontraría nada.
    const seccion = screen.getByRole("region", { name: "Datos del asegurado" });
    expect(seccion.tagName).toBe("SECTION");
    expect(seccion).toContainElement(screen.getByText("contenido"));
  });

  it("dos paneles en la misma pantalla no se pisan los identificadores", () => {
    render(
      <>
        <PanelSection id="uno" titulo="Primero">
          <p>a</p>
        </PanelSection>
        <PanelSection id="dos" titulo="Segundo">
          <p>b</p>
        </PanelSection>
      </>
    );

    expect(screen.getByRole("region", { name: "Primero" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Segundo" })).toBeTruthy();
    // Ningún id repetido: dos secciones con el mismo `aria-labelledby` apuntan
    // las dos al primer h2 y la segunda queda mal anunciada.
    expect(document.querySelectorAll("#uno-heading")).toHaveLength(1);
    expect(document.querySelectorAll("#dos-heading")).toHaveLength(1);
  });

  it("el título puede llevar una insignia adentro y la sección sigue teniendo nombre", () => {
    // Es el caso real del panel de confirmaciones: el h2 lleva un contador.
    render(
      <PanelSection
        id="confirmaciones"
        titulo={
          <>
            Confirmaciones <span>3 pendientes</span>
          </>
        }
      >
        <p>c</p>
      </PanelSection>
    );

    expect(
      screen.getByRole("region", { name: /Confirmaciones\s+3 pendientes/ })
    ).toBeTruthy();
  });

  it("el accesorio va al lado del título, no adentro del nombre de la sección", () => {
    // La insignia de riesgo de fraude: se ve al lado del título pero no forma
    // parte de cómo se anuncia la sección.
    render(
      <PanelSection
        id="fraude"
        tono="peligro"
        titulo="Alertas de fraude"
        accesorio={<span>riesgo alto</span>}
      >
        <p>d</p>
      </PanelSection>
    );

    const seccion = screen.getByRole("region", { name: "Alertas de fraude" });
    expect(seccion).toContainElement(screen.getByText("riesgo alto"));
  });

  it("el tono cambia el marco y el color del título", () => {
    const { container, rerender } = render(
      <PanelSection id="x" titulo="T">
        <p>e</p>
      </PanelSection>
    );

    const neutro = container.querySelector("section")!.className;
    expect(neutro).toContain("bg-white");

    rerender(
      <PanelSection id="x" tono="peligro" titulo="T">
        <p>e</p>
      </PanelSection>
    );

    const peligro = container.querySelector("section")!.className;
    expect(peligro).toContain("bg-red-50");
    expect(peligro).not.toContain("bg-white");
    expect(screen.getByRole("heading", { name: "T" }).className).toContain(
      "text-red-900"
    );
  });
});
