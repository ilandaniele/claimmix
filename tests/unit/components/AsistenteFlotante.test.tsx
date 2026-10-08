/**
 * AsistenteFlotante — botón flotante y su panel (spec A). `CajaDelAsistente`
 * va mockeada: acá se prueba el flotante (visibilidad por ruta, abrir/cerrar,
 * foco, Escape, panel no modal, persistencia entre cierres, minimizar a la
 * pestaña), no el contenido de la caja — eso lo prueba `CajaDelAsistente.test.tsx`.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { useEffect, type RefObject } from "react";
import { AsistenteFlotante } from "../../../src/app/(app)/_components/AsistenteFlotante";

let pathname = "/bandeja";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

let montajes = 0;
vi.mock("@/app/(app)/asistente/_components/CajaDelAsistente", () => ({
  // Un textarea de verdad que NO se enfoca sola, como la real: el foco es
  // contrato del panel flotante. `montajes` cuenta MONTAJES, no renders: si el
  // panel reabre sin desmontar la caja (spec de persistencia del historial),
  // este contador no se mueve.
  CajaDelAsistente: ({ textareaRef }: { textareaRef?: RefObject<HTMLTextAreaElement | null> }) => {
    useEffect(() => {
      montajes++;
    }, []);
    return <textarea data-testid="caja-mock" ref={textareaRef} />;
  },
}));

describe("AsistenteFlotante", () => {
  beforeEach(() => {
    montajes = 0;
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("en /asistente no se muestra: la caja entera ya está en pantalla", () => {
    pathname = "/asistente";
    render(<AsistenteFlotante />);
    expect(screen.queryByRole("button", { name: "Preguntale al asistente" })).toBeNull();
  });

  it("en cualquier otra pantalla, el botón flotante se muestra", () => {
    pathname = "/bandeja";
    render(<AsistenteFlotante />);
    expect(screen.getByRole("button", { name: "Preguntale al asistente" })).toBeInTheDocument();
  });

  it("el botón abre el panel con la caja adentro, sin aria-modal: no es un diálogo modal", async () => {
    pathname = "/bandeja";
    const user = userEvent.setup();
    render(<AsistenteFlotante />);

    await user.click(screen.getByRole("button", { name: "Preguntale al asistente" }));

    const panel = screen.getByRole("dialog");
    expect(panel).not.toHaveAttribute("aria-modal");
    await waitFor(() => expect(screen.getByTestId("caja-mock")).toBeInTheDocument());
  });

  it("al abrir, el foco llega al textarea", async () => {
    pathname = "/bandeja";
    const user = userEvent.setup();
    render(<AsistenteFlotante />);

    await user.click(screen.getByRole("button", { name: "Preguntale al asistente" }));

    // Un frame después (ver el efecto del panel): no es sincrónico.
    const textarea = screen.getByRole("textbox");
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it("Escape cierra el panel y el foco vuelve al botón", async () => {
    pathname = "/bandeja";
    const user = userEvent.setup();
    render(<AsistenteFlotante />);

    const boton = screen.getByRole("button", { name: "Preguntale al asistente" });
    await user.click(boton);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(boton);
  });

  it("el botón de cerrar del panel también cierra, y devuelve el foco al lanzador", async () => {
    pathname = "/bandeja";
    const user = userEvent.setup();
    render(<AsistenteFlotante />);

    const boton = screen.getByRole("button", { name: "Preguntale al asistente" });
    await user.click(boton);
    await user.click(screen.getByRole("button", { name: "Cerrar asistente" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(boton);
    // Ningún foco diferido de la apertura le gana al cierre un frame después.
    await new Promise((r) => requestAnimationFrame(r));
    expect(document.activeElement).toBe(boton);
  });

  it("no atrapa Tab: no hay listener que le gane a Tab dentro del panel", async () => {
    pathname = "/bandeja";
    const user = userEvent.setup();
    render(<AsistenteFlotante />);

    await user.click(screen.getByRole("button", { name: "Preguntale al asistente" }));
    await screen.findByTestId("caja-mock");

    // Único enfocable adentro del panel además del botón de cerrar: si hubiera
    // trampa de Tab, un Tab de más volvería al botón de cerrar en vez de salir
    // del panel.
    const textarea = screen.getByTestId("caja-mock");
    textarea.focus();
    await user.tab();
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Cerrar asistente" }));
  });

  it("cerrar y reabrir no desmonta la caja: el historial de sesión sobrevive", async () => {
    pathname = "/bandeja";
    const user = userEvent.setup();
    render(<AsistenteFlotante />);

    const boton = screen.getByRole("button", { name: "Preguntale al asistente" });
    await user.click(boton);
    await screen.findByTestId("caja-mock");
    expect(montajes).toBe(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    // Oculto, no desmontado: sigue en el DOM.
    expect(screen.getByTestId("caja-mock")).toBeInTheDocument();

    await user.click(boton);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(montajes).toBe(1);
  });

  it("el panel oculto no es alcanzable por teclado ni lectores de pantalla", async () => {
    pathname = "/bandeja";
    const user = userEvent.setup();
    render(<AsistenteFlotante />);

    const boton = screen.getByRole("button", { name: "Preguntale al asistente" });
    await user.click(boton);
    fireEvent.keyDown(document, { key: "Escape" });

    const panel = document.getElementById("asistente-flotante-panel");
    expect(panel).toHaveAttribute("hidden");
    expect(panel).toHaveAttribute("inert");
  });

  it("reabrir el panel vuelve a enfocar el textarea, no sólo la primera vez", async () => {
    pathname = "/bandeja";
    const user = userEvent.setup();
    render(<AsistenteFlotante />);

    const boton = screen.getByRole("button", { name: "Preguntale al asistente" });
    await user.click(boton);
    const textarea = screen.getByRole("textbox");
    await waitFor(() => expect(document.activeElement).toBe(textarea));

    fireEvent.keyDown(document, { key: "Escape" });
    textarea.blur();

    await user.click(boton);
    await waitFor(() => expect(document.activeElement).toBe(textarea));
  });

  it("minimizar oculta la píldora, deja la pestaña y lo guarda en localStorage", async () => {
    pathname = "/bandeja";
    const user = userEvent.setup();
    render(<AsistenteFlotante />);

    await user.click(screen.getByRole("button", { name: "Ocultar el botón del asistente" }));

    expect(screen.queryByRole("button", { name: "Preguntale al asistente" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Ocultar el botón del asistente" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mostrar el asistente" })).toBeInTheDocument();
    expect(window.localStorage.getItem("claimmix:asistente-minimizado")).toBe("true");
  });

  it("al minimizar, el foco va a la pestaña", async () => {
    pathname = "/bandeja";
    const user = userEvent.setup();
    render(<AsistenteFlotante />);

    await user.click(screen.getByRole("button", { name: "Ocultar el botón del asistente" }));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Mostrar el asistente" }));
  });

  it("la pestaña restaura la píldora, abre el panel y borra la elección guardada", async () => {
    pathname = "/bandeja";
    const user = userEvent.setup();
    render(<AsistenteFlotante />);

    await user.click(screen.getByRole("button", { name: "Ocultar el botón del asistente" }));
    await user.click(screen.getByRole("button", { name: "Mostrar el asistente" }));

    expect(screen.getByRole("button", { name: "Preguntale al asistente" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mostrar el asistente" })).toBeNull();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(window.localStorage.getItem("claimmix:asistente-minimizado")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox")));
  });

  it("si ya venía minimizado, arranca en la pestaña y no le roba el foco a nadie", async () => {
    pathname = "/bandeja";
    window.localStorage.setItem("claimmix:asistente-minimizado", "true");
    render(<AsistenteFlotante />);

    const pestana = await screen.findByRole("button", { name: "Mostrar el asistente" });
    expect(screen.queryByRole("button", { name: "Preguntale al asistente" })).toBeNull();
    expect(document.activeElement).not.toBe(pestana);
  });

  it("minimizar con el panel abierto lo cierra, pero la caja sigue montada", async () => {
    pathname = "/bandeja";
    const user = userEvent.setup();
    render(<AsistenteFlotante />);

    await user.click(screen.getByRole("button", { name: "Preguntale al asistente" }));
    await screen.findByTestId("caja-mock");
    await user.click(screen.getByRole("button", { name: "Ocultar el botón del asistente" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("caja-mock")).toBeInTheDocument();
    expect(montajes).toBe(1);
  });
});
