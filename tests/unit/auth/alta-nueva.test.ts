/**
 * La regla del alta, en un solo lugar: en la lista y sin «Exigir SSO».
 *
 * La usan el gancho `user.create.before` de Better Auth y el alta sin
 * contraseña con su restablecimiento. Que sea una sola copia es lo que se
 * prueba acá; el gancho contra Better Auth de verdad está en
 * `registro/alta-sin-contrasena-better-auth.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ altaBloqueadaPorSso: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/server/sso/exigir", () => ({ altaBloqueadaPorSso: h.altaBloqueadaPorSso }));

import { inquilinoDeAltaNueva, rechazoDeAlta } from "@/lib/auth/alta-nueva";

const TENANT = "00000000-0000-4000-8000-0000000000aa";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("GOOGLE_DEFAULT_TENANT_ID", TENANT);
  vi.stubEnv("DEFAULT_TENANT_ID", "");
  vi.stubEnv("GMAIL_TENANT_ID", "");
  vi.stubEnv("SIGNUP_ALLOWED_EMAILS", "@example.com");
  vi.stubEnv("ADMIN_EMAILS", "");
  h.altaBloqueadaPorSso.mockResolvedValue(false);
});

describe("rechazoDeAlta", () => {
  it("una dirección de la lista, sin SSO exigido, no se rechaza", async () => {
    expect(await rechazoDeAlta("ana@example.com", TENANT)).toBeNull();
    expect(h.altaBloqueadaPorSso).toHaveBeenCalledWith("ana@example.com", TENANT);
  });

  it("una dirección fuera de la lista se rechaza sin preguntarle al SSO", async () => {
    expect(await rechazoDeAlta("ana@otra.com", TENANT)).toBe("fuera_de_signup_allowed_emails");
    expect(h.altaBloqueadaPorSso).not.toHaveBeenCalled();
  });

  it("un dominio que exige SSO se rechaza", async () => {
    h.altaBloqueadaPorSso.mockResolvedValue(true);

    expect(await rechazoDeAlta("ana@example.com", TENANT)).toBe("dominio_exige_sso");
  });

  it("sin inquilino por omisión la lista decide igual (el alta de un admin lleva el suyo)", async () => {
    expect(await rechazoDeAlta("ana@example.com", null)).toBeNull();
  });
});

describe("inquilinoDeAltaNueva", () => {
  it("devuelve el inquilino por omisión si nada rechaza el alta", async () => {
    expect(await inquilinoDeAltaNueva("ana@example.com")).toBe(TENANT);
  });

  it("devuelve null si la regla la rechaza, sea por la lista o por el SSO", async () => {
    expect(await inquilinoDeAltaNueva("ana@otra.com")).toBeNull();

    h.altaBloqueadaPorSso.mockResolvedValue(true);
    expect(await inquilinoDeAltaNueva("ana@example.com")).toBeNull();
  });

  it("devuelve null sin inquilino por omisión: no hay dónde mandar el enlace", async () => {
    vi.stubEnv("GOOGLE_DEFAULT_TENANT_ID", "");

    expect(await inquilinoDeAltaNueva("ana@example.com")).toBeNull();
  });
});
