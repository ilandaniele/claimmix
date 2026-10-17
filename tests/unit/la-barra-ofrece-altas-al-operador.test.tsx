/**
 * «Altas» en la barra lateral.
 *
 * Sólo la ve quien opera ClaimMix, con la misma condición que «Cartera»: un
 * admin o dueño de un cliente no la ve, por mucho que su rol alcance para
 * `/admin/users`. La guarda de verdad es `requireOperator` en la página; la
 * barra sólo evita ofrecer un enlace que rebotaría.
 */

import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Sidebar } from "../../src/app/(app)/_components/Sidebar";
import { LocaleProvider } from "../../src/lib/i18n/LocaleContext";

vi.mock("next/navigation", () => ({
  usePathname: () => "/bandeja",
  useSearchParams: () => new URLSearchParams(),
}));

function montar(role: string, isOperator: boolean, locale: "es-AR" | "en-US" = "es-AR") {
  return render(
    <LocaleProvider locale={locale}>
      <Sidebar role={role} isOperator={isOperator} />
    </LocaleProvider>
  );
}

function enlaces() {
  return screen.getAllByRole("link").map((a) => a.getAttribute("href"));
}

describe("la barra ofrece «Altas» sólo al operador", () => {
  it("el operador la ve, y va a /admin/altas", () => {
    montar("owner", true);
    expect(screen.getByRole("link", { name: "Altas" })).toHaveAttribute("href", "/admin/altas");
  });

  it.each(["admin", "owner"])("un %s de un cliente no la ve", (role) => {
    montar(role, false);
    expect(screen.queryByRole("link", { name: "Altas" })).toBeNull();
    expect(enlaces()).not.toContain("/admin/altas");
  });

  it("sale en el idioma de la cuenta", () => {
    montar("owner", true, "en-US");
    expect(screen.getByRole("link", { name: "Sign-ups" })).toHaveAttribute("href", "/admin/altas");
  });

  it("va justo después de la cartera", () => {
    montar("owner", true);
    const hrefs = enlaces();
    expect(hrefs.indexOf("/admin/altas")).toBe(hrefs.indexOf("/admin/cartera") + 1);
  });
});
