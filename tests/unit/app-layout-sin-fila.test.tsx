/**
 * E20: una sesión sin fila de `users` manda a /pendiente, no a /login+bucle.
 *
 * Antes: /bandeja redirigía a /login, el proxy veía SOLO_ANONIMOS y devolvía
 * a /bandeja. El layout ahora corta el loop en un solo lugar.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetUserRowOrThrow, mockRedirect } = vi.hoisted(() => ({
  mockGetUserRowOrThrow: vi.fn(),
  mockRedirect: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/bandeja",
  useSearchParams: () => new URLSearchParams(),
  redirect: mockRedirect,
}));
vi.mock("@/lib/auth/session", () => ({
  getSessionContext: async () => ({ user: { id: "u-1", email: "v@ejemplo.com" } }),
}));
vi.mock("@/lib/auth/user-row", () => ({ getUserRowOrThrow: mockGetUserRowOrThrow }));
vi.mock("@/lib/auth/require-operator", () => ({ esOperadorDe: () => false }));
vi.mock("@/lib/i18n/locale", () => ({
  getServerLocale: async () => "es-AR",
  resolveAccountLocale: async (accountLocale?: string | null) =>
    accountLocale === "es-AR" || accountLocale === "en-US" ? accountLocale : "es-AR",
}));
vi.mock("@/app/(app)/_components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/app/(app)/_components/TopBar", () => ({ TopBar: () => null }));
vi.mock("@/app/(app)/_components/AsistenteFlotante", () => ({ AsistenteFlotante: () => null }));
vi.mock("@/app/(app)/_components/EstadoDelAgente", () => ({ EstadoDelAgente: () => null }));

import AppLayout from "../../src/app/(app)/layout";

describe("el layout ante una sesión sin fila de users", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockGetUserRowOrThrow.mockReset();
  });

  it("fila null: manda a /pendiente", async () => {
    mockGetUserRowOrThrow.mockResolvedValue(null);

    await AppLayout({ children: null });

    expect(mockRedirect).toHaveBeenCalledWith("/pendiente");
  });

  it("con fila: no redirige", async () => {
    mockGetUserRowOrThrow.mockResolvedValue({
      id: "u-1",
      tenant_id: "t-1",
      role: "viewer",
      full_name: "Vera",
      locale: "es-AR",
      plan: "piloto",
    });

    await AppLayout({ children: null });

    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("la base no responde: no redirige y el shell sigue con lo de siempre", async () => {
    mockGetUserRowOrThrow.mockRejectedValue(new Error("timeout"));

    const arbol = await AppLayout({ children: "hola" });

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(arbol).toBeTruthy();
  });
});
