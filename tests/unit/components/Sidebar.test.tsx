/**
 * G27: los `t("nav.x") || "Fallback"` de la barra lateral, sacados donde la
 * clave existe en los dos diccionarios con el mismo texto que el fallback en
 * es-AR. Los rótulos tienen que verse igual que hoy en los dos idiomas.
 *
 * G28: el ítem activo lleva `aria-current="page"`, y sólo ese.
 */

import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Sidebar } from "../../../src/app/(app)/_components/Sidebar";
import { LocaleProvider } from "../../../src/lib/i18n/LocaleContext";

vi.mock("next/navigation", () => ({
  usePathname: () => "/metricas",
  useSearchParams: () => new URLSearchParams(),
}));

function montar(locale: "es-AR" | "en-US") {
  return render(
    <LocaleProvider locale={locale}>
      <Sidebar role="owner" isOperator esPro />
    </LocaleProvider>
  );
}

describe("Sidebar — rótulos", () => {
  it("es-AR: los rótulos son los de hoy", () => {
    montar("es-AR");
    expect(screen.getByText("Bandeja")).toBeInTheDocument();
    expect(screen.getByText("Escalados")).toBeInTheDocument();
    expect(screen.getByText("Clientes")).toBeInTheDocument();
    expect(screen.getByText("Métricas")).toBeInTheDocument();
    expect(screen.getByText("Configuración")).toBeInTheDocument();
    // "nav.admin" en es-AR es "Administración", no el fallback "Usuarios"
    // que quedó en el código: el fallback nunca actuó.
    expect(screen.getByText("Administración")).toBeInTheDocument();
    expect(screen.queryByText("Usuarios")).not.toBeInTheDocument();
  });

  it("en-US: los rótulos son los de hoy", () => {
    montar("en-US");
    expect(screen.getByText("Inbox")).toBeInTheDocument();
    expect(screen.getByText("Escalated")).toBeInTheDocument();
    expect(screen.getByText("Clients")).toBeInTheDocument();
    expect(screen.getByText("Metrics")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(screen.getByText("Administration")).toBeInTheDocument();
  });
});

describe("Sidebar — aria-current", () => {
  it("sólo el ítem activo lleva aria-current=\"page\"", () => {
    montar("es-AR");
    const activos = screen.getAllByRole("link").filter(
      (link) => link.getAttribute("aria-current") === "page"
    );
    expect(activos).toHaveLength(1);
    expect(activos[0]).toHaveTextContent("Métricas");
  });
});

describe("Sidebar — estado del agente (G37)", () => {
  it("dibuja el slot que le pasa el layout, al pie", () => {
    render(
      <LocaleProvider locale="es-AR">
        <Sidebar role="owner" estadoDelAgente={<span>Agente activo</span>} />
      </LocaleProvider>
    );
    expect(screen.getByText("Agente activo")).toBeInTheDocument();
  });

  it("sin la prop, no dibuja nada al pie", () => {
    montar("es-AR");
    expect(screen.queryByText("Agente activo")).not.toBeInTheDocument();
  });
});
