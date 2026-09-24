/**
 * «No relevantes» en la barra lateral.
 *
 * La bandeja ya sabía filtrar `is_claim=false`, pero para llegar había que
 * abrir el panel de filtros. El enlace va debajo de «Escalados» y lo ve
 * cualquier rol: no muestra nada que la bandeja no le muestre ya.
 */

import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Sidebar } from "../../src/app/(app)/_components/Sidebar";
import { LocaleProvider } from "../../src/lib/i18n/LocaleContext";
import { ALL_ROLES } from "../../src/lib/auth/roles";

vi.mock("next/navigation", () => ({
  usePathname: () => "/bandeja",
  useSearchParams: () => new URLSearchParams(),
}));

function montar(role: string) {
  return render(
    <LocaleProvider locale="es-AR">
      <Sidebar role={role} />
    </LocaleProvider>
  );
}

describe("la barra lleva a los no relevantes", () => {
  it.each(ALL_ROLES)("%s ve «No relevantes» justo debajo de «Escalados»", (role) => {
    montar(role);
    const enlace = screen.getByRole("link", { name: "No relevantes" });
    expect(enlace).toHaveAttribute("href", "/bandeja?is_claim=false");

    const enlaces = screen.getAllByRole("link");
    const escalados = enlaces.indexOf(screen.getByRole("link", { name: "Escalados" }));
    expect(enlaces.indexOf(enlace)).toBe(escalados + 1);
  });
});
