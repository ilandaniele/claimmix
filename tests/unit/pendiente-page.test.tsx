/**
 * /pendiente — E20: «tu cuenta está creada, pedile acceso a un administrador».
 * Sin loop, sin mails.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { mockGetSessionContext, mockGetUserRowOrThrow, mockSignOut } = vi.hoisted(() => ({
  mockGetSessionContext: vi.fn(),
  mockGetUserRowOrThrow: vi.fn(),
  mockSignOut: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSessionContext: mockGetSessionContext }));
vi.mock("@/lib/auth/user-row", () => ({ getUserRowOrThrow: mockGetUserRowOrThrow }));
vi.mock("@/app/login/actions", () => ({ signOut: mockSignOut }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));

import PendientePage from "../../src/app/pendiente/page";

describe("PendientePage", () => {
  it("sin sesión, manda a /login", async () => {
    mockGetSessionContext.mockResolvedValue(null);

    await expect(PendientePage()).rejects.toThrow("REDIRECT:/login");
  });

  it("con fila, manda a /bandeja", async () => {
    mockGetSessionContext.mockResolvedValue({ user: { id: "u-1" } });
    mockGetUserRowOrThrow.mockResolvedValue({ id: "u-1", tenant_id: "t-1", role: "analyst" });

    await expect(PendientePage()).rejects.toThrow("REDIRECT:/bandeja");
  });

  it("fila null: muestra el aviso y Cerrar sesión", async () => {
    mockGetSessionContext.mockResolvedValue({ user: { id: "u-1" } });
    mockGetUserRowOrThrow.mockResolvedValue(null);

    render(await PendientePage());

    expect(
      screen.getByText("Tu cuenta está creada; un administrador tiene que darte acceso.")
    ).toBeInTheDocument();
    const boton = screen.getByRole("button", { name: "Cerrar sesión" });
    expect(boton.closest("form")).toBeInTheDocument();
  });

  it("si la base no responde, no se etiqueta como pendiente", async () => {
    mockGetSessionContext.mockResolvedValue({ user: { id: "u-1" } });
    const falla = new Error("timeout");
    mockGetUserRowOrThrow.mockRejectedValue(falla);

    await expect(PendientePage()).rejects.toThrow("timeout");
    expect(screen.queryByText(/Cuenta pendiente/)).toBeNull();
  });
});
