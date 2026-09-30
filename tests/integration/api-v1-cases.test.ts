// @vitest-environment node
/**
 * /api/v1: el sistema de la aseguradora lee con su clave, sin sesión (B5).
 *
 * La base es de mentira pero las consultas son las de verdad: `QueryBuilder`
 * arma lo que la ruta pediría y la base falsa contesta según la tabla y el
 * inquilino del contexto, que es lo que hace RLS. Así se ve con qué inquilino
 * se lee y que una clave mala no llega a la base.
 */

import { createHash } from "node:crypto";

import { QueryBuilder } from "drizzle-orm/pg-core";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Consulta = { toSQL(): { sql: string; params: unknown[] } };

const h = vi.hoisted(() => ({
  hashes: {} as Record<string, string>,
  casos: [] as Array<Record<string, unknown> & { tenant: string }>,
  falla: null as unknown,
  contextos: [] as string[],
  consultas: [] as string[],
}));

function contestar(tenantId: string, q: Consulta): unknown[] {
  const { sql, params } = q.toSQL();
  h.consultas.push(sql);
  if (sql.includes('"core_sync_settings"')) {
    return tenantId in h.hashes ? [{ hash: h.hashes[tenantId] }] : [];
  }
  const propios = h.casos.filter((c) => c.tenant === tenantId);
  if (sql.includes("count(*)")) return [{ n: propios.length }];
  if (sql.includes('from "cases"')) {
    const porId = sql.includes('"cases"."id" = $1') ? propios.filter((c) => c.case_id === params[0]) : propios;
    return porId.map(({ tenant: _, ...fila }) => fila);
  }
  return [];
}

vi.mock("@/data/scope", () => ({
  enTenant: vi.fn(async (ctx: { tenantId: string }, armar: (db: unknown) => Consulta) => {
    h.contextos.push(ctx.tenantId);
    if (h.falla) throw h.falla;
    return contestar(ctx.tenantId, armar(new QueryBuilder()));
  }),
  enTenantVarias: vi.fn(async (ctx: { tenantId: string }, armar: (db: unknown) => Consulta[]) => {
    h.contextos.push(ctx.tenantId);
    return armar(new QueryBuilder()).map((q) => contestar(ctx.tenantId, q));
  }),
}));

vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: vi.fn(),
  RATE_LIMIT_CONFIGS: { CORE_API: { limit: 120, windowMs: 60_000, lote: 5 } },
  getClientIp: () => "203.0.113.9",
}));

vi.mock("@/lib/security/compare", async (original) => {
  const real = await original<typeof import("@/lib/security/compare")>();
  return { timingSafeStringEqual: vi.fn(real.timingSafeStringEqual) };
});

import { enTenant } from "@/data/scope";
import { rateLimit } from "@/lib/rate-limit/index";
import { CANALES_REALES } from "@/lib/schemas/cases";
import { timingSafeStringEqual } from "@/lib/security/compare";
import { GET as listar } from "@/app/api/v1/cases/route";
import { GET as detalle } from "@/app/api/v1/cases/[id]/route";

// Los canales de una persona, en el orden en que el código los declara.
const CANALES_DEL_FILTRO = CANALES_REALES.map((c) => `'${c}'`).join(", ");

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const clave = (tenant: string, relleno = "k") => `cmk_${tenant}_${relleno.repeat(43)}`;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const CASO_A = "11111111-1111-4111-8111-111111111111";
const CASO_B = "22222222-2222-4222-8222-222222222222";

function pedir(ruta: string, autorizacion?: string) {
  return new NextRequest(`http://localhost${ruta}`, {
    headers: autorizacion === undefined ? {} : { Authorization: autorizacion },
  });
}

function detalleDe(id: string, autorizacion?: string) {
  return detalle(pedir(`/api/v1/cases/${id}`, autorizacion), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.mocked(rateLimit).mockReset().mockResolvedValue({
    allowed: true,
    remaining: 119,
    resetAt: Date.now() + 60_000,
    retryAfterSeconds: 0,
  } as never);
  vi.mocked(timingSafeStringEqual).mockClear();
  vi.mocked(enTenant).mockClear();
  h.hashes = { [A]: sha(clave(A)), [B]: sha(clave(B)) };
  h.casos = [
    { tenant: A, case_id: CASO_A, status: "listo_para_core", claim_type: "choque" },
    { tenant: B, case_id: CASO_B, status: "listo_para_core", claim_type: "robo" },
  ];
  h.falla = null;
  h.contextos = [];
  h.consultas = [];
});

