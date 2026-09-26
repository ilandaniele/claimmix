/**
 * «Mi cola» en la barra lateral.
 *
 * Va primero, antes de «Bandeja»: es el filtro con el que arranca el día
 * cualquier analista, y no depende del Plan Pro ni del rol.
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

describe("la barra lleva a «Mi cola»", () => {
  it.each(ALL_ROLES)("%s ve «Mi cola» antes de «Bandeja»", (role) => {
    montar(role);
    const enlace = screen.getByRole("link", { name: "Mi cola" });
    expect(enlace).toHaveAttribute("href", "/bandeja?cola=mia");

    const enlaces = screen.getAllByRole("link");
    const bandeja = enlaces.indexOf(screen.getByRole("link", { name: "Bandeja" }));
    expect(enlaces.indexOf(enlace)).toBe(bandeja - 1);
  });
});
