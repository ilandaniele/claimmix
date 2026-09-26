/**
 * El botón de ayuda de la barra superior: abre el diálogo con los 5 pasos,
 * Escape lo cierra y el foco vuelve al botón.
 */
import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect } from "vitest";
import { Ayuda } from "../../../src/app/(app)/_components/Ayuda";

describe("Ayuda", () => {
  it("el botón abre un diálogo con los 5 pasos", async () => {
    const user = userEvent.setup();
    render(<Ayuda />);
    await user.click(screen.getByRole("button", { name: "Ayuda: cómo se usa" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByText(/^\d\./)).toHaveLength(5);
  });

  it("Escape cierra el diálogo y el foco vuelve al botón", async () => {
    const user = userEvent.setup();
    render(<Ayuda />);
    const boton = screen.getByRole("button", { name: "Ayuda: cómo se usa" });
    await user.click(boton);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(boton);
  });
});
