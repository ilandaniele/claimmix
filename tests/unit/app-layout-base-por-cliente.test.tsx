/**
 * El layout de `(app)` con una base por cliente: si la base del espacio no está
 * lista, manda a /preparando. Sin la bandera, el layout es el de siempre.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  fila: vi.fn(),
  redirect: vi.fn(),
  olvidar: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/bandeja",
  useSearchParams: () => new URLSearchParams(),
  redirect: h.redirect,
}));
vi.mock("@/lib/auth/session", () => ({
  getSessionContext: async () => ({ user: { id: "u-1", email: "v@example.com" } }),
}));
vi.mock("@/lib/auth/user-row", () => ({ getUserRowOrThrow: h.fila }));
vi.mock("@/lib/auth/fila-de-usuario-cacheada", () => ({ olvidarFilaDeUsuario: h.olvidar }));
vi.mock("@/lib/auth/require-operator", () => ({ isOperatorEmail: () => false }));
vi.mock("@/lib/i18n/locale", () => ({
  getServerLocale: async () => "es-AR",
  resolveAccountLocale: async () => "es-AR",
}));
vi.mock("@/app/(app)/_components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/app/(app)/_components/TopBar", () => ({ TopBar: () => null }));
vi.mock("@/app/(app)/_components/AsistenteFlotante", () => ({ AsistenteFlotante: () => null }));
vi.mock("@/app/(app)/_components/EstadoDelAgente", () => ({ EstadoDelAgente: () => null }));

import AppLayout from "../../src/app/(app)/layout";

const fila = (base: string | null) => ({
  id: "u-1",
  tenant_id: "t-1",
  role: "viewer",
  full_name: "Vera",
  locale: "es-AR",
  plan: "piloto",
  base,
  baseDesde: new Date(),
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BASE_POR_CLIENTE;
});

describe("sin la bandera", () => {
  it.each(["creando", "fallida", "borrada", null, "lista"])("la base %s no redirige", async (base) => {
    h.fila.mockResolvedValue(fila(base));

    await AppLayout({ children: null });

    expect(h.redirect).not.toHaveBeenCalled();
    expect(h.olvidar).not.toHaveBeenCalled();
  });
});

describe("con la bandera", () => {
  beforeEach(() => {
    process.env.BASE_POR_CLIENTE = "1";
  });

  it("la base lista deja entrar", async () => {
    h.fila.mockResolvedValue(fila("lista"));

    await AppLayout({ children: null });

    expect(h.redirect).not.toHaveBeenCalled();
  });

  it.each(["creando", "fallida", "borrada", null])("la base %s manda a /preparando", async (base) => {
    h.fila.mockResolvedValue(fila(base));

    await AppLayout({ children: null });

    expect(h.redirect).toHaveBeenCalledWith("/preparando");
    expect(h.redirect).toHaveBeenCalledTimes(1);
  });

  it("olvida la copia de la fila antes de redirigir: una copia vieja no rebota", async () => {
    h.fila.mockResolvedValue(fila("creando"));

    await AppLayout({ children: null });

    expect(h.olvidar).toHaveBeenCalledWith("u-1");
    expect(h.olvidar.mock.invocationCallOrder[0]).toBeLessThan(h.redirect.mock.invocationCallOrder[0]);
  });

  it("sin fila de users sigue yendo a /pendiente, no a /preparando", async () => {
    h.fila.mockResolvedValue(null);

    await AppLayout({ children: null });

    expect(h.redirect).toHaveBeenCalledWith("/pendiente");
    expect(h.redirect).not.toHaveBeenCalledWith("/preparando");
  });

  it("si la base no responde no redirige: el shell sigue con lo de siempre", async () => {
    h.fila.mockRejectedValue(new Error("timeout"));

    await AppLayout({ children: null });

    expect(h.redirect).not.toHaveBeenCalled();
  });
});
