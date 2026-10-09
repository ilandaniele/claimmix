// @vitest-environment node
/**
 * /api/admin/sso: el IdP de la aseguradora, la prueba del dominio y «exigir» (B19).
 *
 * La fila de `sso_settings` vive en una base de mentira que sólo sabe
 * proyectar lo que la ruta pide (`returning(CAMPOS_DE_LA_VISTA)`): si la ruta
 * pidiera el secreto cifrado, aparecería en la respuesta. Lo que la base de
 * mentira no puede evaluar —el `CASE` del PUT, el `EXISTS` del PATCH— se
 * comprueba dibujando el SQL con el dialecto de Postgres. El IdP, el DNS y el
 * cierre de sesiones están simulados: acá se prueba la ruta, no la red.
 */

import { NextRequest } from "next/server";
import { PgDialect } from "drizzle-orm/pg-core";
import { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "@/lib/errors";

type Fila = Record<string, unknown>;
type Columnas = Record<string, { name?: string }>;
type Llamada = { op: "select" | "insert" | "update"; tabla: string; values?: Fila; set?: Fila; where?: unknown };

const h = vi.hoisted(() => ({
  fila: undefined as Record<string, unknown> | undefined,
  afecta: true,
  falla: null as unknown,
  fallaDeLectura: null as unknown,
  llamadas: [] as unknown[],
  contextos: [] as unknown[],
  descubrir: vi.fn(),
  resolverTxt: vi.fn(),
  cerrarSesiones: vi.fn(),
}));

/** Lo mínimo de drizzle que usan la ruta y `panelSso`, sobre `h.fila`. */
function baseFalsa() {
  const nombreDe = (tabla: object) => (tabla as Record<symbol, string>)[Symbol.for("drizzle:Name")];
  const proyectar = (campos: Columnas): Fila[] =>
    h.fila
      ? [
          Object.fromEntries(
            Object.entries(campos).map(([k, col]) => [
              k,
              k === "tiene_secreto" ? h.fila!.client_secret_cifrado != null : (h.fila![col.name ?? ""] ?? null),
            ])
          ),
        ]
      : [];
  const escribe = (campos: Columnas) => {
    if (h.falla) throw h.falla;
    return h.afecta ? proyectar(campos) : [];
  };
  return {
    select: (campos: Columnas) => ({
      from: (tabla: object) => {
        h.llamadas.push({ op: "select", tabla: nombreDe(tabla) } satisfies Llamada);
        if (h.fallaDeLectura) return Promise.reject(h.fallaDeLectura);
        return Promise.resolve(proyectar(campos));
      },
    }),
    insert: (tabla: object) => ({
      values: (values: Fila) => ({
        onConflictDoUpdate: ({ set }: { set: Fila }) => ({
          returning: async (campos: Columnas) => {
            h.llamadas.push({ op: "insert", tabla: nombreDe(tabla), values, set } satisfies Llamada);
            return escribe(campos);
          },
        }),
      }),
    }),
    update: (tabla: object) => ({
      set: (set: Fila) => ({
        where: (where: unknown) => ({
          returning: async (campos: Columnas) => {
            h.llamadas.push({ op: "update", tabla: nombreDe(tabla), set, where } satisfies Llamada);
            return escribe(campos);
          },
        }),
      }),
    }),
  };
}

vi.mock("@/data/scope", () => ({
  enControl: vi.fn(async (ctx: unknown, armar: (db: unknown) => unknown) => {
    h.contextos.push(ctx);
    return armar(baseFalsa());
  }),
}));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/api/entrada", () => ({ entrar: vi.fn() }));

vi.mock("@/lib/audit/log", async (original) => ({
  ...(await original<typeof import("@/lib/audit/log")>()),
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/rate-limit/index", () => ({
  rateLimit: vi.fn(),
  RATE_LIMIT_CONFIGS: { SSO_ADMIN: { limit: 10, windowMs: 60_000 } },
  getClientIp: () => "203.0.113.9",
}));

vi.mock("@/server/sso/config", async (original) => ({
  ...(await original<typeof import("@/server/sso/config")>()),
  descubrir: h.descubrir,
}));

vi.mock("@/server/sso/dominio", async (original) => ({
  ...(await original<typeof import("@/server/sso/dominio")>()),
  resolverTxt: h.resolverTxt,
}));

vi.mock("@/server/sso/usuarios", () => ({ cerrarSesionesDelDominio: h.cerrarSesiones }));

import { entrar } from "@/lib/api/entrada";
import { ADMIN_ROLES } from "@/lib/auth/roles";
import { writeAuditLog } from "@/lib/audit/log";
import { logger } from "@/lib/observability/logger";
import { RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { descifrar } from "@/lib/security/cifrado";
import { registroDeVerificacion } from "@/server/sso/dominio";
import { GET, PATCH, POST, PUT } from "@/app/api/admin/sso/route";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTRO_TENANT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ISSUER = "https://idp.empresa.com";
const SECRETO = "super-secreto-del-idp-123";
const CIFRADO_GUARDADO = "CIFRADO-QUE-NO-SALE-NUNCA";

const ruta = "http://localhost/api/admin/sso";
const put = (body: unknown) => PUT(new NextRequest(ruta, { method: "PUT", body: JSON.stringify(body) }));
const post = (body: unknown = { accion: "verificar" }) => POST(new NextRequest(ruta, { method: "POST", body: JSON.stringify(body) }));
const patch = (body: unknown) => PATCH(new NextRequest(ruta, { method: "PATCH", body: JSON.stringify(body) }));

const auditado = () => vi.mocked(writeAuditLog).mock.calls.map(([e]) => e as { event_type: string; payload: Fila; tenant_id: string; actor_id: string });
const llamadas = () => h.llamadas as Llamada[];
const escrituras = () => llamadas().filter((l) => l.op !== "select");

const dialecto = new PgDialect();
/** El SQL de un fragmento, con sus parámetros, tal como viaja a Postgres. */
function dibujar(fragmento: unknown): { sql: string; params: unknown[] } {
  expect(fragmento).toBeInstanceOf(SQL);
  return dialecto.sqlToQuery(fragmento as SQL);
}

function guardada(parcial: Fila = {}) {
  h.fila = {
    tenant_id: TENANT,
    issuer: ISSUER,
    client_id: "cliente-1",
    client_secret_cifrado: CIFRADO_GUARDADO,
    dominio: "empresa.com",
    dominio_verificado_en: null,
    activo: false,
    exigir: false,
    ...parcial,
  };
}

const VERIFICADO = "2026-09-29T12:00:00.000Z";

async function cuerpo(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

beforeEach(() => {
  vi.stubEnv("GMAIL_TOKEN_ENCRYPTION_KEY", "test-sso-encryption-key");
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secreto-de-better-auth-con-largo-suficiente");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://claimmix.example.com");
  vi.mocked(entrar).mockReset().mockResolvedValue({
    ctx: { user: { id: "admin-1" }, userRow: { id: "admin-1", tenant_id: TENANT, role: "admin" } },
    rl: { allowed: true, remaining: 4, resetAt: 0, retryAfterSeconds: 0 },
  } as never);
  vi.mocked(writeAuditLog).mockClear();
  h.fila = undefined;
  h.afecta = true;
  h.falla = null;
  h.fallaDeLectura = null;
  h.llamadas = [];
  h.contextos = [];
  h.descubrir.mockReset().mockResolvedValue({ ok: true, datos: {} });
  h.resolverTxt.mockReset();
  h.cerrarSesiones.mockReset().mockResolvedValue(0);
});

describe("la guarda", () => {
  it.each([
    ["no admin", "FORBIDDEN_ROLE", 403],
    ["sin sesión", "MISSING_SESSION", 401],
  ] as const)("%s da %s en los cuatro métodos, sin tocar la base ni la red", async (_, codigo, estado) => {
    vi.mocked(entrar).mockRejectedValue(new AppError(codigo));
    const respuestas = [
      await GET(),
      await put({ issuer: ISSUER, client_id: "c", dominio: "empresa.com" }),
      await post(),
      await patch({ activo: true }),
    ];
    expect(respuestas.map((r) => r.status)).toEqual([estado, estado, estado, estado]);
    expect(h.llamadas).toEqual([]);
    expect(h.descubrir).not.toHaveBeenCalled();
    expect(h.resolverTxt).not.toHaveBeenCalled();
    expect(h.cerrarSesiones).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("rol y cupo entran juntos por `entrar`, con los roles de admin", async () => {
    guardada();
    await GET();
    await put({ issuer: ISSUER, client_id: "c", dominio: "empresa.com" });
    await post();
    await patch({ activo: false });
    const esperado = ["sso", RATE_LIMIT_CONFIGS.SSO_ADMIN, ...ADMIN_ROLES];
    expect(vi.mocked(entrar).mock.calls).toEqual([esperado, esperado, esperado, esperado]);
    expect(ADMIN_ROLES).toEqual(["owner", "admin"]);
  });

  it("con el cupo agotado responde 429 con Retry-After y no toca nada", async () => {
    vi.mocked(entrar).mockResolvedValue({
      ctx: { user: { id: "admin-1" }, userRow: { id: "admin-1", tenant_id: TENANT, role: "admin" } },
      rl: { allowed: false, remaining: 0, resetAt: 0, retryAfterSeconds: 7 },
    } as never);
    const respuestas = [
      await GET(),
      await put({ issuer: ISSUER, client_id: "c", dominio: "empresa.com" }),
      await post(),
      await patch({ activo: true }),
    ];
    for (const r of respuestas) {
      expect(r.status).toBe(429);
      expect(r.headers.get("Retry-After")).toBe("7");
    }
    expect(h.llamadas).toEqual([]);
    expect(h.descubrir).not.toHaveBeenCalled();
    expect(h.resolverTxt).not.toHaveBeenCalled();
  });
});

describe("GET", () => {
  it("sin nada configurado, el panel viene vacío y sin registro", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await cuerpo(res)).toEqual({
      issuer: null,
      client_id: null,
      dominio: null,
      dominio_verificado_en: null,
      activo: false,
      exigir: false,
      tiene_secreto: false,
      registro: null,
      url_de_vuelta: "https://claimmix.example.com/api/auth/sso-inquilino/callback",
      migracion_pendiente: false,
    });
    expect(llamadas()).toEqual([{ op: "select", tabla: "sso_settings" }]);
  });

  it("con config, dice que hay secreto pero nunca lo devuelve, ni cifrado", async () => {
    guardada();
    const res = await GET();
    const texto = JSON.stringify(await cuerpo(res));
    const panel = JSON.parse(texto);
    expect(panel.tiene_secreto).toBe(true);
    expect(panel.registro).toEqual(registroDeVerificacion(TENANT, "empresa.com"));
    expect(panel.registro.nombre).toBe("_claimmix.empresa.com");
    expect(panel.registro.valor).toMatch(/^claimmix-verificacion=[\w-]{43}$/);
    expect(texto).not.toContain(CIFRADO_GUARDADO);
    expect(Object.keys(panel).some((k) => k.startsWith("client_secret"))).toBe(false);
  });

  it("el inquilino sale de la sesión", async () => {
    await GET();
    expect(h.contextos).toEqual([{ tenantId: TENANT }]);
  });

  it.each(["42P01", "42703"])("falta la 0045 (%s): el panel avisa en lugar de fallar", async (code) => {
    h.fallaDeLectura = Object.assign(new Error("no existe"), { code });
    const res = await GET();
    expect(res.status).toBe(200);
    const panel = await cuerpo(res);
    expect(panel.migracion_pendiente).toBe(true);
    expect(panel.issuer).toBeNull();
  });

  it("cualquier otro error de la base sube como 500 sin detalles", async () => {
    h.fallaDeLectura = Object.assign(new Error("connection terminated password=hunter2"), { code: "08006" });
    const res = await GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await cuerpo(res))).not.toContain("hunter2");
  });
});

