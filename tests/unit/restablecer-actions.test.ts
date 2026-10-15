/**
 * `restablecer`: la acción de /restablecer, donde se pone la contraseña nueva.
 *
 * Lo que se prueba:
 *   - que una clave de más de 128 caracteres vuelve como error del campo, en el
 *     idioma del dispositivo, sin llamar a Better Auth: antes pasaba el esquema
 *     y caía en el `catch` que dice «el enlace ya no sirve»;
 *   - que 8 y 128 son los bordes que valen, como en /alta/correo y /invitacion;
 *   - que ese `catch` sigue siendo para las fallas de verdad (token vencido).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ resetPassword: vi.fn(), locale: vi.fn(), rateLimit: vi.fn(), topePorIp: vi.fn() }));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth", () => ({ auth: { api: { resetPassword: h.resetPassword } } }));
vi.mock("@/lib/i18n/locale", () => ({ getServerLocale: h.locale }));
vi.mock("@/lib/rate-limit/index", () => ({
  RATE_LIMIT_CONFIGS: { AUTH_SIGN_IN: { limit: 5, windowMs: 10_000 } },
  clientIpFromHeaders: () => "203.0.113.7",
  rateLimit: h.rateLimit,
  topePorIp: h.topePorIp,
}));

import { restablecer } from "@/app/restablecer/actions";

function formulario(password: string, repetir = password, token = "token-del-mail") {
  const datos = new FormData();
  datos.set("token", token);
  datos.set("password", password);
  datos.set("repetir", repetir);
  return datos;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.locale.mockResolvedValue("es-AR");
  h.resetPassword.mockResolvedValue({ status: true });
  h.rateLimit.mockResolvedValue({ allowed: true });
  h.topePorIp.mockResolvedValue({ allowed: true });
});

describe("restablecer: el largo de la contraseña", () => {
  it("una de 129 caracteres vuelve como error de la clave, sin tocar Better Auth", async () => {
    const r = await restablecer({}, formulario("a".repeat(129)));

    expect(r.fieldErrors?.password).toEqual(["La contraseña tiene que tener entre 8 y 128 caracteres."]);
    expect(r.error).toBeUndefined();
    expect(h.resetPassword).not.toHaveBeenCalled();
  });

  it("el mensaje sale en inglés con el dispositivo en en-US", async () => {
    h.locale.mockResolvedValue("en-US");

    const r = await restablecer({}, formulario("a".repeat(129)));

    expect(r.fieldErrors?.password).toEqual(["The password must be between 8 and 128 characters."]);
    expect(h.resetPassword).not.toHaveBeenCalled();
  });

  it("una de 7 da el mismo mensaje del rango", async () => {
    const r = await restablecer({}, formulario("a".repeat(7)));

    expect(r.fieldErrors?.password).toEqual(["La contraseña tiene que tener entre 8 y 128 caracteres."]);
    expect(h.resetPassword).not.toHaveBeenCalled();
  });

  it.each([8, 128])("una de %i caracteres pasa a Better Auth con el token", async (largo) => {
    const clave = "a".repeat(largo);

    const r = await restablecer({}, formulario(clave));

    expect(r).toEqual({ listo: true });
    expect(h.resetPassword).toHaveBeenCalledWith(
      expect.objectContaining({ body: { newPassword: clave, token: "token-del-mail" } })
    );
  });
});

describe("restablecer: el resto del formulario", () => {
  it("dos contraseñas distintas vuelven como error de «repetir», en el idioma del dispositivo", async () => {
    const es = await restablecer({}, formulario("a".repeat(10), "b".repeat(10)));
    h.locale.mockResolvedValue("en-US");
    const en = await restablecer({}, formulario("a".repeat(10), "b".repeat(10)));

    expect(es.fieldErrors?.repetir).toEqual(["Las dos contraseñas no coinciden."]);
    expect(en.fieldErrors?.repetir).toEqual(["The two passwords do not match."]);
    expect(h.resetPassword).not.toHaveBeenCalled();
  });

  it("un token vacío es un enlace incompleto, no un error de formulario", async () => {
    const r = await restablecer({}, formulario("a".repeat(10), "a".repeat(10), ""));

    expect(r).toEqual({ error: "El enlace está incompleto. Pedí uno nuevo." });
    expect(h.resetPassword).not.toHaveBeenCalled();
  });

  it("si Better Auth rechaza el token, dice que el enlace ya no sirve", async () => {
    h.resetPassword.mockRejectedValue(new Error("INVALID_TOKEN"));

    const r = await restablecer({}, formulario("a".repeat(10)));

    expect(r.error).toMatch(/ya no sirve/);
    expect(r.fieldErrors).toBeUndefined();
  });
});

describe("restablecer: el techo de intentos", () => {
  it("sin cupo no llama a Better Auth y dice cuánto esperar", async () => {
    h.rateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 9 });

    const r = await restablecer({}, formulario("clave-nueva-larga"));

    expect(r.error).toBe("Demasiados intentos. Probá de nuevo en 9 segundos.");
    expect(h.resetPassword).not.toHaveBeenCalled();
  });

  it("cuenta por IP sola en el balde de /api/auth/reset-password", async () => {
    await restablecer({}, formulario("clave-nueva-larga"));

    expect(h.rateLimit).toHaveBeenCalledWith("auth:reset:203.0.113.7", { limit: 5, windowMs: 10_000 });
    expect(h.topePorIp).toHaveBeenCalledWith("203.0.113.7");
    expect(h.resetPassword).toHaveBeenCalledOnce();
  });
});
