/**
 * Los márgenes de la zona segura del iPhone valen en todos los anchos.
 *
 * El layout declara `viewportFit: "cover"` para todo el panel, así que la página
 * llega hasta los bordes del teléfono. Un teléfono apaisado mide 844 px o más,
 * entra en el layout de escritorio, y ahí la muesca y el indicador de inicio
 * siguen valiendo unos 47 a 59 px a los costados y unos 21 px abajo: con el
 * relleno sólo debajo de `md`, la barra lateral y la paginación quedaban tapadas.
 */

import { isValidElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  getSessionContext: async () => ({ user: { id: "u-1", email: "v@ejemplo.com" } }),
}));
vi.mock("@/lib/auth/user-row", () => ({
  getUserRowOrThrow: async () => ({
    id: "u-1",
    tenant_id: "t-1",
    role: "viewer",
    full_name: "Vera",
    locale: "es-AR",
    plan: "piloto",
  }),
}));
vi.mock("@/lib/auth/require-operator", () => ({ esOperadorDe: () => false }));
vi.mock("@/lib/i18n/locale", () => ({
  getServerLocale: async () => "es-AR",
  resolveAccountLocale: async () => "es-AR",
}));
vi.mock("@/app/(app)/_components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/app/(app)/_components/TopBar", () => ({ TopBar: () => null }));
vi.mock("@/lib/ui/barra", () => ({ leerBarraContraida: async () => false }));
vi.mock("@/app/(app)/_components/AsistenteFlotante", () => ({ AsistenteFlotante: () => null }));
vi.mock("@/app/(app)/_components/EstadoDelAgente", () => ({ EstadoDelAgente: () => null }));

import AppLayout from "../../src/app/(app)/layout";

function claseDelLienzo(nodo: ReactNode): string | undefined {
  if (Array.isArray(nodo)) return nodo.map(claseDelLienzo).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; className?: string }>(nodo)) return undefined;
  if (nodo.props.className?.split(" ").includes("lienzo")) return nodo.props.className;
  return claseDelLienzo(nodo.props.children);
}

function claseDelSalto(nodo: ReactNode): string | undefined {
  if (Array.isArray(nodo)) return nodo.map(claseDelSalto).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; className?: string; href?: string }>(nodo)) return undefined;
  if (nodo.props.href === "#contenido") return nodo.props.className;
  return claseDelSalto(nodo.props.children);
}

describe("el lienzo del layout", () => {
  it("rellena con los cuatro márgenes de zona segura, sin condicionarlos al ancho", async () => {
    const clase = claseDelLienzo(await AppLayout({ children: null }));

    expect(clase).toBeDefined();
    const relleno = clase!.split(" ").filter((c) => /(^|:)p-\[/.test(c));
    expect(relleno).toEqual([
      "p-[env(safe-area-inset-top)_env(safe-area-inset-right)_env(safe-area-inset-bottom)_env(safe-area-inset-left)]",
    ]);
  });
});

describe("el enlace de salto al contenido", () => {
  it("es `fixed`, así que se pega a la zona segura y se esconde pasando también por ella", async () => {
    const clase = claseDelSalto(await AppLayout({ children: null }))?.split(" ");

    expect(clase).toContain("fixed");
    expect(clase).toContain("top-[max(0.75rem,env(safe-area-inset-top))]");
    expect(clase).toContain("left-[max(0.75rem,env(safe-area-inset-left))]");
    expect(clase).toContain("-translate-y-[calc(200%+env(safe-area-inset-top))]");
    expect(clase).toContain("focus:translate-y-0");
  });
});
