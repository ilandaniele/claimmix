/**
 * La barra lateral contraída a íconos en escritorio: arranca como diga la
 * cookie (que lee el layout), el botón la alterna y recuerda la elección, y
 * contraída cada ícono lleva su rótulo (`title`) y conserva su nombre accesible.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../src/app/(app)/_components/Sidebar";
import { LocaleProvider } from "../../src/lib/i18n/LocaleContext";
import { BARRA_COOKIE } from "../../src/lib/ui/barra-shared";

vi.mock("next/navigation", () => ({
  usePathname: () => "/metricas",
  useSearchParams: () => new URLSearchParams(),
}));

function montar(props: { contraida?: boolean; esPro?: boolean; locale?: "es-AR" | "en-US" } = {}) {
  const { locale = "es-AR", esPro = true, contraida } = props;
  return render(
    <LocaleProvider locale={locale}>
      <Sidebar role="owner" esPro={esPro} contraida={contraida} />
    </LocaleProvider>
  );
}

const barra = () => screen.getByRole("navigation");
const cookie = () => document.cookie.split("; ").find((c) => c.startsWith(`${BARRA_COOKIE}=`));

afterEach(() => {
  document.cookie = `${BARRA_COOKIE}=; path=/; max-age=0`;
});

describe("la barra contraída", () => {
  it("por defecto arranca expandida, sin rótulos de tooltip", () => {
    montar();

    expect(barra()).toHaveAttribute("data-contraida", "false");
    expect(screen.getByRole("link", { name: "Bandeja" })).not.toHaveAttribute("title");
  });

  it("si el layout la manda contraída, arranca contraída: sin parpadeo", () => {
    montar({ contraida: true });

    expect(barra()).toHaveAttribute("data-contraida", "true");
    expect(screen.getByRole("button", { name: "Expandir la barra lateral" })).toBeInTheDocument();
  });

  it("el botón la contrae, escribe la cookie y cambia su propio nombre", () => {
    montar();

    fireEvent.click(screen.getByRole("button", { name: "Contraer la barra lateral" }));

    expect(barra()).toHaveAttribute("data-contraida", "true");
    expect(cookie()).toBe(`${BARRA_COOKIE}=1`);
    expect(screen.getByRole("button", { name: "Expandir la barra lateral" })).toBeInTheDocument();
  });

  it("el botón la vuelve a expandir y guarda esa elección también", () => {
    montar({ contraida: true });

    fireEvent.click(screen.getByRole("button", { name: "Expandir la barra lateral" }));

    expect(barra()).toHaveAttribute("data-contraida", "false");
    expect(cookie()).toBe(`${BARRA_COOKIE}=0`);
  });

  it("contraída, cada enlace lleva el rótulo como title y sigue teniendo nombre accesible", () => {
    montar({ contraida: true });

    const enlaces = screen.getAllByRole("link");
    expect(enlaces.length).toBeGreaterThan(5);
    for (const enlace of enlaces) {
      expect(enlace.getAttribute("title")).toBeTruthy();
      expect(enlace).toHaveAccessibleName(enlace.getAttribute("title")!);
    }
    expect(screen.getByRole("link", { name: "Bandeja" })).toHaveAttribute("title", "Bandeja");
  });

  it("contraída, el ítem cerrado por el Plan Pro suma el motivo al title", () => {
    const { container } = montar({ contraida: true, esPro: false });

    expect(container.querySelector('[aria-disabled="true"]')).toHaveAttribute(
      "title",
      expect.stringContaining("Disponible con el Plan Pro")
    );
    expect(container.querySelector('[aria-disabled="true"]')).toHaveAttribute(
      "title",
      expect.stringMatching(/^Asistente/)
    );
  });

  it("expandida, el ítem cerrado conserva sólo el motivo como title", () => {
    const { container } = montar({ esPro: false });

    expect(container.querySelector('[aria-disabled="true"]')).toHaveAttribute(
      "title",
      "Disponible con el Plan Pro"
    );
  });

  it("los textos de los botones salen en inglés con el idioma de la cuenta", () => {
    montar({ locale: "en-US" });

    fireEvent.click(screen.getByRole("button", { name: "Collapse the sidebar" }));

    expect(screen.getByRole("button", { name: "Expand the sidebar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open the menu" })).toBeInTheDocument();
  });
});
