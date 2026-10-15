/**
 * /api/admin/core-sync: dónde y cómo se entrega el caso al sistema de la
 * aseguradora (B5). La fila de `core_sync_settings` vive en una base de
 * mentira que cumple el CHECK `activo_completo` de la 0036, así se ve qué
 * queda guardado —hash, cifrado— y que la clave rotada deja de entrar por
 * /api/v1 con la misma puerta que usa la ruta de verdad.
 */

import { createHash } from "node:crypto";

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/errors";

type Fila = Record<string, unknown>;
type Columnas = Record<string, { name: string }>;

const h = vi.hoisted(() => ({
  filas: {} as Record<string, Record<string, unknown>>,
  falla: null as unknown,
  tablas: [] as string[],
  syncCase: vi.fn(),
  configs: [] as unknown[],
}));

/** Lo mínimo de drizzle que usan la ruta y `_auth`, sobre `h.filas`. */
function baseFalsa(tenantId: string) {
  const nombreDe = (tabla: object) => (tabla as Record<symbol, string>)[Symbol.for("drizzle:Name")];
  const proyectar = (campos: Columnas, fila: Fila | undefined) =>
    fila ? [Object.fromEntries(Object.entries(campos).map(([k, col]) => [k, fila[col.name] ?? null]))] : [];
  return {
    select: (campos: Columnas) => ({
      from: (tabla: object) => {
        h.tablas.push(nombreDe(tabla));
        // Sin where: la fila la elige RLS, acá el inquilino del contexto.
        return Promise.resolve(proyectar(campos, h.filas[tenantId]));
      },
    }),
    insert: (tabla: object) => {
      h.tablas.push(nombreDe(tabla));
      return {
        values: (valores: Fila) => ({
          onConflictDoUpdate: ({ set }: { set: Fila }) => ({
            returning: async (campos: Columnas) => {
              const previa = h.filas[tenantId];
              const fila: Fila = previa
                ? { ...previa, ...quitarIndefinidos(set) }
                : { enabled: false, ...quitarIndefinidos(valores) };
              if (fila.enabled && (!fila.webhook_url || !fila.signing_secret_enc)) {
                throw Object.assign(new Error("Failed query"), { cause: { code: "23514" } });
              }
              h.filas[tenantId] = fila;
              return proyectar(campos, fila);
            },
          }),
        }),
      };
    },
  };
}

