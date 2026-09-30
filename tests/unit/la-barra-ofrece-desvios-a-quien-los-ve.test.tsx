/**
 * «Desvíos» en la barra lateral (B22).
 *
 * La página se defiende sola (`REVISION_ROLES`: el resto vuelve a la bandeja),
 * así que la barra no ofrece el enlace a quien rebotaría. Un caso por rol de la
 * aplicación, no sólo por los que hoy entran.
 */

import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Sidebar } from "../../src/app/(app)/_components/Sidebar";
import { LocaleProvider } from "../../src/lib/i18n/LocaleContext";
import { REVISION_ROLES } from "../../src/lib/auth/roles";

vi.mock("next/navigation", () => ({
  usePathname: () => "/bandeja",
  useSearchParams: () => new URLSearchParams(),
}));

function montar(role: string, locale: "es-AR" | "en-US" = "es-AR") {
  return render(
    <LocaleProvider locale={locale}>
      <Sidebar role={role} />
    </LocaleProvider>
  );
}

describe("la barra ofrece «Desvíos» sólo a quien la página deja entrar", () => {
  it.each(REVISION_ROLES)("%s ve el enlace, y va a /desvios", (role) => {
    montar(role);
    expect(screen.getByRole("link", { name: "Desvíos" })).toHaveAttribute("href", "/desvios");
  });

  it.each(["analyst", "viewer", "rol_que_no_existe"])("%s no lo ve", (role) => {
    montar(role);
    expect(screen.queryByRole("link", { name: "Desvíos" })).toBeNull();
  });

  it("sale en el idioma de la cuenta", () => {
    montar("admin", "en-US");
    expect(screen.getByRole("link", { name: "Deviations" })).toHaveAttribute("href", "/desvios");
  });

  it("vive con Métricas, en el grupo de análisis", () => {
    montar("owner");
    const enlaces = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(enlaces.indexOf("/desvios")).toBe(enlaces.indexOf("/metricas") + 1);
  });
});
