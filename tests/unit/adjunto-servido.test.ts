/**
 * GET /api/cases/:id/attachments/:attachmentId — abre un adjunto guardado.
 *
 * `entrar` se reemplaza por uno que cumple su contrato (sin sesión 401, rol
 * fuera de la lista 403, cupo agotado lo avisa en `rl`): así se prueba qué
 * roles deja pasar la RUTA, no la puerta, que tiene su propio test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";

const { mockEntrar, mockEnTenant, mockAbrir } = vi.hoisted(() => ({
  mockEntrar: vi.fn(),
  mockEnTenant: vi.fn(),
  mockAbrir: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/entrada", () => ({ entrar: mockEntrar }));
vi.mock("@/data/scope", () => ({ enTenant: mockEnTenant }));
vi.mock("@/server/storage/claim-attachments-bucket", () => ({ abrirAdjunto: mockAbrir }));
vi.mock("@/lib/auth/require-role", async () => ({
  CASE_EDITOR_ROLES: (await import("@/lib/auth/roles")).CASE_EDITOR_ROLES,
}));
vi.mock("@/lib/rate-limit/index", () => ({
  RATE_LIMIT_CONFIGS: { CASES_API: { limit: 100, windowMs: 60_000 } },
}));

import { GET } from "@/app/api/cases/[id]/attachments/[attachmentId]/route";

const CASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const ATTACHMENT_ID = "223e4567-e89b-12d3-a456-426614174002";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";

const FILA = {
  storage_path: "tenant/case/msg/foto.jpg",
  content_type: "image/jpeg",
  file_name: "foto.jpg",
};

/** Un `ReadableStream` con contenido, como el que devuelve `abrirAdjunto`. */
function stream(bytes = "contenido"): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(bytes));
      controller.close();
    },
  });
}

const sesion = { rol: "analyst" as string | null, cupo: true };

function llamar(id = CASE_ID, attachmentId = ATTACHMENT_ID) {
  return GET(
    new NextRequest(`http://localhost/api/cases/${id}/attachments/${attachmentId}`),
    { params: Promise.resolve({ id, attachmentId }) }
  );
}

describe("GET /api/cases/:id/attachments/:attachmentId", () => {
  beforeEach(() => {
    sesion.rol = "analyst";
    sesion.cupo = true;
    mockEntrar.mockImplementation(
      async (_etiqueta: unknown, _cupo: unknown, ...roles: string[]) => {
        if (!sesion.rol) throw new AppError("MISSING_SESSION");
        if (!roles.includes(sesion.rol)) throw new AppError("FORBIDDEN_ROLE");
        return {
          ctx: {
            user: { id: USER_ID },
            userRow: { id: USER_ID, tenant_id: TENANT_ID, role: sesion.rol },
          },
          rl: { allowed: sesion.cupo, remaining: 0, retryAfterSeconds: 60 },
        };
      }
    );
    mockEnTenant.mockResolvedValue([FILA]);
    mockAbrir.mockResolvedValue({ cuerpo: stream(), largo: 9 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("un JPEG se abre inline, con nosniff, no-store y el CSP con sandbox", async () => {
    const res = await llamar();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
  });

  it("un PDF se abre inline pero sin sandbox: Chromium no renderiza un PDF ahí adentro", async () => {
    mockEnTenant.mockResolvedValue([
      { ...FILA, content_type: "application/pdf", file_name: "denuncia.pdf" },
    ]);

    const res = await llamar();

    expect(res.headers.get("Content-Disposition")).toMatch(/^inline;/);
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
  });

  it("un tipo guardado como text/html se sirve genérico y para descargar", async () => {
    mockEnTenant.mockResolvedValue([
      { ...FILA, content_type: "text/html", file_name: "index.html" },
    ]);

    const res = await llamar();

    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });

  it("un nombre con comillas, CRLF y no-ascii da un filename ascii seguro y un filename* correcto", async () => {
    const nombre = 'foto"\r\nmalicioso ñ.jpg';
    mockEnTenant.mockResolvedValue([{ ...FILA, file_name: nombre }]);

    const res = await llamar();
    const disposition = res.headers.get("Content-Disposition") ?? "";

    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toContain('filename="foto___malicioso _.jpg"');
    expect(disposition).toContain(`filename*=UTF-8''${encodeURIComponent(nombre)}`);
  });

  it("un nombre con un carácter de control no imprimible no rompe el header", async () => {
    const nombre = "foto\x01.jpg";
    mockEnTenant.mockResolvedValue([{ ...FILA, file_name: nombre }]);

    const res = await llamar();

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain('filename="foto_.jpg"');
  });

  it("un id que no es uuid da 404", async () => {
    const res = await llamar("no-es-un-uuid");

    expect(res.status).toBe(404);
    expect(mockEnTenant).not.toHaveBeenCalled();
  });

  it("sin fila da 404", async () => {
    mockEnTenant.mockResolvedValue([]);

    expect((await llamar()).status).toBe(404);
  });

  it("si abrirAdjunto no encuentra los bytes da 404", async () => {
    mockAbrir.mockResolvedValue(null);

    expect((await llamar()).status).toBe(404);
  });

  it("un viewer no entra: pii.ts enmascara la conversación pero los bytes no se pueden enmascarar", async () => {
    sesion.rol = "viewer";

    expect((await llamar()).status).toBe(403);
    expect(mockEnTenant).not.toHaveBeenCalled();
    // Lo que importa es el rol con el que se llamó a la puerta, no sólo el resultado.
    const roles = mockEntrar.mock.calls[0]?.slice(2);
    expect(roles).toEqual(["owner", "admin", "specialist", "analyst"]);
  });

  it("con el cupo agotado da 429", async () => {
    sesion.cupo = false;

    expect((await llamar()).status).toBe(429);
    expect(mockEnTenant).not.toHaveBeenCalled();
  });

  it("una sola consulta", async () => {
    await llamar();

    expect(mockEnTenant).toHaveBeenCalledTimes(1);
  });
});
