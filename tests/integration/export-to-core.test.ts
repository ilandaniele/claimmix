/**
 * POST /api/cases/:id/export-to-core: el JSON que el analista baja a mano.
 *
 * Como en api-v1-cases.test.ts, las consultas son las de verdad (`QueryBuilder`)
 * y la base falsa contesta según el inquilino del contexto, que es lo que hace
 * RLS. Así se ve la forma entera del payload, con las fechas en ISO, y que un
 * caso de otro inquilino da 404.
 */

import { QueryBuilder } from "drizzle-orm/pg-core";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/errors";

type Consulta = { toSQL(): { sql: string; params: unknown[] } };

const h = vi.hoisted(() => ({
  casos: {} as Record<string, Record<string, unknown>>,
  consultas: [] as Array<{ sql: string; params: unknown[] }>,
  contextos: [] as string[],
}));

vi.mock("@/data/scope", () => ({
  enTenantVarias: vi.fn(async (ctx: { tenantId: string }, armar: (db: unknown) => Consulta[]) => {
    h.contextos.push(ctx.tenantId);
    return armar(new QueryBuilder()).map((q) => {
      const consulta = q.toSQL();
      h.consultas.push(consulta);
      if (consulta.sql.includes('from "cases"')) {
        const caso = h.casos[ctx.tenantId];
        return caso?.case_id === consulta.params[0] ? [caso] : [];
      }
      if (consulta.sql.includes('from "extracted_fields"')) return [{ field_key: "patente", field_value: "AB123CD", confidence: 0.9 }];
      return [{ doc_key: "denuncia_policial", requested_at: "2026-09-28T12:00:00.000000Z", satisfied_at: null, declined_at: null, declined_note: null }];
    });
  }),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));

import { requireRole } from "@/lib/auth/require-role";
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

function exportar(id = CASO) {
  return POST(new NextRequest(`http://localhost/api/cases/${id}/export-to-core`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  vi.mocked(requireRole).mockReset().mockResolvedValue({
    user: { id: USUARIO },
    userRow: { id: USUARIO, tenant_id: TENANT, role: "analyst", plan: "profesional" },
  });
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

  it("lee las tres cosas en un solo lote, con las fechas en ISO", async () => {
    await exportar();
    expect(h.consultas).toHaveLength(3);
    const [caso, , docs] = h.consultas;
    expect(caso.sql.match(/to_char/g)).toHaveLength(3);
    expect(docs.sql.match(/to_char/g)).toHaveLength(3);
  });

  it("un caso simulado también se exporta: el filtro de /api/v1 no aplica a mano", async () => {
    await exportar();
    expect(h.consultas[0].sql).not.toContain('"claim_messages"');
    expect(h.consultas[0].params).toEqual([CASO, 1]);
  });

  it("un caso de otro inquilino da 404", async () => {
    h.casos = { [OTRO]: FILA };
    const r = await exportar();
    expect(r.status).toBe(404);
    expect(h.contextos).toEqual([TENANT]);
  });

  it("un id que no es UUID da 400 sin tocar la base", async () => {
    expect((await exportar("no-es-un-id")).status).toBe(400);
    expect(requireRole).not.toHaveBeenCalled();
    expect(h.consultas).toEqual([]);
  });

  it("sin permiso da 403 sin tocar la base", async () => {
    vi.mocked(requireRole).mockRejectedValue(new AppError("FORBIDDEN_ROLE"));
    expect((await exportar()).status).toBe(403);
    expect(h.consultas).toEqual([]);
  });
});
