/**
 * «Administración» y «Facturación» en la barra lateral.
 *
 * `admin/users/page.tsx` y `admin/facturacion/page.tsx` ya se defienden solas
 * con `requireAdmin`: quien no es admin/owner no ve un 403, vuelve en silencio
 * a `/bandeja`. La barra lateral mostraba los dos enlaces a cualquier rol —un
 * analista los apretaba y caía de nuevo en la bandeja sin que nada le avisara
 * que no le correspondían.
 */

import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Sidebar } from "../../src/app/(app)/_components/Sidebar";
import { LocaleProvider } from "../../src/lib/i18n/LocaleContext";

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

describe("la barra no ofrece lo que rebota", () => {
  it("un analista no ve Administración ni Facturación", () => {
    montar("analyst");
    expect(screen.queryByRole("link", { name: "Administración" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Facturación" })).toBeNull();
  });

  it("un admin sí ve Administración y Facturación", () => {
    montar("admin");
    expect(screen.getByRole("link", { name: "Administración" })).toHaveAttribute(
      "href",
      "/admin/users"
    );
    expect(screen.getByRole("link", { name: "Facturación" })).toHaveAttribute(
      "href",
      "/admin/facturacion"
    );
  });
});