describe("PUT", () => {
  const cuerpoValido = { issuer: ISSUER, client_id: "cliente-1", client_secret: SECRETO, dominio: "  Empresa.COM " };

  it("guarda el IdP: el dominio normalizado, el secreto cifrado y el inquilino de la sesión", async () => {
    guardada();
    const res = await put(cuerpoValido);
    expect(res.status).toBe(200);

    expect(escrituras()).toHaveLength(1);
    const [escritura] = escrituras();
    expect(escritura.op).toBe("insert");
    expect(escritura.tabla).toBe("sso_settings");
    expect(escritura.values).toMatchObject({ tenant_id: TENANT, issuer: ISSUER, client_id: "cliente-1", dominio: "empresa.com" });
    expect(h.contextos).toEqual([{ tenantId: TENANT }]);
  });

  it("el secreto se guarda cifrado, distinto del texto plano, y se puede descifrar", async () => {
    guardada();
    await put(cuerpoValido);
    const guardado = String(escrituras()[0].values!.client_secret_cifrado);
    expect(guardado).not.toBe(SECRETO);
    expect(guardado).not.toContain(SECRETO);
    expect(descifrar(guardado)).toBe(SECRETO);
  });

  it("el secreto no vuelve en la respuesta, ni en la auditoría, ni en los parámetros en claro", async () => {
    guardada();
    const res = await put(cuerpoValido);
    const texto = JSON.stringify(await cuerpo(res));
    expect(texto).not.toContain(SECRETO);
    expect(texto).not.toContain(CIFRADO_GUARDADO);
    expect(JSON.parse(texto).tiene_secreto).toBe(true);

    const [evento] = auditado();
    expect(evento.event_type).toBe("sso.configurado");
    expect(evento.tenant_id).toBe(TENANT);
    expect(evento.actor_id).toBe("admin-1");
    expect(evento.payload).toEqual({ campos: ["issuer", "client_id", "dominio"], secreto_cambiado: true });
    expect(JSON.stringify(evento)).not.toContain(SECRETO);
  });

  it("pide el documento del IdP de nuevo, no el que estaba en memoria", async () => {
    guardada();
    await put(cuerpoValido);
    expect(h.descubrir).toHaveBeenCalledTimes(1);
    expect(h.descubrir).toHaveBeenCalledWith(ISSUER, { usarMemoria: false });
  });

  it("sin secreto nuevo no manda ninguno y lo registra así", async () => {
    guardada();
    const { client_secret: _omitido, ...sinSecreto } = cuerpoValido;
    const res = await put(sinSecreto);
    expect(res.status).toBe(200);
    expect(escrituras()[0].values!.client_secret_cifrado).toBeNull();
    expect(auditado()[0].payload.secreto_cambiado).toBe(false);
  });

  describe("lo que el ON CONFLICT decide en la base", () => {
    async function conjunto() {
      guardada();
      await put(cuerpoValido);
      const set = escrituras()[0].set!;
      return Object.fromEntries(Object.entries(set).map(([k, v]) => [k, v instanceof SQL ? dibujar(v).sql : v]));
    }

    it("conserva el secreto anterior sólo si el issuer y el client_id son los mismos", async () => {
      // Con el mismo issuer y otro client_id, el secreto viejo es de otra aplicación del mismo IdP.
      const set = await conjunto();
      expect(set.client_secret_cifrado).toBe(
        'case when ("sso_settings"."issuer" is not distinct from excluded.issuer and ' +
          '"sso_settings"."client_id" is not distinct from excluded.client_id) ' +
          'then coalesce(excluded.client_secret_cifrado, "sso_settings"."client_secret_cifrado") ' +
          "else excluded.client_secret_cifrado end"
      );
    });

    it("con otro issuer o con otro dominio, hay que volver a probar el dominio", async () => {
      const set = await conjunto();
      expect(set.dominio_verificado_en).toBe(
        'case when ("sso_settings"."issuer" is not distinct from excluded.issuer and ' +
          '"sso_settings"."dominio" is not distinct from excluded.dominio) ' +
          'then "sso_settings"."dominio_verificado_en" else null end'
      );
    });

    it("y con otro issuer, otro dominio u otro client_id se apagan el SSO y «exigir»", async () => {
      const set = await conjunto();
      const mismaConfig =
        '(("sso_settings"."issuer" is not distinct from excluded.issuer and ' +
        '"sso_settings"."dominio" is not distinct from excluded.dominio) and ' +
        '"sso_settings"."client_id" is not distinct from excluded.client_id)';
      expect(set.activo).toBe(`"sso_settings"."activo" and ${mismaConfig}`);
      expect(set.exigir).toBe(`"sso_settings"."exigir" and ${mismaConfig}`);
    });

    it("cambiar sólo el client_id no deja el secreto viejo ni conserva lo probado como vigente", async () => {
      // La misma comparación en las tres columnas: si una se olvidara de `client_id`, la aplicación
      // nueva heredaría el secreto, el «activo» o el «exigir» de la anterior.
      const set = await conjunto();
      for (const columna of ["client_secret_cifrado", "activo", "exigir"] as const) {
        expect(set[columna], columna).toContain('"sso_settings"."client_id" is not distinct from excluded.client_id');
      }
      expect(set.dominio_verificado_en).not.toContain("client_id");
    });

    it("lo demás se toma de lo propuesto, no del cuerpo crudo", async () => {
      const set = await conjunto();
      expect(set.issuer).toBe("excluded.issuer");
      expect(set.client_id).toBe("excluded.client_id");
      expect(set.dominio).toBe("excluded.dominio");
      expect(Object.keys(set).sort()).toEqual(
        ["activo", "actualizado_en", "client_id", "client_secret_cifrado", "dominio", "dominio_verificado_en", "exigir", "issuer"]
      );
    });
  });

  describe("lo que se rechaza sin escribir nada", () => {
    it.each([
      ["un proveedor de correo abierto", { dominio: "gmail.com" }, "dominio_publico"],
      ["un dominio con mayúsculas de un proveedor abierto", { dominio: "Outlook.COM" }, "dominio_publico"],
      ["algo sin forma de dominio", { dominio: "no es un dominio" }, "dominio_invalido"],
      ["un dominio sin punto", { dominio: "empresa" }, "dominio_invalido"],
      ["un mail en lugar del dominio", { dominio: "ana@empresa.com" }, "dominio_invalido"],
      ["un client_id vacío", { client_id: "  " }, "client_id_invalido"],
      ["un issuer vacío", { issuer: "" }, "issuer_invalido"],
    ] as const)("%s", async (_, cambio, motivo) => {
      const res = await put({ ...cuerpoValido, ...cambio });
      expect(res.status).toBe(400);
      const { error } = await cuerpo(res);
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.details.motivo).toBe(motivo);
      expect(h.llamadas).toEqual([]);
      expect(writeAuditLog).not.toHaveBeenCalled();
    });

    it("el dominio público se rechaza antes de pedirle nada al IdP", async () => {
      await put({ ...cuerpoValido, dominio: "gmail.com" });
      expect(h.descubrir).not.toHaveBeenCalled();
    });

    it.each([
      ["issuer_invalido", "https"],
      ["sin_respuesta", "no respondió"],
      ["documento_ilegible", "formato"],
      ["issuer_no_coincide", "no es el que cargaste"],
      ["endpoint_rechazado", "https"],
    ] as const)("si el IdP no pasa la revisión (%s), 400 con ese motivo", async (motivo, pista) => {
      h.descubrir.mockResolvedValue({ ok: false, motivo });
      const res = await put({ ...cuerpoValido, issuer: "http://10.0.0.5" });
      expect(res.status).toBe(400);
      const { error } = await cuerpo(res);
      expect(error.details.motivo).toBe(motivo);
      expect(error.message).toContain(pista);
      expect(h.llamadas).toEqual([]);
      expect(writeAuditLog).not.toHaveBeenCalled();
    });

    it("el inquilino no se elige desde el cuerpo: un `tenant_id` ajeno es un 400", async () => {
      const res = await put({ ...cuerpoValido, tenant_id: OTRO_TENANT });
      expect(res.status).toBe(400);
      expect(h.llamadas).toEqual([]);
    });

    it.each([
      ["un campo de más", { ...cuerpoValido, activo: true }],
      ["un cuerpo que no es JSON", "esto no es un objeto"],
      ["un cuerpo nulo", null],
    ])("%s", async (_, body) => {
      const res = await PUT(new NextRequest(ruta, { method: "PUT", body: typeof body === "string" ? body : JSON.stringify(body) }));
      expect(res.status).toBe(400);
      expect(h.llamadas).toEqual([]);
    });
  });

  it.each(["42P01", "42703"])("falta la 0045 (%s): 503 MIGRACION_PENDIENTE y nada auditado", async (code) => {
    h.falla = Object.assign(new Error("Failed query"), { cause: { code } });
    const res = await put(cuerpoValido);
    expect(res.status).toBe(503);
    expect((await cuerpo(res)).error.code).toBe("MIGRACION_PENDIENTE");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("otro error de la base sube como 500 sin filtrar el mensaje", async () => {
    h.falla = Object.assign(new Error(`falló con ${SECRETO}`), { code: "08006" });
    const res = await put(cuerpoValido);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await cuerpo(res))).not.toContain(SECRETO);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

describe("POST verificar", () => {
  const esperado = () => registroDeVerificacion(TENANT, "empresa.com").valor;

  it("sin migración, 503", async () => {
    h.fallaDeLectura = Object.assign(new Error("no existe"), { code: "42P01" });
    const res = await post();
    expect(res.status).toBe(503);
    expect(h.resolverTxt).not.toHaveBeenCalled();
  });

  it("sin dominio guardado, 409 sso_incompleto y no se pregunta al DNS", async () => {
    const res = await post();
    expect(res.status).toBe(409);
    const { error } = await cuerpo(res);
    expect(error.code).toBe("CONFLICT");
    expect(error.details.motivo).toBe("sso_incompleto");
    expect(h.resolverTxt).not.toHaveBeenCalled();
    expect(escrituras()).toEqual([]);
  });

  it("ya verificado: lo dice, sin DNS, sin escribir y sin auditar de nuevo", async () => {
    guardada({ dominio_verificado_en: VERIFICADO });
    const res = await post();
    const cuerpoRes = await cuerpo(res);
    expect(res.status).toBe(200);
    expect(cuerpoRes).toMatchObject({ verificado: true, motivo: null });
    expect(h.resolverTxt).not.toHaveBeenCalled();
    expect(escrituras()).toEqual([]);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("con el TXT correcto marca el dominio, sólo si sigue siendo el mismo, y lo audita", async () => {
    guardada();
    h.resolverTxt.mockResolvedValue({ ok: true, registros: [["v=spf1 -all"], [esperado()]] });
    const res = await post();
    const cuerpoRes = await cuerpo(res);

    expect(res.status).toBe(200);
    expect(cuerpoRes.verificado).toBe(true);
    expect(cuerpoRes.motivo).toBeNull();
    expect(h.resolverTxt).toHaveBeenCalledWith("_claimmix.empresa.com");

    expect(escrituras()).toHaveLength(1);
    const [escritura] = escrituras();
    expect(escritura.op).toBe("update");
    expect(Object.keys(escritura.set!).sort()).toEqual(["actualizado_en", "dominio_verificado_en"]);
    const donde = dibujar(escritura.where);
    expect(donde.sql).toBe('"sso_settings"."dominio" = $1');
    expect(donde.params).toEqual(["empresa.com"]);

    const [evento] = auditado();
    expect(evento.event_type).toBe("sso.dominio_verificado");
    expect(evento.payload).toEqual({ dominio: "empresa.com" });
  });

  it("un TXT largo, partido en trozos por el DNS, se une antes de comparar", async () => {
    guardada();
    const valor = esperado();
    h.resolverTxt.mockResolvedValue({ ok: true, registros: [[valor.slice(0, 30), valor.slice(30)]] });
    const res = await post();
    expect((await cuerpo(res)).verificado).toBe(true);
  });

  it.each([
    ["un valor cualquiera", [["claimmix-verificacion=otra-cosa"]]],
    ["sólo el prefijo", [["claimmix-verificacion="]]],
    ["el token de otro inquilino", [[registroDeVerificacion(OTRO_TENANT, "empresa.com").valor]]],
    ["el token de otro dominio del mismo inquilino", [[registroDeVerificacion(TENANT, "otra.com").valor]]],
    ["un registro vacío", [[]]],
    ["ningún registro", []],
  ])("con %s no se verifica y no se escribe ni se audita", async (_, registros) => {
    guardada();
    h.resolverTxt.mockResolvedValue({ ok: true, registros });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await cuerpo(res)).toMatchObject({ verificado: false, motivo: "no_coincide" });
    expect(escrituras()).toEqual([]);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it.each([
    ["el nombre no existe o no tiene TXT", "sin_registro"],
    ["el DNS no contestó a tiempo", "sin_respuesta"],
  ] as const)("cuando %s, el admin recibe «%s» y puede reintentar", async (_, motivo) => {
    guardada();
    h.resolverTxt.mockResolvedValue({ ok: false, motivo });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await cuerpo(res)).toMatchObject({ verificado: false, motivo });
    expect(escrituras()).toEqual([]);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("la respuesta trae el panel, sin secreto", async () => {
    guardada();
    h.resolverTxt.mockResolvedValue({ ok: false, motivo: "sin_registro" });
    const texto = JSON.stringify(await cuerpo(await post()));
    expect(texto).not.toContain(CIFRADO_GUARDADO);
    expect(JSON.parse(texto).panel.registro.nombre).toBe("_claimmix.empresa.com");
  });

  it("si otra aseguradora ya verificó ese dominio, 409 dominio_en_uso", async () => {
    guardada();
    h.resolverTxt.mockResolvedValue({ ok: true, registros: [[esperado()]] });
    h.falla = Object.assign(new Error("Failed query"), { cause: { code: "23505" } });
    const res = await post();
    expect(res.status).toBe(409);
    expect((await cuerpo(res)).error.details.motivo).toBe("dominio_en_uso");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("si el dominio cambió mientras se consultaba el DNS, el UPDATE no toca nada y es un 409", async () => {
    guardada();
    h.resolverTxt.mockResolvedValue({ ok: true, registros: [[esperado()]] });
    h.afecta = false;
    const res = await post();
    expect(res.status).toBe(409);
    expect((await cuerpo(res)).error.details.motivo).toBe("sso_incompleto");
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it.each([
    ["una acción que no existe", { accion: "borrar" }],
    ["un campo de más", { accion: "verificar", tenant_id: OTRO_TENANT }],
    ["un cuerpo vacío", {}],
  ])("%s es un 400", async (_, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(h.llamadas).toEqual([]);
  });
});

describe("PATCH", () => {
  it.each([
    ["nada para cambiar", {}],
    ["un campo de más", { activo: true, tenant_id: OTRO_TENANT }],
    ["exigir con el SSO apagado", { activo: false, exigir: true }],
    ["un valor que no es booleano", { activo: "si" }],
  ])("%s es un 400 y no toca la base", async (_, body) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(h.llamadas).toEqual([]);
    expect(h.cerrarSesiones).not.toHaveBeenCalled();
  });

  describe("prender el SSO", () => {
    it("pide la config completa y el dominio probado en el mismo UPDATE", async () => {
      guardada({ dominio_verificado_en: VERIFICADO, activo: true });
      const res = await patch({ activo: true });
      expect(res.status).toBe(200);

      expect(escrituras()).toHaveLength(1);
      const [escritura] = escrituras();
      expect(escritura.set).toMatchObject({ activo: true });
      expect("exigir" in escritura.set!).toBe(false);

      const donde = dibujar(escritura.where).sql;
      for (const columna of ["dominio_verificado_en", "issuer", "client_id", "client_secret_cifrado", "dominio"]) {
        expect(donde).toContain(`"sso_settings"."${columna}" is not null`);
      }
      expect(donde).not.toContain("exists");
      expect(h.cerrarSesiones).not.toHaveBeenCalled();
    });

    it("sin la config completa o sin el dominio probado, 409 sso_incompleto y sin auditar", async () => {
      h.afecta = false;
      const res = await patch({ activo: true });
      expect(res.status).toBe(409);
      const { error } = await cuerpo(res);
      expect(error.code).toBe("CONFLICT");
      expect(error.details.motivo).toBe("sso_incompleto");
      expect(writeAuditLog).not.toHaveBeenCalled();
    });

    it("lo audita con el estado que quedó", async () => {
      guardada({ dominio_verificado_en: VERIFICADO, activo: true });
      await patch({ activo: true });
      const [evento] = auditado();
      expect(evento.event_type).toBe("sso.exigido");
      expect(evento.payload).toEqual({ activo: true, exigir: false, sesiones_cerradas: 0 });
    });
  });

  describe("apagar el SSO", () => {
    it("apaga también «exigir» y no pone condiciones", async () => {
      guardada({ activo: false, exigir: false });
      const res = await patch({ activo: false });
      expect(res.status).toBe(200);
      const [escritura] = escrituras();
      expect(escritura.set).toMatchObject({ activo: false, exigir: false });
      expect(escritura.where).toBeUndefined();
      expect(h.cerrarSesiones).not.toHaveBeenCalled();
    });

    it("apagar «exigir» solo no cierra sesiones ni pide prueba", async () => {
      guardada({ activo: true, exigir: false, dominio_verificado_en: VERIFICADO });
      const res = await patch({ exigir: false });
      expect(res.status).toBe(200);
      const [escritura] = escrituras();
      expect(escritura.set).toMatchObject({ exigir: false });
      expect("activo" in escritura.set!).toBe(false);
      expect(escritura.where).toBeUndefined();
      expect(h.cerrarSesiones).not.toHaveBeenCalled();
    });
  });

  describe("exigir SSO", () => {
    beforeEach(() => guardada({ dominio_verificado_en: VERIFICADO, activo: true, exigir: true }));

    it("pide el SSO prendido y una cuenta que ya haya entrado por SSO en ese inquilino", async () => {
      await patch({ exigir: true });
      const [escritura] = escrituras();
      const donde = dibujar(escritura.where);
      expect(donde.sql).toContain('"sso_settings"."activo" = $1');
      expect(donde.params).toContain(true);
      expect(donde.sql).toContain(
        'exists (select 1 from "account" where ("account"."provider_id" = $2 and "account"."user_id" = $3))'
      );
    });

    it("la prueba es la cuenta SSO del admin que lo pide, en su inquilino, no la de cualquiera", async () => {
      // Regresión: bastaba que UNA persona cualquiera hubiera entrado por SSO. El admin, con su mail
      // local y sin cuenta SSO, podía exigir y quedarse afuera de su propia organización.
      await patch({ exigir: true });
      const donde = dibujar(escrituras()[0].where);

      expect(donde.params).toContain(`sso:${TENANT}`);
      expect(donde.params).toContain("admin-1");
      expect(donde.sql).not.toContain("tenant_id\"::text");
    });

    it("con la prueba, cierra las sesiones del dominio en su inquilino menos la del admin y dice cuántas", async () => {
      h.cerrarSesiones.mockResolvedValue(3);
      const res = await patch({ exigir: true });
      const cuerpoRes = await cuerpo(res);

      expect(res.status).toBe(200);
      expect(h.cerrarSesiones).toHaveBeenCalledTimes(1);
      expect(h.cerrarSesiones).toHaveBeenCalledWith(TENANT, "empresa.com", "admin-1");
      expect(cuerpoRes.sesiones_cerradas).toBe(3);
      expect(cuerpoRes.panel.exigir).toBe(true);
      expect(auditado()[0].payload).toEqual({ activo: true, exigir: true, sesiones_cerradas: 3 });
    });

    it("prender y exigir juntos tampoco saltea la prueba de que alguien entró", async () => {
      await patch({ activo: true, exigir: true });
      const [escritura] = escrituras();
      expect(escritura.set).toMatchObject({ activo: true, exigir: true });
      const donde = dibujar(escritura.where).sql;
      expect(donde).toContain("exists (select 1 from");
      expect(donde).toContain('"sso_settings"."dominio" is not null');
    });

    it("sin ninguna cuenta que haya entrado por SSO: 409 sso_sin_prueba, sin cerrar sesiones ni auditar", async () => {
      h.afecta = false;
      const res = await patch({ exigir: true });
      expect(res.status).toBe(409);
      const { error } = await cuerpo(res);
      expect(error.code).toBe("CONFLICT");
      expect(error.details.motivo).toBe("sso_sin_prueba");
      expect(h.cerrarSesiones).not.toHaveBeenCalled();
      expect(writeAuditLog).not.toHaveBeenCalled();
    });

    it("si cerrar las sesiones falla, «exigir» ya quedó prendido: 200, `null` y nada del error en la respuesta", async () => {
      h.cerrarSesiones.mockRejectedValue(new Error(`connection terminated ${SECRETO}`));
      const registrar = vi.spyOn(logger, "error").mockImplementation(() => undefined);

      const res = await patch({ exigir: true });
      const cuerpoRes = await cuerpo(res);

      expect(res.status).toBe(200);
      expect(cuerpoRes.sesiones_cerradas).toBeNull();
      expect(JSON.stringify(cuerpoRes)).not.toContain(SECRETO);
      expect(auditado()[0].payload.sesiones_cerradas).toBeNull();
      expect(registrar).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(registrar.mock.calls)).not.toContain(SECRETO);
      registrar.mockRestore();
    });
  });

  it.each(["42P01", "42703"])("falta la 0045 (%s): 503", async (code) => {
    h.falla = Object.assign(new Error("Failed query"), { cause: { code } });
    const res = await patch({ activo: false });
    expect(res.status).toBe(503);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it("el inquilino sale de la sesión, y no hay secreto en ninguna respuesta", async () => {
    guardada({ dominio_verificado_en: VERIFICADO, activo: true });
    const res = await patch({ activo: true });
    expect(h.contextos).toEqual([{ tenantId: TENANT }]);
    expect(JSON.stringify(await cuerpo(res))).not.toContain(CIFRADO_GUARDADO);
    expect(auditado()[0].tenant_id).toBe(TENANT);
  });
});