function quitarIndefinidos(o: Fila): Fila {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

vi.mock("@/data/scope", () => ({
  enTenant: vi.fn(async (ctx: { tenantId: string }, armar: (db: unknown) => unknown) => {
    if (h.falla) throw h.falla;
    return armar(baseFalsa(ctx.tenantId));
  }),
}));

vi.mock("@/lib/api/entrada", () => ({ entrar: vi.fn() }));

vi.mock("@/lib/audit/log", async (original) => ({
  ...(await original<typeof import("@/lib/audit/log")>()),
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: vi.fn(),
  RATE_LIMIT_CONFIGS: {
    SYNC_TO_CORE: { limit: 5, windowMs: 60_000 },
    CORE_API: { limit: 120, windowMs: 60_000, lote: 5 },
  },
  getClientIp: () => "203.0.113.9",
}));

vi.mock("@/server/core-sync/real", () => ({
  RealCoreSyncClient: class {
    syncCase = h.syncCase;
    constructor(config: unknown) {
      h.configs.push(config);
    }
  },
}));

import { entrar } from "@/lib/api/entrada";
import { ADMIN_ROLES } from "@/lib/auth/roles";
import { writeAuditLog } from "@/lib/audit/log";
import { rateLimit, RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { claveNueva } from "@/server/core-sync/clave";
import { descifrar } from "@/lib/security/cifrado";
import { autenticarClave } from "@/app/api/v1/_auth";
import { PATCH, POST } from "@/app/api/admin/core-sync/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const URL_CORE = "https://core.example.com/webhook";

function patch(body: unknown) {
  return PATCH(new NextRequest("http://localhost/api/admin/core-sync", { method: "PATCH", body: JSON.stringify(body) }));
}

function post(accion: string) {
  return POST(new NextRequest("http://localhost/api/admin/core-sync", { method: "POST", body: JSON.stringify({ accion }) }));
}

function entraCon(clave: string) {
  return autenticarClave(new Request("http://localhost/api/v1/cases", { headers: { Authorization: `Bearer ${clave}` } }));
}

const auditado = () => vi.mocked(writeAuditLog).mock.calls.map(([e]) => e as { event_type: string; payload: Fila });

beforeEach(() => {
  vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", "test-core-encryption-key");
  vi.mocked(entrar).mockReset().mockResolvedValue({
    ctx: { user: { id: "admin-1" }, userRow: { id: "admin-1", tenant_id: TENANT, role: "admin" } },
    rl: { allowed: true, remaining: 4, resetAt: 0, retryAfterSeconds: 0 },
  } as never);
  vi.mocked(rateLimit).mockReset().mockResolvedValue({ allowed: true, remaining: 4, resetAt: 0, retryAfterSeconds: 0 } as never);
  vi.mocked(writeAuditLog).mockClear();
  h.filas = {};
  h.falla = null;
  h.tablas = [];
  h.syncCase.mockReset();
  h.configs = [];
});

describe("la guarda", () => {
  it.each([
    ["no admin", "FORBIDDEN_ROLE", 403],
    ["sin sesión", "MISSING_SESSION", 401],
  ] as const)("%s da %s sin tocar la base", async (_, codigo, estado) => {
    vi.mocked(entrar).mockRejectedValue(new AppError(codigo));
    expect((await patch({ enabled: false })).status).toBe(estado);
    expect((await post("rotar-clave")).status).toBe(estado);
    expect(h.tablas).toEqual([]);
  });

  it("rol y cupo entran juntos por `entrar`, no uno detrás del otro", async () => {
    await patch({ enabled: false });
    await post("revocar-clave");
    expect(vi.mocked(entrar).mock.calls).toEqual([
      ["core-sync", RATE_LIMIT_CONFIGS.SYNC_TO_CORE, ...ADMIN_ROLES],
      ["core-sync", RATE_LIMIT_CONFIGS.SYNC_TO_CORE, ...ADMIN_ROLES],
    ]);
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it("el cupo agotado da 429 con Retry-After", async () => {
    vi.mocked(entrar).mockResolvedValue({
      ctx: { user: { id: "admin-1" }, userRow: { id: "admin-1", tenant_id: TENANT, role: "admin" } },
      rl: { allowed: false, remaining: 0, resetAt: 0, retryAfterSeconds: 42 },
    } as never);
    const r = await post("rotar-clave");
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("42");
    expect(h.tablas).toEqual([]);
  });
});

describe("PATCH", () => {
  it.each([
    "http://core.example.com/webhook",
    "https://93.184.216.34/webhook",
    "https://[::1]/webhook",
    "https://core.example.com:8443/webhook",
    "https://user:pass@core.example.com/webhook",
  ])("rechaza %s sin guardar", async (webhook_url) => {
    const r = await patch({ webhook_url });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatchObject({ code: "VALIDATION_FAILED", details: { motivo: "url" } });
    expect(h.tablas).toEqual([]);
  });

  it("no acepta otro inquilino en el cuerpo", async () => {
    const r = await patch({ webhook_url: URL_CORE, tenant_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    expect(r.status).toBe(400);
    expect(h.filas).toEqual({});
  });

  it("guarda la URL apagada y audita sólo booleanos", async () => {
    const r = await patch({ webhook_url: URL_CORE });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ webhook_url: URL_CORE, enabled: false });
    expect(h.filas[TENANT]).toMatchObject({ tenant_id: TENANT, webhook_url: URL_CORE, updated_by: "admin-1" });
    const [evento] = auditado();
    expect(evento.event_type).toBe("tenant.core_settings_changed");
    expect(Object.values(evento.payload).every((v) => typeof v === "boolean")).toBe(true);
    expect(JSON.stringify(evento.payload)).not.toContain("core.example.com");
  });

  it("prender sin secreto choca con el CHECK y da VALIDATION_FAILED", async () => {
    await patch({ webhook_url: URL_CORE });
    const r = await patch({ enabled: true });
    expect(r.status).toBe(400);
    const { error } = await r.json();
    expect(error).toMatchObject({ code: "VALIDATION_FAILED", details: { motivo: "incompleto" } });
    expect(error.message).toMatch(/secreto/);
    expect(h.filas[TENANT].enabled).toBe(false);
  });

  it("con URL y secreto se prende", async () => {
    await patch({ webhook_url: URL_CORE });
    await post("generar-secreto");
    const r = await patch({ enabled: true });
    expect(r.status).toBe(200);
    expect(h.filas[TENANT].enabled).toBe(true);
    expect(auditado().at(-1)?.payload).toEqual({ url_cambiada: false, enabled: true });
  });

  it("sin la 0036 dice que falta la migración", async () => {
    h.falla = Object.assign(new Error("Failed query"), { cause: { code: "42P01" } });
    const r = await patch({ webhook_url: URL_CORE });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatchObject({ message: expect.stringMatching(/0036/), details: { motivo: "migracion" } });
  });
});

describe("POST generar-secreto", () => {
  it("devuelve el secreto una vez, sin caché, y guarda sólo el cifrado", async () => {
    const r = await post("generar-secreto");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const { secreto } = await r.json();
    expect(secreto).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const guardado = String(h.filas[TENANT].signing_secret_enc);
    expect(guardado).not.toContain(secreto);
    expect(descifrar(guardado)).toBe(secreto);
    expect(JSON.stringify(auditado())).not.toContain(secreto);
  });
});

describe("POST rotar-clave y revocar-clave", () => {
  it("la clave sale una vez, se guarda su sha256 y entra por /api/v1", async () => {
    const r = await post("rotar-clave");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const { clave, prefijo } = await r.json();
    expect(clave).toMatch(new RegExp(`^cmk_${TENANT}_[A-Za-z0-9_-]{43}$`));
    expect(prefijo).toBe(clave.slice(-43, -35));

    const fila = h.filas[TENANT];
    expect(fila.api_key_hash).toBe(createHash("sha256").update(clave).digest("hex"));
    expect(fila.api_key_prefix).toBe(prefijo);
    expect(JSON.stringify(fila)).not.toContain(clave.slice(-43));
    expect(JSON.stringify(auditado())).not.toContain(clave.slice(-43));

    expect(await entraCon(clave)).toEqual({ tenantId: TENANT });
  });

  it("rotar de nuevo deja afuera la clave anterior", async () => {
    const vieja = (await (await post("rotar-clave")).json()).clave;
    const nueva = (await (await post("rotar-clave")).json()).clave;
    expect(nueva).not.toBe(vieja);
    expect(((await entraCon(vieja)) as Response).status).toBe(401);
    expect(await entraCon(nueva)).toEqual({ tenantId: TENANT });
  });

  it("revocar deja el hash en null y la clave deja de entrar", async () => {
    const { clave } = await (await post("rotar-clave")).json();
    const r = await post("revocar-clave");
    expect(r.status).toBe(200);
    expect(h.filas[TENANT]).toMatchObject({ api_key_hash: null, api_key_prefix: null });
    expect(((await entraCon(clave)) as Response).status).toBe(401);
    expect(auditado().at(-1)?.payload).toEqual({ clave_revocada: true });
  });
});

describe("POST probar-envio", () => {
  it("sin URL o sin secreto no envía", async () => {
    const r = await post("probar-envio");
    expect(r.status).toBe(400);
    expect((await r.json()).error.details).toEqual({ motivo: "incompleto" });
    await patch({ webhook_url: URL_CORE });
    expect((await post("probar-envio")).status).toBe(400);
    expect(h.syncCase).not.toHaveBeenCalled();
  });

  it("manda un payload de prueba, no toca casos y audita ok y motivo", async () => {
    await patch({ webhook_url: URL_CORE });
    const { secreto } = await (await post("generar-secreto")).json();
    h.syncCase.mockResolvedValue({ ok: false, motivo: "http_500" });
    h.tablas = [];

    const r = await post("probar-envio");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: false, motivo: "http_500" });
    expect(h.configs).toEqual([{ url: URL_CORE, secreto }]);
    expect(h.syncCase.mock.calls[0][0]).toMatchObject({ tenantId: TENANT, prueba: true, customerName: null });
    expect(h.tablas).toEqual(["core_sync_settings"]);
    const evento = auditado().at(-1)!;
    expect(evento.event_type).toBe("tenant.core_webhook_tested");
    expect(evento.payload).toEqual({ ok: false, motivo: "http_500" });
  });

  it("anda aunque el envío esté apagado", async () => {
    await patch({ webhook_url: URL_CORE });
    await post("generar-secreto");
    h.syncCase.mockResolvedValue({ ok: true, externalId: "X" });
    const r = await post("probar-envio");
    expect(await r.json()).toEqual({ ok: true, motivo: null });
    expect(h.filas[TENANT].enabled).toBe(false);
  });

  it("un secreto que ya no se descifra pide generar otro", async () => {
    await patch({ webhook_url: URL_CORE });
    await post("generar-secreto");
    vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", "test-other-encryption-key");
    const r = await post("probar-envio");
    expect(r.status).toBe(400);
    expect((await r.json()).error).toMatchObject({ message: expect.stringMatching(/generá otro/), details: { motivo: "secreto_ilegible" } });
    expect(h.syncCase).not.toHaveBeenCalled();
  });
});

it("una acción desconocida da 400", async () => {
  expect((await post("borrar-todo")).status).toBe(400);
  expect(h.tablas).toEqual([]);
});

describe("la clave de /api/v1", () => {
  // Un solo formato para quien la crea y quien la lee: si se separan, la clave
  // recién rotada da 401 y nadie lo ve hasta que el sistema del asegurador llama.
  it("la que arma `claveNueva` es la que acepta `autenticarClave`", async () => {
    const { clave, prefijo, hash } = claveNueva(TENANT);
    expect(clave).toMatch(new RegExp(`^cmk_${TENANT}_[A-Za-z0-9_-]{43}$`));
    expect(prefijo).toBe(clave.slice(-43, -35));
    h.filas[TENANT] = { api_key_hash: hash };
    expect(await entraCon(clave)).toEqual({ tenantId: TENANT });
  });
});
