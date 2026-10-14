/**
 * La tarjeta de antes del panel: «Cerrar sesión» es un POST de documento a
 * /api/auth/salir. Con una Server Action, `redirect("/login")` era un salto del cliente
 * y /login heredaba el CSP y el SDK de Meta de /conectar-whatsapp (F21).
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Tarjeta } from "@/app/alta/Tarjeta";

describe("Tarjeta", () => {
  it("«Cerrar sesión» envía un formulario POST a /api/auth/salir, sin Server Action", () => {
    render(
      <Tarjeta titulo="Título" locale="es-AR" etiquetaSalir="Cerrar sesión">
        <p>contenido</p>
      </Tarjeta>
    );

    const form = screen.getByRole("button", { name: "Cerrar sesión" }).closest("form")!;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe("/api/auth/salir");
    expect(screen.getByText("contenido")).toBeTruthy();
  });
});
