/**
 * POST /api/cases/:id/export-to-core: el JSON que el analista baja a mano.
 *
 * Como en api-v1-cases.test.ts, las consultas son las de verdad (drizzle sobre
 * `pg-proxy`, sin base) y la base falsa contesta según el inquilino del contexto,
 * que es lo que hace RLS. Así se ve la forma entera del payload, con las fechas
 * en ISO, que un caso de otro inquilino da 404 y que el lote deja el evento
 * `case.exported_to_core` sin datos personales.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/errors";

type Consulta = { toSQL(): { sql: string; params: unknown[] } };

const h = vi.hoisted(() => ({
  casos: {} as Record<string, Record<string, unknown>>,
  consultas: [] as Array<{ sql: string; params: unknown[] }>,
  contextos: [] as string[],
}));

vi.mock("@/data/scope", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const base = drizzle(async () => ({ rows: [] }));
  return {
    enTenantVarias: vi.fn(async (ctx: { tenantId: string }, armar: (db: unknown) => Consulta[]) => {
      h.contextos.push(ctx.tenantId);
      return armar(base).map((q) => {
        const consulta = q.toSQL();
        h.consultas.push(consulta);
        // El INSERT ... SELECT del registro también lee de "cases": va primero.
        if (consulta.sql.includes('insert into "audit_log"')) return [];
        if (consulta.sql.includes('from "cases"')) {
          const caso = h.casos[ctx.tenantId];
          return caso?.case_id === consulta.params[0] ? [caso] : [];
        }
        if (consulta.sql.includes('from "extracted_fields"')) return [{ field_key: "patente", field_value: "AB123CD", confidence: 0.9 }];
        return [{ doc_key: "denuncia_policial", requested_at: "2026-09-28T12:00:00.000000Z", satisfied_at: null, declined_at: null, declined_note: null }];
      });
    }),
  };
});

vi.mock("@/lib/api/entrada", () => ({ entrar: vi.fn() }));

import { enTenantVarias } from "@/data/scope";
import { entrar } from "@/lib/api/entrada";
import { CASE_EDITOR_ROLES } from "@/lib/auth/require-role";
import { RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { POST } from "@/app/api/cases/[id]/export-to-core/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTRO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CASO = "11111111-1111-4111-8111-111111111111";
const USUARIO = "22222222-2222-4222-8222-222222222222";

const FILA = {
  case_id: CASO,
  policy_number: "POL-1",
  policyholder_name: "Ana Pérez",
  claim_type: "auto",
  status: "listo_para_core",
  confidence_min: 0.8,
  channel: "whatsapp_sim",
  created_at: "2026-09-28T11:00:00.000000Z",
  updated_at: "2026-09-28T12:00:00.123456Z",
  closed_at: null,
};

function exportar(id = CASO, headers: Record<string, string> = {}) {
  return POST(new NextRequest(`http://localhost/api/cases/${id}/export-to-core`, { method: "POST", headers }), {
    params: Promise.resolve({ id }),
  });
}

const ENTRADA = {
  ctx: {
    user: { id: USUARIO },
    userRow: { id: USUARIO, tenant_id: TENANT, role: "analyst" as const, plan: "profesional" },
  },
  rl: { allowed: true, remaining: 99, resetAt: 0, retryAfterSeconds: 0, ventana: 0 },
};

beforeEach(() => {
  vi.mocked(entrar).mockReset().mockResolvedValue(ENTRADA);
  vi.mocked(enTenantVarias).mockClear();
  h.casos = { [TENANT]: FILA };
  h.consultas = [];
  h.contextos = [];
});

describe("export-to-core", () => {
  it("devuelve el caso, sus campos y sus documentos, con quién y cuándo lo exportó", async () => {
    const r = await exportar();
    expect(r.status).toBe(200);
    const cuerpo = await r.json();

    expect(cuerpo).toEqual({
      _note: expect.any(String),
      ...FILA,
      extracted_fields: [{ field_key: "patente", field_value: "AB123CD", confidence: 0.9 }],
      missing_docs: [expect.objectContaining({ doc_key: "denuncia_policial" })],
      exported_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      exported_by: USUARIO,
    });
    expect(h.contextos).toEqual([TENANT]);
  });

  it("lee el caso y deja el evento en un solo lote, con las fechas en ISO", async () => {
    await exportar();
    expect(enTenantVarias).toHaveBeenCalledTimes(1);
    expect(h.consultas).toHaveLength(4);
    const [caso, , docs, registro] = h.consultas;
    expect(caso.sql.match(/to_char/g)).toHaveLength(3);
    expect(docs.sql.match(/to_char/g)).toHaveLength(3);
    // Última: el tenant_id sale del propio caso, así uno ajeno no deja fila.
    expect(registro.sql).toMatch(/^insert into "audit_log" .* as "id", "tenant_id", .* from "cases" where /);
    expect(registro.params).toEqual(expect.arrayContaining(["case.exported_to_core", USUARIO, CASO]));
  });

  it("el registro no lleva datos personales: payload vacío, y la IP que no es IP va en null", async () => {
    await exportar(CASO, { "user-agent": "vitest" });
    const registro = h.consultas[3];
    for (const dato of ["Ana Pérez", "POL-1", "AB123CD"]) {
      expect(registro.sql).not.toContain(dato);
      expect(JSON.stringify(registro.params)).not.toContain(dato);
    }
    expect(registro.sql).toContain("'{}'::jsonb");
    expect(registro.params).toContain("vitest");
    expect(registro.params).toContain(null);
    expect(registro.params).not.toContain("anonymous");
  });

  it("la IP de quien exporta queda en el registro cuando es válida", async () => {
    await exportar(CASO, { "x-forwarded-for": "203.0.113.9" });
    expect(h.consultas[3].params).toContain("203.0.113.9");
  });

  it("si el registro no entra, el lote cae, el JSON no sale y la falla es un 500 con el cuerpo de error de siempre", async () => {
    vi.mocked(enTenantVarias).mockRejectedValueOnce(new Error("23503 violates foreign key audit_log_actor_id_fkey"));

    const r = await exportar();

    expect(r.status).toBe(500);
    const texto = await r.text();
    expect(JSON.parse(texto)).toEqual({ error: { code: "INTERNAL_ERROR", message: expect.any(String) } });
    // Ni el caso ni el motivo técnico viajan en la respuesta.
    for (const dato of ["Ana Pérez", "POL-1", "audit_log_actor_id_fkey"]) expect(texto).not.toContain(dato);
  });

  it("un caso simulado también se exporta: el filtro de /api/v1 no aplica a mano", async () => {
    await exportar();
    expect(h.consultas[0].sql).not.toContain('"claim_messages"');
    expect(h.consultas[0].params).toEqual([CASO, 1]);
  });

  it("un caso de otro inquilino da 404 en un solo lote, y el registro no inserta nada", async () => {
    h.casos = { [OTRO]: FILA };
    const r = await exportar();
    expect(r.status).toBe(404);
    expect(h.contextos).toEqual([TENANT]);
    expect(enTenantVarias).toHaveBeenCalledTimes(1);
    expect(h.consultas[3].sql).toContain('from "cases" where');
  });

  it("un id que no es UUID da 400 sin tocar la base", async () => {
    expect((await exportar("no-es-un-id")).status).toBe(400);
    expect(entrar).not.toHaveBeenCalled();
    expect(enTenantVarias).not.toHaveBeenCalled();
    expect(h.consultas).toEqual([]);
  });

  it("pasa por la puerta común, con el cupo de los casos y los roles que editan casos", async () => {
    await exportar();
    expect(entrar).toHaveBeenCalledWith("export-to-core", RATE_LIMIT_CONFIGS.CASES_API, ...CASE_EDITOR_ROLES);
  });

  it("sin permiso da 403 sin tocar la base", async () => {
    vi.mocked(entrar).mockRejectedValue(new AppError("FORBIDDEN_ROLE"));
    expect((await exportar()).status).toBe(403);
    expect(enTenantVarias).not.toHaveBeenCalled();
    expect(h.consultas).toEqual([]);
  });

  it("pasado el cupo da 429 sin tocar la base", async () => {
    vi.mocked(entrar).mockResolvedValue({ ...ENTRADA, rl: { ...ENTRADA.rl, allowed: false, remaining: 0, retryAfterSeconds: 30 } });
    expect((await exportar()).status).toBe(429);
    expect(enTenantVarias).not.toHaveBeenCalled();
    expect(h.consultas).toEqual([]);
  });
});
