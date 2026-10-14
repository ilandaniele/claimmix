/**
 * POST /api/meta/borrado: el aviso de borrado de datos que pide Meta. Sin firma
 * válida no se toca nada; con ella se borra el token y el PIN de la WABA de ese
 * usuario de Facebook, se deja una entrada de auditoría por espacio (la deja la misma
 * sentencia de la baja, con el código que se contesta) y se contesta `{ url, confirmation_code }`. Si la base falla se contesta 500 para que Meta
 * reintente, y nunca un código que haga creer que se borró.
 *
 * La baja, la firma y el límite de pedidos están simulados: la firma
 * HMAC la prueba `embedded-signup.test.ts` y el SQL de la baja `pnpm tenancy`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  leerPedidoFirmado: vi.fn(),
  bajaDeWaba: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: h.rateLimit,
  getClientIp: () => "203.0.113.7",
}));
vi.mock("@/server/whatsapp/embedded-signup", () => ({ leerPedidoFirmado: h.leerPedidoFirmado }));
vi.mock("@/server/alta/panel-operador", () => ({ bajaDeWaba: h.bajaDeWaba }));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: h.info, warn: h.warn, error: h.error } }));

import { POST } from "@/app/api/meta/borrado/route";

const TENANT = "10000000-0000-4000-8000-000000000001";
const OTRO = "20000000-0000-4000-8000-000000000002";

const baja = (cambios: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  wabaId: "555000111222",
  phoneNumberId: "777",
  numeroEstado: "activo",
  token: "test-waba-token",
  ...cambios,
});

const pedido = (cuerpo: string) =>
  new NextRequest("http://localhost/api/meta/borrado", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: cuerpo,
  });
const firmado = (valor = "firma.payload") => pedido(`signed_request=${encodeURIComponent(valor)}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://claimmix.example.com");
  h.rateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  h.leerPedidoFirmado.mockReturnValue({ userId: "1234567890" });
  h.bajaDeWaba.mockResolvedValue([baja()]);
});

describe("pedido que no es de Meta", () => {
  it("sin signed_request contesta 400 y no toca la base", async () => {
    h.leerPedidoFirmado.mockReturnValue(null);

    const res = await POST(pedido("otra_cosa=1"));

    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_SIGNED_REQUEST");
    expect(h.leerPedidoFirmado).toHaveBeenCalledWith("");
    expect(h.bajaDeWaba).not.toHaveBeenCalled();
  });

  it("con una firma que no vale contesta 400 y no toca la base", async () => {
    h.leerPedidoFirmado.mockReturnValue(null);

    const res = await POST(firmado("mala.firma"));

    expect(res.status).toBe(400);
    expect(h.leerPedidoFirmado).toHaveBeenCalledWith("mala.firma");
    expect(h.bajaDeWaba).not.toHaveBeenCalled();
  });

  it("un cuerpo enorme se rechaza con 413 sin mirar la firma", async () => {
    const res = await POST(pedido(`signed_request=${"a".repeat(9_000)}`));

    expect(res.status).toBe(413);
    expect(h.leerPedidoFirmado).not.toHaveBeenCalled();
    expect(h.bajaDeWaba).not.toHaveBeenCalled();
  });

  it("pasado el tope por IP contesta 429 con Retry-After antes de leer nada", async () => {
    h.rateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });

    const res = await POST(firmado());

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect(h.leerPedidoFirmado).not.toHaveBeenCalled();
    expect(h.bajaDeWaba).not.toHaveBeenCalled();
  });

  it("el tope se cuenta por IP en el ámbito `meta:borrado`", async () => {
    await POST(firmado());

    const [clave, tope] = h.rateLimit.mock.calls[0] as [string, { limit: number; windowMs: number }];
    expect(clave).toContain("meta:borrado");
    expect(clave).toContain("203.0.113.7");
    expect(tope).toEqual({ limit: 30, windowMs: 60_000 });
  });
});

describe("pedido firmado", () => {
  it("da de baja por el usuario de Facebook con actor `meta` y contesta url y código", async () => {
    const res = await POST(firmado());

    expect(res.status).toBe(200);
    const cuerpo = await res.json();
    expect(cuerpo.url).toBe("https://claimmix.example.com/privacy#meta");
    expect(cuerpo.confirmation_code).toMatch(/^[0-9a-f]{32}$/);
    expect(h.bajaDeWaba).toHaveBeenCalledWith({ fbUserId: "1234567890" }, "meta", cuerpo.confirmation_code);
  });

  it("la constancia viaja dentro de la baja: una sola llamada con el mismo código que se contesta, y la ruta no asienta aparte", async () => {
    h.bajaDeWaba.mockResolvedValue([baja(), baja({ tenantId: OTRO, wabaId: "666" })]);

    const res = await POST(firmado());
    const { confirmation_code: codigo } = await res.json();

    expect(h.bajaDeWaba).toHaveBeenCalledTimes(1);
    expect(h.bajaDeWaba.mock.calls[0][2]).toBe(codigo);
    expect(h.bajaDeWaba.mock.calls[0]).toHaveLength(3);
  });

  it("si no encuentra ninguna WABA igual contesta con un código: no había nada que borrar", async () => {
    h.bajaDeWaba.mockResolvedValue([]);

    const res = await POST(firmado());

    expect(res.status).toBe(200);
    expect((await res.json()).confirmation_code).toMatch(/^[0-9a-f]{32}$/);
  });

  it("sin coincidencia deja un aviso en el registro, para ver un id que nunca calza", async () => {
    h.bajaDeWaba.mockResolvedValue([]);

    const res = await POST(firmado());
    const { confirmation_code: codigo } = await res.json();

    expect(h.warn).toHaveBeenCalledWith({ codigo }, "meta_borrado.sin_coincidencia");
  });

  it("con coincidencia no avisa", async () => {
    await POST(firmado());

    expect(h.warn).not.toHaveBeenCalled();
  });

  it("cada pedido recibe un código distinto", async () => {
    const a = await (await POST(firmado())).json();
    const b = await (await POST(firmado())).json();

    expect(a.confirmation_code).not.toBe(b.confirmation_code);
  });

  it("ni el token ni el id de usuario llegan a la respuesta ni al registro", async () => {
    const res = await POST(firmado());
    const salida = JSON.stringify([await res.json(), h.info.mock.calls, h.warn.mock.calls, h.error.mock.calls]);

    expect(salida).not.toContain("test-waba-token");
    expect(salida).not.toContain("1234567890");
  });
});

describe("la base falla", () => {
  it("contesta 500 para que Meta reintente, y no un código", async () => {
    h.bajaDeWaba.mockRejectedValue(new Error("42P01"));

    const res = await POST(firmado());

    expect(res.status).toBe(500);
    const cuerpo = await res.json();
    expect(cuerpo.error.code).toBe("DELETION_FAILED");
    expect(cuerpo.confirmation_code).toBeUndefined();
    expect(h.error).toHaveBeenCalledWith(expect.any(Object), "meta_borrado.fallo");
  });
});
