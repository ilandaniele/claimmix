/**
 * «Cartera» y «Altas» en la barra: el layout las ofrece con la regla de la guarda.
 *
 * Con sólo el mail, un usuario con dirección de operador fuera de la casa (o sin
 * verificar) veía los dos enlaces y rebotaba a la bandeja al apretarlos. El
 * layout usa `esOperadorDe`, la misma regla de `requireOperator`, con el espacio
 * de la fila de la cuenta.
 */

import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const CASA = "11111111-1111-4111-8111-111111111111";
const DE_UN_CLIENTE = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({ sesion: vi.fn(), fila: vi.fn(), casa: vi.fn() }));
const Sidebar = vi.hoisted(() => () => null);

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSessionContext: h.sesion }));
vi.mock("@/lib/auth/user-row", () => ({ getUserRowOrThrow: h.fila }));
vi.mock("@/lib/auth/fila-de-usuario-cacheada", () => ({ olvidarFilaDeUsuario: vi.fn() }));
vi.mock("@/lib/auth/require-admin", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/auth/provision", () => ({ resolveDefaultTenantId: h.casa }));
vi.mock("@/lib/i18n/locale", () => ({
  getServerLocale: async () => "es-AR",
  resolveAccountLocale: async () => "es-AR",
}));
vi.mock("@/app/(app)/_components/Sidebar", () => ({ Sidebar }));
vi.mock("@/app/(app)/_components/TopBar", () => ({ TopBar: () => null }));
vi.mock("@/app/(app)/_components/AsistenteFlotante", () => ({ AsistenteFlotante: () => null }));
vi.mock("@/app/(app)/_components/EstadoDelAgente", () => ({ EstadoDelAgente: () => null }));

import AppLayout from "../../src/app/(app)/layout";

const SAVED = { ...process.env };

const fila = (tenant_id: string, role = "owner") => ({
  id: "u-1",
  tenant_id,
  role,
  full_name: "Vera",
  locale: "es-AR",
  plan: "piloto",
  base: "lista",
  baseDesde: new Date(),
});

function buscar(nodo: ReactNode): { isOperator?: boolean } | undefined {
  if (Array.isArray(nodo)) return nodo.map(buscar).find(Boolean);
  if (!isValidElement<{ children?: ReactNode }>(nodo)) return undefined;
  if (nodo.type === Sidebar) return nodo.props as { isOperator?: boolean };
  return buscar(nodo.props.children);
}

async function operadorEnLaBarra(
  user: { email: string; emailVerified?: boolean },
  tenantId: string,
  role = "owner"
) {
  h.sesion.mockResolvedValue({ user: { id: "u-1", ...user } });
  h.fila.mockResolvedValue(fila(tenantId, role));
  return buscar(await AppLayout({ children: null }))?.isOperator;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env = { ...SAVED, ADMIN_EMAILS: "operador@example.com" };
  h.casa.mockReturnValue(CASA);
});

describe("los enlaces del operador en la barra", () => {
  it("el operador verificado del espacio de la casa los ve", async () => {
    expect(await operadorEnLaBarra({ email: "operador@example.com", emailVerified: true }, CASA)).toBe(true);
  });

  it("con su dirección pero en el espacio de un cliente no los ve: la pantalla lo rebotaría", async () => {
    expect(await operadorEnLaBarra({ email: "operador@example.com", emailVerified: true }, DE_UN_CLIENTE)).toBe(
      false
    );
  });

  it("con su dirección sin verificar tampoco", async () => {
    expect(await operadorEnLaBarra({ email: "operador@example.com", emailVerified: false }, CASA)).toBe(false);
  });

  it("con su dirección y en la casa, pero con rol de analista, no los ve: requireOperator pide admin", async () => {
    expect(
      await operadorEnLaBarra({ email: "operador@example.com", emailVerified: true }, CASA, "analyst")
    ).toBe(false);
  });

  it("un admin que no está en la lista no los ve", async () => {
    expect(await operadorEnLaBarra({ email: "admin@aseguradora.example.com", emailVerified: true }, CASA)).toBe(
      false
    );
  });

  it("si la base no respondió no hay espacio que comparar y no los ofrece", async () => {
    h.sesion.mockResolvedValue({ user: { id: "u-1", email: "operador@example.com", emailVerified: true } });
    h.fila.mockRejectedValue(new Error("timeout"));

    expect(buscar(await AppLayout({ children: null }))?.isOperator).toBe(false);
  });
});
