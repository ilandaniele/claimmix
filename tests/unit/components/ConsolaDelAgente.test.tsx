/**
 * La consola del agente: siete botones que decían ser pestañas sin serlo.
 *
 * No había `role="tablist"`, ni `role="tab"`, ni `aria-selected`, ni
 * `role="tabpanel"`, ni flechas: los siete estaban en el orden de tabulación,
 * que es como se comporta un grupo de botones sueltos. Un lector de pantalla
 * anunciaba siete botones y el cambio de panel no se anunciaba en absoluto — la
 * persona apretaba uno y, por lo que oía, no pasaba nada.
 *
 * `FilterTabs` de la bandeja ya tenía el patrón entero y su propio test. Este
 * archivo es el mismo contrato para la otra pantalla, y de paso fija que las
 * teclas compartidas se comporten igual en las dos.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { vi, describe, it, expect } from "vitest";

import { AgentConsoleClient } from "../../../src/app/(app)/agente/AgentConsoleClient";
import { LocaleProvider } from "../../../src/lib/i18n/LocaleContext";

/*
 * Los siete paneles se reemplazan por marcadores.
 *
 * Cada uno hace `fetch` al montarse y trae medio grafo del cliente; lo que se
 * prueba acá es la barra, no lo que hay adentro de cada solapa.
 */
const { panel } = vi.hoisted(() => ({
  panel: (nombre: string) => ({ [nombre]: () => <div>{nombre}</div> }),
}));

vi.mock("../../../src/app/(app)/configuracion/AiProviderPanel", () => panel("AiProviderPanel"));
vi.mock("../../../src/app/(app)/configuracion/PromptRulesPanel", () => panel("PromptRulesPanel"));
vi.mock("../../../src/app/(app)/agente/CustomFieldsPanel", () => panel("CustomFieldsPanel"));
vi.mock("../../../src/app/(app)/agente/TrainingExamplesPanel", () => panel("TrainingExamplesPanel"));
vi.mock("../../../src/app/(app)/agente/FineTuneJobsPanel", () => panel("FineTuneJobsPanel"));
vi.mock("../../../src/app/(app)/agente/AgentExportPanel", () => panel("AgentExportPanel"));
vi.mock("../../../src/app/(app)/agente/ProviderUsagePanel", () => panel("ProviderUsagePanel"));
vi.mock("../../../src/app/(app)/agente/BatchSimulatePanel", () => panel("BatchSimulatePanel"));

function montar() {
  return render(
    <LocaleProvider locale="es-AR">
      <AgentConsoleClient role="owner" />
    </LocaleProvider>
  );
}

describe("la consola del agente es un tablist", () => {
  it("las siete son pestañas, no botones sueltos", () => {
    montar();

    expect(screen.getByRole("tablist")).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(7);
  });

  it("hay exactamente una seleccionada", () => {
    montar();

    const elegidas = screen
      .getAllByRole("tab")
      .filter((b) => b.getAttribute("aria-selected") === "true");
    expect(elegidas).toHaveLength(1);
  });

  it("sólo la activa entra al orden de tabulación", () => {
    // Es lo que distingue un tablist de siete botones: un Tab lleva al grupo
    // entero, no a cada pestaña de a una.
    montar();

    const enElOrden = screen
      .getAllByRole("tab")
      .filter((b) => b.getAttribute("tabindex") !== "-1");
    expect(enElOrden).toHaveLength(1);
  });

  it("el panel se anuncia, y dice de qué pestaña es", () => {
    montar();

    const panel = screen.getByRole("tabpanel");
    const activa = screen
      .getAllByRole("tab")
      .find((b) => b.getAttribute("aria-selected") === "true")!;

    expect(panel.getAttribute("aria-labelledby")).toBe(activa.id);
    expect(activa.getAttribute("aria-controls")).toBe(panel.id);
  });

  it("la flecha derecha mueve a la siguiente", () => {
    // La promesa que no se cumplía: un lector anuncia «pestaña 1 de 7», la
    // persona aprieta la flecha y antes no pasaba nada.
    montar();

    const antes = screen.getAllByRole("tab");
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });

    const despues = screen.getAllByRole("tab");
    expect(despues[1]!.getAttribute("aria-selected")).toBe("true");
    expect(antes[0]!.getAttribute("aria-selected")).toBe("false");
  });

  it("la flecha izquierda desde la primera da la vuelta a la última", () => {
    montar();

    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowLeft" });

    const pestanas = screen.getAllByRole("tab");
    expect(pestanas[6]!.getAttribute("aria-selected")).toBe("true");
  });

  it("Inicio y Fin van a los extremos", () => {
    montar();
    const lista = screen.getByRole("tablist");

    fireEvent.keyDown(lista, { key: "End" });
    expect(screen.getAllByRole("tab")[6]!.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(lista, { key: "Home" });
    expect(screen.getAllByRole("tab")[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("una tecla cualquiera no mueve nada", () => {
    montar();

    fireEvent.keyDown(screen.getByRole("tablist"), { key: "a" });

    expect(screen.getAllByRole("tab")[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("el clic sigue cambiando de panel", () => {
    montar();

    fireEvent.click(screen.getAllByRole("tab")[6]!);

    expect(screen.getByText("BatchSimulatePanel")).toBeTruthy();
  });
});
