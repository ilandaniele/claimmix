/**
 * /pendiente — E20: una sesión sin perfil no hace loop, y desde el alta
 * automática va a /alta a crear su espacio. Sin pantalla propia, sin mails.
 * Salvo quien trae una invitación vigente para su propia dirección: vuelve a ella.
 */

import { beforeEach, describe, it, expect, vi } from "vitest";

const { mockGetSessionContext, mockGetUserRowOrThrow, mockCookie, mockResumen } = vi.hoisted(() => ({
  mockGetSessionContext: vi.fn(),
  mockGetUserRowOrThrow: vi.fn(),
  mockCookie: vi.fn(),
  mockResumen: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getSessionContext: mockGetSessionContext }));
vi.mock("@/lib/auth/user-row", () => ({ getUserRowOrThrow: mockGetUserRowOrThrow }));
vi.mock("@/server/alta/invitacion", async (original) => ({
  ...(await original<typeof import("@/server/alta/invitacion")>()),
  leerCookieDeInvitacion: mockCookie,
  resumenDeInvitacion: mockResumen,
}));
vi.mock("@/data/scope", () => ({ enTenant: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error("REDIRECT:" + url);
  },
}));

import PendientePage from "../../src/app/pendiente/page";
import { sellarInvitacion } from "@/server/alta/invitacion";

const enlace = (e = "lucia@example.com") =>
  sellarInvitacion({
    t: "aaaaaaaa-0000-4000-8000-00000000000a",
    e,
    r: "analyst",
    n: "Lucía Fernández",
    i: "bbbbbbbb-0000-4000-8000-00000000000b",
  });

describe("PendientePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("BETTER_AUTH_SECRET", "test-better-auth-secret-key");
    mockCookie.mockResolvedValue(undefined);
    mockResumen.mockResolvedValue({ espacio: "Seguros Ejemplo", quien: "Jefa Ejemplo", exigeSso: false });
  });

  it("sin sesión, manda a /login", async () => {
    mockGetSessionContext.mockResolvedValue(null);

    await expect(PendientePage()).rejects.toThrow("REDIRECT:/login");
  });

  it("con fila, manda a /bandeja", async () => {
    mockGetSessionContext.mockResolvedValue({ user: { id: "u-1" } });
    mockGetUserRowOrThrow.mockResolvedValue({ id: "u-1", tenant_id: "t-1", role: "analyst" });

    await expect(PendientePage()).rejects.toThrow("REDIRECT:/bandeja");
  });

  it("fila null: manda a /alta a crear el espacio", async () => {
    mockGetSessionContext.mockResolvedValue({ user: { id: "u-1", email: "lucia@example.com" } });
    mockGetUserRowOrThrow.mockResolvedValue(null);

    await expect(PendientePage()).rejects.toThrow("REDIRECT:/alta");
    expect(mockResumen).not.toHaveBeenCalled();
  });

  it("sin perfil y con la invitación vigente de su dirección, vuelve a /invitacion", async () => {
    mockGetSessionContext.mockResolvedValue({ user: { id: "u-1", email: "Lucia@Example.com" } });
    mockGetUserRowOrThrow.mockResolvedValue(null);
    mockCookie.mockResolvedValue(enlace());

    await expect(PendientePage()).rejects.toThrow("REDIRECT:/invitacion");
  });

  it("la invitación de otra dirección no la lleva a /invitacion", async () => {
    mockGetSessionContext.mockResolvedValue({ user: { id: "u-1", email: "otra@example.com" } });
    mockGetUserRowOrThrow.mockResolvedValue(null);
    mockCookie.mockResolvedValue(enlace());

    await expect(PendientePage()).rejects.toThrow("REDIRECT:/alta");
  });

  it("una invitación que ya no sirve tampoco: va a /alta", async () => {
    mockGetSessionContext.mockResolvedValue({ user: { id: "u-1", email: "lucia@example.com" } });
    mockGetUserRowOrThrow.mockResolvedValue(null);
    mockCookie.mockResolvedValue(enlace());
    mockResumen.mockResolvedValue(null);

    await expect(PendientePage()).rejects.toThrow("REDIRECT:/alta");
  });

  it("si la base no responde, no manda a crear un espacio", async () => {
    mockGetSessionContext.mockResolvedValue({ user: { id: "u-1" } });
    const falla = new Error("timeout");
    mockGetUserRowOrThrow.mockRejectedValue(falla);

    await expect(PendientePage()).rejects.toThrow("timeout");
  });
});
