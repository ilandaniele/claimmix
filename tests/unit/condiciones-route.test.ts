/**
 * POST /api/policies/:id/condiciones (B6): sube el PDF de condiciones y lo lee
 * una vez. Sin lectura queda «subido, sin leer», nunca con coberturas
 * inventadas ni con las de otro PDF.
 *
 * `entrar` cumple su contrato (rol fuera de la lista 403): se prueba qué roles
 * deja pasar la RUTA.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { AppError } from "@/lib/errors";

const m = vi.hoisted(() => ({
  entrar: vi.fn(),
  enTenant: vi.fn(),
  leer: vi.fn(),
  subir: vi.fn(),
  borrar: vi.fn(),
  cupo: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/api/entrada", () => ({ entrar: m.entrar }));
vi.mock("@/data/scope", () => ({ enTenant: m.enTenant }));
vi.mock("@/server/ai/leer-documento", () => ({ leerDocumento: m.leer }));
vi.mock("@/server/storage/claim-attachments-bucket", () => ({ subirCondiciones: m.subir, deleteAttachment: m.borrar }));
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: m.audit,
  AuditEvent: { POLICY_CONDITIONS_UPLOADED: "policy.conditions_uploaded" },
}));
vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: m.cupo,
  RATE_LIMIT_CONFIGS: {
    CASES_API: { limit: 100, windowMs: 60_000 },
    SUBIDA_CONDICIONES_POR_POLIZA: { limit: 10, windowMs: 86_400_000 },
  },
}));

import { POST } from "@/app/api/policies/[id]/condiciones/route";

const POLICY_ID = "123e4567-e89b-12d3-a456-426614174001";
const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const USER_ID = "20000000-0000-0000-0000-000000000001";
const RUTA = `${TENANT_ID}/polizas/${POLICY_ID}/condiciones.pdf`;

const pdf = (paginas: number) =>
  `%PDF-1.4\n1 0 obj <</Type /Pages /Count ${paginas}>>\n2 0 obj <</Type /Page>>\n`;

const sesion = { rol: "specialist" };
let poliza: Array<{ policy_type: string; anterior: string | null }>;
let grabado: Record<string, unknown> | null;
let fallaAlLeer: unknown;
let fallaAlGrabar: unknown;

function llamar(archivos: File[] = [new File([pdf(2)], "condiciones.pdf", { type: "application/pdf" })], id = POLICY_ID) {
  const form = new FormData();
  for (const a of archivos) form.append("archivo", a);
  return POST(new NextRequest(`http://localhost/api/policies/${id}/condiciones`, { method: "POST", body: form }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sesion.rol = "specialist";
  poliza = [{ policy_type: "auto", anterior: null }];
  grabado = null;
  fallaAlLeer = null;
  fallaAlGrabar = null;
  m.entrar.mockImplementation(async (_e: unknown, _c: unknown, ...roles: string[]) => {
    if (!roles.includes(sesion.rol)) throw new AppError("FORBIDDEN_ROLE");
    return {
      ctx: { user: { id: USER_ID }, userRow: { id: USER_ID, tenant_id: TENANT_ID, role: sesion.rol } },
      rl: { allowed: true },
    };
  });
  m.enTenant.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => unknown) =>
    armar({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              if (fallaAlLeer) throw fallaAlLeer;
              return poliza;
            },
          }),
        }),
      }),
      update: () => ({
        set: (v: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              if (fallaAlGrabar) throw fallaAlGrabar;
              grabado = v;
              return [{ condiciones_leidas_en: "2026-09-29T12:00:00Z" }];
            },
          }),
        }),
      }),
    })
  );
  m.subir.mockResolvedValue(RUTA);
  m.borrar.mockResolvedValue(true);
  m.cupo.mockResolvedValue({ allowed: true });
  m.leer.mockResolvedValue({
    ok: { coberturas: [{ codigo: "rc", suma_asegurada: 1000, franquicia: null }], ambito: { tipo: "nacional", provincias: [] } },
  });
  m.audit.mockResolvedValue(undefined);
});

describe("POST /api/policies/:id/condiciones — quién y qué", () => {
  it.each(["analyst", "viewer"])("%s no sube condiciones", async (rol) => {
    sesion.rol = rol;
    const res = await llamar();
    expect(res.status).toBe(403);
    expect(m.subir).not.toHaveBeenCalled();
  });

  it("un id que no es uuid da 400 sin tocar nada", async () => {
    const res = await llamar(undefined, "no-es-uuid");
    expect(res.status).toBe(400);
    expect(m.entrar).not.toHaveBeenCalled();
  });

  it("sólo un PDF, en un solo campo", async () => {
    expect((await llamar([new File(["hola"], "a.txt", { type: "text/plain" })])).status).toBe(400);
    const dos = [0, 1].map(() => new File([pdf(1)], "a.pdf", { type: "application/pdf" }));
    expect((await llamar(dos)).status).toBe(400);
    expect(m.leer).not.toHaveBeenCalled();
  });

  it("un PDF de más de 10 páginas o que no es PDF da 422 y no gasta una lectura", async () => {
    expect((await llamar([new File([pdf(11)], "a.pdf", { type: "application/pdf" })])).status).toBe(422);
    expect((await llamar([new File(["no soy pdf"], "a.pdf", { type: "application/pdf" })])).status).toBe(422);
    expect(m.subir).not.toHaveBeenCalled();
    expect(m.leer).not.toHaveBeenCalled();
  });

  it("una póliza que no existe (o es de otro) da 404 antes de subir o leer", async () => {
    poliza = [];
    expect((await llamar()).status).toBe(404);
    expect(m.subir).not.toHaveBeenCalled();
    expect(m.leer).not.toHaveBeenCalled();
  });
});

describe("POST /api/policies/:id/condiciones — la lectura", () => {
  it("leído: guarda coberturas, ámbito y ruta, y lo deja en la auditoría", async () => {
    const res = await llamar();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      subido: true,
      leido: true,
      motivo: null,
      condiciones_leidas_en: "2026-09-29T12:00:00Z",
    });
    expect(grabado).toMatchObject({
      coberturas: [{ codigo: "rc", suma_asegurada: 1000, franquicia: null }],
      ambito_territorial: { tipo: "nacional", provincias: [] },
      condiciones_path: RUTA,
    });
    const pedido = m.leer.mock.calls[0]![0];
    expect(pedido).toMatchObject({ tenantId: TENANT_ID, userId: USER_ID, ambito: "condiciones-poliza" });
    expect(pedido.partesDeClave).toEqual([TENANT_ID, POLICY_ID]);
    expect(pedido.usuario).toMatch(/^<condiciones_poliza>.*<\/condiciones_poliza>$/);
    expect(pedido.media).toEqual([{ mimeType: "application/pdf", data: Buffer.from(pdf(2)).toString("base64") }]);
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ target_id: POLICY_ID, payload: { leido: true, motivo: null } })
    );
  });

  it("sin lectura: el PDF queda subido y no se escriben coberturas inventadas", async () => {
    m.leer.mockResolvedValue({ sinLeer: "cupo" });

    const res = await llamar();

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ subido: true, leido: false, motivo: "cupo" });
    expect(grabado?.condiciones_path).toBe(RUTA);
    // Lo leído antes sólo sobrevive si es del mismo PDF: un CASE, no un array.
    expect(Array.isArray(grabado?.coberturas)).toBe(false);
  });

  it("sin la 0040 contesta 503 con el aviso de la migración, y antes de subir", async () => {
    fallaAlGrabar = Object.assign(new Error("no existe la columna"), { code: "42703" });
    const res = await llamar();
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("MIGRACION_PENDIENTE");

    fallaAlLeer = fallaAlGrabar;
    m.subir.mockClear();
    expect((await llamar()).status).toBe(503);
    expect(m.subir).not.toHaveBeenCalled();
  });

  // El cupo de lectura se cuenta recién después de subir: sin éste, cada PDF
  // distinto en loop era un objeto más en el bucket.
  it("sin cupo de subida da 429 y no guarda ni lee; si el cupo falla, tampoco", async () => {
    m.cupo.mockResolvedValue({ allowed: false });
    expect((await llamar()).status).toBe(429);
    expect(m.cupo).toHaveBeenCalledWith(`subida-condiciones:${TENANT_ID}:${POLICY_ID}`, {
      limit: 10,
      windowMs: 86_400_000,
    });

    m.cupo.mockRejectedValue(new Error("sin base"));
    expect((await llamar()).status).toBe(429);
    expect(m.subir).not.toHaveBeenCalled();
    expect(m.leer).not.toHaveBeenCalled();
  });

  it("un PDF distinto borra el anterior del bucket; el mismo, no", async () => {
    poliza = [{ policy_type: "auto", anterior: `${TENANT_ID}/policies/${POLICY_ID}/viejo.pdf` }];
    await llamar();
    expect(m.borrar).toHaveBeenCalledWith(`${TENANT_ID}/policies/${POLICY_ID}/viejo.pdf`);

    m.borrar.mockClear();
    poliza = [{ policy_type: "auto", anterior: RUTA }];
    await llamar();
    expect(m.borrar).not.toHaveBeenCalled();
  });

  it("si no se pudo grabar la ruta nueva, el anterior no se borra", async () => {
    poliza = [{ policy_type: "auto", anterior: `${TENANT_ID}/policies/${POLICY_ID}/viejo.pdf` }];
    fallaAlGrabar = new Error("se cayó la base");
    expect((await llamar()).status).toBe(500);
    expect(m.borrar).not.toHaveBeenCalled();
  });

  it("si el bucket no guarda, 500 y no se lee", async () => {
    m.subir.mockResolvedValue(null);
    expect((await llamar()).status).toBe(500);
    expect(m.leer).not.toHaveBeenCalled();
  });
});
