/**
 * Lo del Plan Pro en la barra lateral: con candado y la etiqueta «Plan Pro»
 * para quien no lo tiene. `nav.asistente` (P9) es el único ítem Pro de hoy.
 */

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Lock } from "lucide-react";
import {
  Sidebar,
  NavLink,
  conCandadoPro,
  type NavItemDef,
} from "../../src/app/(app)/_components/Sidebar";
import { LocaleProvider } from "../../src/lib/i18n/LocaleContext";
import { getT } from "../../src/lib/i18n";

const { mockGetUserRow } = vi.hoisted(() => ({ mockGetUserRow: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/bandeja",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/auth/session", () => ({
  getSessionContext: async () => ({ user: { id: "u-1", email: "v@ejemplo.com" } }),
}));
vi.mock("@/lib/auth/user-row", () => ({ getUserRow: mockGetUserRow }));
vi.mock("@/lib/auth/require-operator", () => ({ isOperatorEmail: () => false }));
vi.mock("@/lib/i18n/locale", () => ({ getServerLocale: async () => "es-AR" }));
vi.mock("@/app/(app)/_components/TopBar", () => ({ TopBar: () => null }));

import AppLayout from "../../src/app/(app)/layout";

const t = getT("es-AR");
const PRO: NavItemDef = { label: "X", href: "/x", icon: Lock, pro: true };
const COMUN: NavItemDef = { label: "Y", href: "/y", icon: Lock };

describe("conCandadoPro", () => {
  it("sin Plan Pro, el ítem Pro va deshabilitado con la etiqueta", () => {
    const [pro, comun] = conCandadoPro([PRO, COMUN], false, t);
    expect(pro).toMatchObject({
      disabled: true,
      insignia: "Plan Pro",
      disabledReason: "Disponible en el Plan Pro",
    });
    expect(comun).toBe(COMUN);
  });

  it("con Plan Pro, el ítem queda como estaba", () => {
    expect(conCandadoPro([PRO], true, t)[0]).toBe(PRO);
  });
});

describe("NavLink con candado Pro", () => {
  it("muestra «Plan Pro» y no es un enlace", () => {
    const [item] = conCandadoPro([PRO], false, t);
    const { container } = render(<NavLink {...item} active={false} />);
    expect(screen.getByText("Plan Pro")).toBeInTheDocument();
    expect(container.querySelector('[aria-disabled="true"]')).toHaveAttribute(
      "title",
      "Disponible en el Plan Pro"
    );
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("la barra de hoy", () => {
  it("sin Plan Pro cierra sólo el ítem del asistente a un admin", () => {
    const { container } = render(
      <LocaleProvider locale="es-AR">
        <Sidebar role="admin" esPro={false} />
      </LocaleProvider>
    );
    const cerrados = container.querySelectorAll('[aria-disabled="true"]');
    expect(cerrados).toHaveLength(1);
    expect(screen.getByText("Plan Pro")).toBeInTheDocument();
  });

  it("con Plan Pro no cierra nada", () => {
    const { container } = render(
      <LocaleProvider locale="es-AR">
        <Sidebar role="admin" esPro={true} />
      </LocaleProvider>
    );
    expect(container.querySelectorAll('[aria-disabled="true"]')).toHaveLength(0);
    expect(screen.queryByText("Plan Pro")).toBeNull();
  });
});

/** El elemento `<Sidebar>` del árbol que arma el layout, sin renderizarlo. */
function buscarBarra(nodo: ReactNode): ReactElement<Record<string, unknown>> | null {
  if (Array.isArray(nodo)) {
    for (const hijo of nodo) {
      const hallado = buscarBarra(hijo);
      if (hallado) return hallado;
    }
    return null;
  }
  if (!isValidElement<Record<string, unknown>>(nodo)) return null;
  if (nodo.type === Sidebar) return nodo;
  return buscarBarra(nodo.props.children as ReactNode);
}

describe("el layout y el plan", () => {
  // La barra corre en el navegador de cualquier rol; el nombre del plan es
  // dato de admin.
  it.each([
    ["piloto", false],
    ["profesional", true],
  ])("con %s a la barra le llega sólo esPro=%s", async (plan, esPro) => {
    mockGetUserRow.mockResolvedValue({
      id: "u-1",
      tenant_id: "t-1",
      role: "viewer",
      full_name: "Vera",
      locale: "es-AR",
      plan,
    });

    const barra = buscarBarra(await AppLayout({ children: null }));

    expect(barra?.props.esPro).toBe(esPro);
    expect(Object.values(barra?.props ?? {})).not.toContain(plan);
  });
});