describe("la clave", () => {
  it.each([
    ["sin Authorization", undefined],
    ["vacía", ""],
    ["sin Bearer", clave(A)],
    ["otro prefijo", `Bearer sk_${A}_${"k".repeat(43)}`],
    ["uuid en mayúsculas", `Bearer ${clave(A.toUpperCase())}`],
    ["cola corta", `Bearer cmk_${A}_${"k".repeat(42)}`],
    ["cola con caracteres de más", `Bearer ${clave(A)}=`],
  ])("%s da 401 sin tocar la base ni el cupo", async (_, autorizacion) => {
    const r = await listar(pedir("/api/v1/cases", autorizacion));
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe("Bearer");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect((await r.json()).error.code).toBe("INVALID_CREDENTIALS");
    expect(rateLimit).not.toHaveBeenCalled();
    expect(h.contextos).toEqual([]);
  });

  it("bien formada pero con otro secreto da 401", async () => {
    const r = await listar(pedir("/api/v1/cases", `Bearer ${clave(A, "x")}`));
    expect(r.status).toBe(401);
    expect(h.contextos).toEqual([A]);
  });

  it("la de B diciendo ser de A da 401: se compara contra el hash de A", async () => {
    h.hashes[B] = sha(clave(B, "b"));
    const r = await listar(pedir("/api/v1/cases", `Bearer ${clave(A, "b")}`));
    expect(r.status).toBe(401);
    expect(h.contextos).toEqual([A]);
  });

  it("sin fila igual compara en tiempo constante, contra un hash que ninguna clave da", async () => {
    delete h.hashes[A];
    const r = await listar(pedir("/api/v1/cases", `Bearer ${clave(A)}`));
    expect(r.status).toBe(401);
    expect(timingSafeStringEqual).toHaveBeenCalledWith(sha(clave(A)), "0".repeat(64));
  });

  it("revocada (hash null) da 401", async () => {
    h.hashes[A] = null as unknown as string;
    const r = await listar(pedir("/api/v1/cases", `Bearer ${clave(A)}`));
    expect(r.status).toBe(401);
    expect(timingSafeStringEqual).toHaveBeenCalledTimes(1);
  });

  it("sin la 0036 da 401, no 500", async () => {
    h.falla = Object.assign(new Error("Failed query"), { cause: { code: "42P01" } });
    const r = await listar(pedir("/api/v1/cases", `Bearer ${clave(A)}`));
    expect(r.status).toBe(401);
    expect(timingSafeStringEqual).toHaveBeenCalledTimes(1);
  });

  it("otro error de la base no se disfraza de 401", async () => {
    h.falla = Object.assign(new Error("Failed query"), { cause: { code: "57P01" } });
    await expect(listar(pedir("/api/v1/cases", `Bearer ${clave(A)}`))).rejects.toThrow("Failed query");
  });

  it("con el cupo agotado da 429 con Retry-After, antes de leer la base", async () => {
    vi.mocked(rateLimit).mockResolvedValue({ allowed: false, remaining: 0, resetAt: 0, retryAfterSeconds: 17 } as never);
    const r = await listar(pedir("/api/v1/cases", `Bearer ${clave(A)}`));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("17");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(h.contextos).toEqual([]);
    expect(rateLimit).toHaveBeenCalledWith("core-api:203.0.113.9", expect.objectContaining({ limit: 120 }));
  });
});

