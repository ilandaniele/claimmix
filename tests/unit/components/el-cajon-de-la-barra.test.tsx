/**
 * El cajón de la barra en el teléfono: el botón del menú lo abre, y se cierra
 * con el telón, con Escape, al tocar un enlace, al cambiar de pantalla y al
 * pasar a escritorio. Abierto, es un diálogo modal que devuelve el foco.
 *
 * jsdom no aplica la hoja de estilos: lo que acá se prueba es el estado y el
 * árbol, no cuál de los dos botones (X o flecha) se ve.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../../../src/app/(app)/_components/Sidebar";
import { LocaleProvider } from "../../../src/lib/i18n/LocaleContext";

const h = vi.hoisted(() => ({ ruta: "/metricas" }));

vi.mock("next/navigation", () => ({
  usePathname: () => h.ruta,
  useSearchParams: () => new URLSearchParams(),
}));

type Oyente = (e: MediaQueryListEvent) => void;

/** `matchMedia` de mentira que deja disparar el cambio a escritorio a mano. */
function simularMatchMedia() {
  const oyentes = new Set<Oyente>();
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false,
    addEventListener: (_: string, fn: Oyente) => oyentes.add(fn),
    removeEventListener: (_: string, fn: Oyente) => oyentes.delete(fn),
  }));
  return {
    pasarAEscritorio: () => oyentes.forEach((fn) => fn({ matches: true } as MediaQueryListEvent)),
    oyentes,
  };
}

const arbol = () => (
  <LocaleProvider locale="es-AR">
    <Sidebar role="owner" esPro />
  </LocaleProvider>
);

const botonDelMenu = () => screen.getByRole("button", { name: "Abrir el menú" });
const hayCajon = () => screen.queryByRole("dialog") !== null;

let media: ReturnType<typeof simularMatchMedia>;

beforeEach(() => {
  h.ruta = "/metricas";
  media = simularMatchMedia();
});

afterEach(() => {
  Reflect.deleteProperty(window, "matchMedia");
});

describe("el cajón de la barra", () => {
  it("cerrado no hay diálogo, y el botón del menú avisa que está colapsado", () => {
    render(arbol());

    expect(hayCajon()).toBe(false);
    expect(botonDelMenu()).toHaveAttribute("aria-expanded", "false");
    expect(botonDelMenu()).toHaveAttribute("aria-controls", "barra-principal");
  });

  it("el botón del menú lo abre: un diálogo modal con la navegación adentro", () => {
    render(arbol());

    fireEvent.click(botonDelMenu());

    const cajon = screen.getByRole("dialog", { name: "Navegación principal" });
    expect(cajon).toHaveAttribute("aria-modal", "true");
    expect(cajon.querySelector("nav#barra-principal")).not.toBeNull();
    expect(botonDelMenu()).toHaveAttribute("aria-expanded", "true");
  });

  it("hay una sola navegación en el árbol, abierto o cerrado", () => {
    render(arbol());
    expect(screen.getAllByRole("navigation")).toHaveLength(1);

    fireEvent.click(botonDelMenu());

    expect(screen.getAllByRole("navigation")).toHaveLength(1);
  });

  it("la X lo cierra", () => {
    render(arbol());
    fireEvent.click(botonDelMenu());

    fireEvent.click(screen.getByRole("button", { name: "Cerrar el menú" }));

    expect(hayCajon()).toBe(false);
  });

  it("el telón lo cierra", () => {
    const { container } = render(arbol());
    fireEvent.click(botonDelMenu());

    const telon = container.querySelector(".barra-telon");
    expect(telon).not.toBeNull();
    fireEvent.click(telon!);

    expect(hayCajon()).toBe(false);
  });

  it("Escape lo cierra", () => {
    render(arbol());
    fireEvent.click(botonDelMenu());

    fireEvent.keyDown(document, { key: "Escape" });

    expect(hayCajon()).toBe(false);
  });

  it("al abrir, el foco pasa adentro del cajón", () => {
    render(arbol());
    fireEvent.click(botonDelMenu());

    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });

  it("tocar un enlace lo cierra, aunque sea el de la pantalla en la que ya está", () => {
    render(arbol());
    fireEvent.click(botonDelMenu());

    fireEvent.click(screen.getByRole("link", { name: "Métricas" }));

    expect(hayCajon()).toBe(false);
  });

  it("tocar algo que no es un enlace no lo cierra", () => {
    render(arbol());
    fireEvent.click(botonDelMenu());

    fireEvent.click(screen.getByText("Operación"));

    expect(hayCajon()).toBe(true);
  });

  it("cambiar de pantalla lo cierra", () => {
    const { rerender } = render(arbol());
    fireEvent.click(botonDelMenu());
    expect(hayCajon()).toBe(true);

    h.ruta = "/bandeja";
    rerender(arbol());

    expect(hayCajon()).toBe(false);
  });

  it("al pasar a escritorio (girar el teléfono) se cierra", () => {
    render(arbol());
    fireEvent.click(botonDelMenu());
    expect(media.oyentes.size).toBe(1);

    act(() => media.pasarAEscritorio());

    expect(hayCajon()).toBe(false);
  });

  it("al cerrarse deja de escuchar el cambio de tamaño", () => {
    render(arbol());
    fireEvent.click(botonDelMenu());
    fireEvent.click(screen.getByRole("button", { name: "Cerrar el menú" }));

    expect(media.oyentes.size).toBe(0);
  });

  it("cerrado no toca matchMedia: en escritorio no hay trampa de foco ni oyente", () => {
    render(arbol());

    expect(window.matchMedia).not.toHaveBeenCalled();
  });
});
