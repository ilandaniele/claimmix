// @vitest-environment node
/**
 * El ícono de la app de Meta del cliente (`GET /conectar-whatsapp/app/icono`) y las iniciales
 * que lleva. La ruta es privada: sin sesión es 401, sin el rol 403, y con la lectura caída
 * sale el ícono genérico en vez de un error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  leer: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({
  ADMIN_ROLES: ["admin", "super_admin"],
  requireRole: h.requireRole,
}));
vi.mock("@/server/alta/waba-publica", () => ({ leerWabaPublica: h.leer }));

import { GET } from "@/app/conectar-whatsapp/app/icono/route";
import { inicialesDe } from "@/app/conectar-whatsapp/app/iniciales";
import { AppError } from "@/lib/errors";

const PNG = [0x89, 0x50, 0x4e, 0x47];

beforeEach(() => {
  vi.clearAllMocks();
  h.requireRole.mockResolvedValue({ userRow: { tenant_id: "t-1" } });
  h.leer.mockResolvedValue({ nombre: "Aseguradora Sur" });
});

describe("inicialesDe", () => {
  it.each([
    ["Aseguradora Sur", "AS"],
    ["aseguradora sur seguros", "AS"],
    ["Sur", "S"],
    ["  Mutual   del  Plata  ", "MD"],
    ["Ñandú Seguros", "ÑS"],
    ["3M Argentina", "3A"],
    ["«Sur» & Cía", "SC"],
    ["", "CM"],
    ["   ", "CM"],
    ["***", "CM"],
  ])("%j da %j", (nombre, esperado) => {
    expect(inicialesDe(nombre)).toBe(esperado);
  });
});

describe("GET /conectar-whatsapp/app/icono", () => {
  it("pide un rol de administración", async () => {
    await GET();

    expect(h.requireRole).toHaveBeenCalledWith("admin", "super_admin");
  });

  it("sin sesión contesta 401 sin cuerpo y no lee nada", async () => {
    h.requireRole.mockRejectedValue(new AppError("MISSING_SESSION"));

    const r = await GET();

    expect(r.status).toBe(401);
    expect(await r.text()).toBe("");
    expect(h.leer).not.toHaveBeenCalled();
  });

  it("con otro rol contesta 403", async () => {
    h.requireRole.mockRejectedValue(new AppError("FORBIDDEN_ROLE"));

    expect((await GET()).status).toBe(403);
    expect(h.leer).not.toHaveBeenCalled();
  });

  it("cualquier otra falla al pedir la sesión también cierra la puerta", async () => {
    h.requireRole.mockRejectedValue(new Error("base caída"));

    expect((await GET()).status).toBe(403);
  });

  it("lee la fila del espacio de quien pide", async () => {
    await GET();

    expect(h.leer).toHaveBeenCalledWith("t-1");
  });

  it("devuelve un PNG de 1024 por 1024 para descargar, que no se guarda en ningún caché", async () => {
    const r = await GET();

    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="icono-whatsapp.png"');
    expect(r.headers.get("cache-control")).toBe("private, no-store");

    const bytes = new Uint8Array(await r.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual(PNG);
    const vista = new DataView(bytes.buffer, bytes.byteOffset);
    expect(vista.getUint32(16)).toBe(1024);
    expect(vista.getUint32(20)).toBe(1024);
  });

  it("si la lectura no trae nada sale igual el ícono genérico", async () => {
    h.leer.mockResolvedValue(null);

    const r = await GET();

    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
  });
});