describe("GET /api/v1/cases", () => {
  it("con la clave de A lee como A y sólo ve los casos de A", async () => {
    const r = await listar(pedir("/api/v1/cases?per_page=5", `Bearer ${clave(A)}`));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const pagina = await r.json();
    expect(pagina.data.map((c: { case_id: string }) => c.case_id)).toEqual([CASO_A]);
    expect(pagina.meta).toEqual({ per_page: 5, has_more: false, next_cursor: expect.any(String) });
    expect(new Set(h.contextos)).toEqual(new Set([A]));
  });

  it("ordena por el último cambio y filtra updated_since con el mismo coalesce", async () => {
    await listar(pedir("/api/v1/cases?updated_since=2026-09-01T00:00:00Z&status=listo_para_core", `Bearer ${clave(A)}`));
    const pagina = h.consultas.find((s) => s.includes("order by"));
    expect(pagina).toMatch(/coalesce\("cases"\."updated_at", "cases"\."created_at"\) >= \$\d/);
    expect(pagina).toMatch(/order by coalesce\("cases"\."updated_at", "cases"\."created_at"\) asc, "cases"\."id" asc/);
  });

  it("las fechas salen en ISO UTC con microsegundos, y updated_since acepta ese formato de vuelta", async () => {
    const r = await listar(pedir("/api/v1/cases?updated_since=2026-09-28T14:03:11.123456Z", `Bearer ${clave(A)}`));
    expect(r.status).toBe(200);
    const pagina = h.consultas.find((s) => s.includes("order by"));
    for (const columna of ["created_at", "updated_at", "closed_at"]) {
      expect(pagina).toContain(`to_char("${columna}" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
    }
  });

  it("deja afuera simulados, contactos reservados y lo que cambió hace menos de dos minutos", async () => {
    await listar(pedir("/api/v1/cases", `Bearer ${clave(A)}`));
    const pagina = h.consultas.find((s) => s.includes("order by"));
    expect(pagina).toContain(`"cases"."channel" in (${CANALES_DEL_FILTRO})`);
    expect(pagina).toMatch(/not exists \(\s*select 1 from "claim_messages"/);
    expect(pagina).toContain(`coalesce("cases"."updated_at", "cases"."created_at") <= now() - interval '2 minutes'`);
  });

  it("pagina por cursor, no por OFFSET: el cursor es la posición de la última fila y vuelve aceptado", async () => {
    h.casos = [
      { tenant: A, case_id: CASO_A, created_at: "2026-09-28T14:00:00.000000Z", updated_at: "2026-09-28T14:03:11.123456Z" },
      { tenant: A, case_id: CASO_B, created_at: "2026-09-28T14:05:00.000000Z", updated_at: null },
    ];
    const primera = await (await listar(pedir("/api/v1/cases?per_page=1", `Bearer ${clave(A)}`))).json();
    expect(primera.data.map((c: { case_id: string }) => c.case_id)).toEqual([CASO_A]);
    expect(primera.meta.has_more).toBe(true);
    expect(Buffer.from(primera.meta.next_cursor, "base64url").toString()).toBe(`2026-09-28T14:03:11.123456Z|${CASO_A}`);

    h.consultas = [];
    const r = await listar(pedir(`/api/v1/cases?per_page=1&cursor=${primera.meta.next_cursor}`, `Bearer ${clave(A)}`));
    expect(r.status).toBe(200);
    const pagina = h.consultas.find((s) => s.includes("order by"));
    expect(pagina).toMatch(
      /\(coalesce\("cases"\."updated_at", "cases"\."created_at"\), "cases"\."id"\) > \(\$\d+::timestamptz, \$\d+::uuid\)/
    );
    expect(pagina).not.toMatch(/\boffset\b/i);
  });

  it("sin filas nuevas devuelve el mismo cursor, para seguir desde ahí", async () => {
    h.casos = [];
    const cursor = Buffer.from(`2026-09-28T14:03:11.123456Z|${CASO_A}`).toString("base64url");
    const r = await listar(pedir(`/api/v1/cases?cursor=${cursor}`, `Bearer ${clave(A)}`));
    expect((await r.json()).meta).toMatchObject({ has_more: false, next_cursor: cursor });
  });

  it("no expone el tenant ni columnas de fuera de export-to-core", async () => {
    await listar(pedir("/api/v1/cases", `Bearer ${clave(A)}`));
    const pagina = h.consultas.find((s) => s.includes("order by")) ?? "";
    expect(pagina).not.toContain('"tenant_id"');
    expect(pagina).not.toContain("core_error_message");
  });

  it.each([
    ["status desconocido", "status=otro"],
    ["updated_since sin zona", "updated_since=2026-09-01T00:00:00"],
    ["per_page de más", "per_page=1000"],
    ["cursor que no es base64 de fecha|id", "cursor=abc"],
    ["cursor con id que no es uuid", `cursor=${Buffer.from("2026-09-28T14:03:11Z|x").toString("base64url")}`],
  ])("%s da 400", async (_, query) => {
    const r = await listar(pedir(`/api/v1/cases?${query}`, `Bearer ${clave(A)}`));
    expect(r.status).toBe(400);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /api/v1/cases/:id", () => {
  it("un caso de A con la clave de A da 200 con campos y documentos", async () => {
    const r = await detalleDe(CASO_A, `Bearer ${clave(A)}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const caso = await r.json();
    expect(caso).toMatchObject({ case_id: CASO_A, extracted_fields: [], missing_docs: [] });
    expect(caso).not.toHaveProperty("_note");
    expect(caso).not.toHaveProperty("exported_by");
  });

  it("un caso de B con la clave de A da 404, igual que uno que no existe", async () => {
    const ajeno = await detalleDe(CASO_B, `Bearer ${clave(A)}`);
    const inexistente = await detalleDe("33333333-3333-4333-8333-333333333333", `Bearer ${clave(A)}`);
    expect(ajeno.status).toBe(404);
    expect(inexistente.status).toBe(404);
    expect(await ajeno.json()).toEqual(await inexistente.json());
  });

  it("un caso simulado o de prueba da 404: la consulta lleva el mismo filtro que la lista", async () => {
    await detalleDe(CASO_A, `Bearer ${clave(A)}`);
    const caso = h.consultas.find((s) => s.includes('from "cases"'));
    expect(caso).toContain(`"cases"."channel" in (${CANALES_DEL_FILTRO})`);
    expect(caso).toMatch(/not exists \(\s*select 1 from "claim_messages"/);
  });

  it("un id que no es uuid da 400", async () => {
    const r = await detalleDe("no-es-un-id", `Bearer ${clave(A)}`);
    expect(r.status).toBe(400);
  });

  it("sin clave da 401 sin leer nada", async () => {
    const r = await detalleDe(CASO_A);
    expect(r.status).toBe(401);
    expect(h.contextos).toEqual([]);
  });
});
