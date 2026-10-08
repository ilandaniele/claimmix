/**
 * El panel del operador: lo que escribe sobre las altas y con qué cuidado.
 *
 * Tres cosas que no se pueden romper sin que nadie lo note:
 *   - conectar un número NO se arma con lo que se tipeó sino con lo que Graph
 *     confirma, y un id de otro cliente, de la plataforma o dado de baja hace poco
 *     no se conecta (H20). La base y Graph son dobles; lo que se prueba es qué se
 *     pregunta, qué se escribe y qué NO se escribe.
 *   - cada acción es UNA sentencia con su asiento de auditoría adentro y con los
 *     ids por parámetro, nunca pegados al texto.
 *   - sin la 0048 aplicada todo avisa «falta la migración» en vez de reventar.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({ execute: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { execute: h.execute } }));
vi.mock("@/data/scope", () => ({ enTenant: vi.fn() }));
vi.mock("@/server/alta/crear-inquilino", () => ({ topeGlobalDelDia: () => 20 }));

import { AuditEvent } from "@/lib/audit/log";
import { PLAN_CATALOG } from "@/lib/billing/plans";
import { enUSServidor } from "@/lib/i18n/en-US.servidor";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";
import {
  RESULTADOS_DEL_PANEL,
  activarInquilino,
  conectarNumero,
  darDeBajaNumero,
  extenderPrueba,
  listarAltas,
  reactivarInquilino,
  reactivarNumero,
  resultadoDelPanel,
  suspenderInquilino,
  suspenderNumero,
  terminosDeActivacion,
  type Operador,
} from "@/server/alta/panel-operador";

const dialecto = new PgDialect();

const SAVED = { ...process.env };

const OP: Operador = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ip: "203.0.113.9" };
const CLIENTE = "22222222-2222-4222-8222-222222222222";
const PLATAFORMA = "33333333-3333-4333-8333-333333333333";
const NUMERO = "44444444-4444-4444-8444-444444444444";

const ID_PLATAFORMA = "100000000000001";
const WABA = "200000000000001";
const ID_DEL_CLIENTE = "100000000000777";
const E164_DEL_CLIENTE = "+5491100000000";

/** Lo que `db.execute` recibió en la llamada `n` (la última por omisión), ya convertido a texto SQL y parámetros. */
function consulta(n = h.execute.mock.calls.length - 1) {
  return dialecto.sqlToQuery(h.execute.mock.calls[n][0]);
}

const filas = (...rows: Array<Record<string, unknown>>) => ({ rows });

beforeEach(() => {
  h.execute.mockReset();
  process.env.WHATSAPP_ACCESS_TOKEN = "fake-access-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = ID_PLATAFORMA;
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = WABA;
  process.env.WHATSAPP_TENANT_ID = PLATAFORMA;
});

afterEach(() => {
  process.env = { ...SAVED };
  vi.unstubAllGlobals();
});

// ── Graph ───────────────────────────────────────────────────────────────────

interface Graph {
  display?: string;
  idsDeLaWaba?: string[];
  estadoDelNumero?: number;
  estadoDeLaWaba?: number;
}

/** Un Graph de juguete: contesta el número y la lista de números de la WABA, y deja las URLs que le pidieron. */
function graph(cfg: Graph = {}) {
  const pedidos: string[] = [];
  const respuesta = (cuerpo: unknown, status = 200) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => cuerpo }) as Response;
  const fetchFalso = vi.fn(async (url: string) => {
    pedidos.push(url);
    if (url.includes("/phone_numbers")) {
      return respuesta({ data: (cfg.idsDeLaWaba ?? [ID_DEL_CLIENTE]).map((id) => ({ id })) }, cfg.estadoDeLaWaba ?? 200);
    }
    return respuesta(
      { display_phone_number: cfg.display ?? "+54 9 11 0000-0000", verified_name: "Seguros Fake" },
      cfg.estadoDelNumero ?? 200
    );
  });
  vi.stubGlobal("fetch", fetchFalso);
  return { pedidos, fetchFalso };
}

/** La base: primero devuelve el número pedido y luego lo que diga `escritura` (una fila, o un error). */
function base(opts: { pedido?: Record<string, unknown> | null; escritura?: Record<string, unknown> | Error } = {}) {
  const pedido = opts.pedido === undefined ? { tenant_id: CLIENTE, numero_e164: E164_DEL_CLIENTE } : opts.pedido;
  h.execute.mockResolvedValueOnce(filas(...(pedido ? [pedido] : [])));
  const escritura = opts.escritura ?? { resultado: "ok" };
  if (escritura instanceof Error) h.execute.mockRejectedValueOnce(escritura);
  else h.execute.mockResolvedValueOnce(filas(escritura));
}

const pedirConexion = (parcial: Partial<{ phoneNumberId: string; wabaId: string }> = {}) =>
  conectarNumero(
    { numeroId: NUMERO, phoneNumberId: ID_DEL_CLIENTE, wabaId: WABA, pruebaDeControl: true, ...parcial },
    OP
  );

const errorPg = (code: string) => Object.assign(new Error("pg"), { code });

// ── conectarNumero ──────────────────────────────────────────────────────────

describe("conectarNumero", () => {
  it("conecta cuando Graph confirma el número, el id en la WABA, y escribe todo en una sentencia con su asiento", async () => {
    const g = graph();
    base();

    expect(await pedirConexion()).toBe("ok");

    expect(g.pedidos).toHaveLength(2);
    expect(h.execute).toHaveBeenCalledTimes(2);
    const q = consulta();
    expect(q.sql).toContain("insert into public.audit_log");
    expect(q.sql).toContain("update public.whatsapp_numeros");
    expect(q.params).toEqual(expect.arrayContaining([ID_DEL_CLIENTE, WABA, NUMERO, OP.userId, OP.ip, AuditEvent.WHATSAPP_NUMERO_CONECTADO]));
    // Los ids viajan por parámetro, no pegados al texto.
    expect(q.sql).not.toContain(ID_DEL_CLIENTE);
    expect(q.sql).not.toContain(NUMERO);
    expect(String(q.params.find((p) => String(p).includes("prueba_de_control")))).toContain('"prueba_de_control":true');
  });

  it("lo que Graph dice ya con el 9 o sin él es el mismo número", async () => {
    graph({ display: "+54 11 0000-0000" });
    base();
    expect(await pedirConexion()).toBe("ok");
  });

  it("H20: el display_phone_number de Graph es otro número: no escribe nada", async () => {
    graph({ display: "+54 9 11 0000-0001" });
    base();

    expect(await pedirConexion()).toBe("numero_distinto");
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("H20: el id no figura entre los números de la WABA: no escribe nada", async () => {
    graph({ idsDeLaWaba: ["100000000000888", "100000000000999"] });
    base();

    expect(await pedirConexion()).toBe("fuera_de_la_waba");
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("H20: la WABA tipeada no es la del entorno: ni siquiera le pregunta a Meta", async () => {
    const g = graph();
    base();

    expect(await pedirConexion({ wabaId: "200000000000999" })).toBe("waba_distinta");
    expect(g.fetchFalso).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("H20: el id de la plataforma en el espacio de otro cliente: denegado antes de preguntarle a Meta", async () => {
    const g = graph();
    base();

    expect(await pedirConexion({ phoneNumberId: ID_PLATAFORMA })).toBe("id_de_la_plataforma");
    expect(g.fetchFalso).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("el id de la plataforma sí puede ir al espacio de la plataforma", async () => {
    graph({ idsDeLaWaba: [ID_PLATAFORMA] });
    base({ pedido: { tenant_id: PLATAFORMA.toUpperCase(), numero_e164: E164_DEL_CLIENTE } });

    expect(await pedirConexion({ phoneNumberId: ID_PLATAFORMA })).toBe("ok");
  });

  it("un id que figura en NUMEROS_DE_DEV es del otro ambiente: denegado antes de preguntarle a Meta ni escribir", async () => {
    process.env.NUMEROS_DE_DEV = `${ID_DEL_CLIENTE}, 100000000000555`;
    const g = graph();
    base();

    expect(await pedirConexion()).toBe("de_otro_ambiente");
    expect(g.fetchFalso).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("el número pedido figura en NUMEROS_DE_DEV, con o sin el 9: también es del otro ambiente", async () => {
    process.env.NUMEROS_DE_DEV = "+541100000000";
    const g = graph();
    base();

    expect(await pedirConexion()).toBe("de_otro_ambiente");
    expect(g.fetchFalso).not.toHaveBeenCalled();
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("con NUMEROS_DE_DEV sin ese id ni ese número, conecta como siempre", async () => {
    process.env.NUMEROS_DE_DEV = "100000000000555,+541112345678";
    graph();
    base();

    expect(await pedirConexion()).toBe("ok");
  });

  it("H20: un id dado de baja en otro espacio hace menos de 30 días está en cuarentena", async () => {
    graph();
    base({ escritura: { resultado: "en_cuarentena" } });

    expect(await pedirConexion()).toBe("en_cuarentena");
    // La cuarentena se mira dentro de la sentencia que escribe, con sus 30 días por parámetro.
    const q = consulta();
    expect(q.sql).toContain("q.estado = 'baja' and q.tenant_id <> f.tenant_id");
    expect(q.params).toContain(30);
  });

  it("H3: otro espacio ya tiene el mismo número vivo: no se conecta", async () => {
    graph();
    base({ escritura: { resultado: "numero_duplicado" } });

    expect(await pedirConexion()).toBe("numero_duplicado");
    expect(consulta().sql).toContain("q.estado <> 'baja'");
  });

  it("una conexión que ya no está en «pedido» no aplica", async () => {
    graph();
    base({ escritura: { resultado: "no_aplica" } });
    expect(await pedirConexion()).toBe("no_aplica");
  });

  it("23505 del índice único: «ese número ya está en otro espacio», venga como venga el error", async () => {
    graph();
    base({ escritura: errorPg("23505") });
    expect(await pedirConexion()).toBe("id_ocupado");

    graph();
    base({ escritura: Object.assign(new Error("neon"), { cause: { code: "23505" } }) });
    expect(await pedirConexion()).toBe("id_ocupado");
  });

  it("un número que no está en «pedido» (o no es de un alta) no aplica y no se le pregunta a Meta", async () => {
    const g = graph();
    base({ pedido: null });

    expect(await pedirConexion()).toBe("no_aplica");
    expect(g.fetchFalso).not.toHaveBeenCalled();
    expect(consulta(0).sql).toContain("x.autoalta");
  });

  it("ids sin forma de id de Meta: datos_invalidos, sin tocar la base ni Graph", async () => {
    const g = graph();

    expect(await pedirConexion({ phoneNumberId: "12ab" })).toBe("datos_invalidos");
    expect(await pedirConexion({ phoneNumberId: "../" + ID_DEL_CLIENTE })).toBe("datos_invalidos");
    expect(await pedirConexion({ wabaId: "" })).toBe("datos_invalidos");
    expect(await pedirConexion({ wabaId: "1".repeat(21) })).toBe("datos_invalidos");
    expect(g.fetchFalso).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("sin credencial de la plataforma no hay con qué verificar, y no se conecta", async () => {
    delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    graph();
    base();

    expect(await pedirConexion()).toBe("sin_credencial");
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("Graph dice que el id no existe (4xx) o no contesta (5xx): no se conecta, y no es lo mismo", async () => {
    graph({ estadoDelNumero: 400 });
    base();
    expect(await pedirConexion()).toBe("id_inexistente");

    graph({ estadoDelNumero: 503 });
    base();
    expect(await pedirConexion()).toBe("meta_no_responde");

    graph({ estadoDeLaWaba: 500 });
    base();
    expect(await pedirConexion()).toBe("meta_no_responde");
  });

  it("sin la 0048 avisa que falta, al leer o al escribir", async () => {
    graph();
    h.execute.mockRejectedValueOnce(errorPg("42P01"));
    expect(await pedirConexion()).toBe("migracion_pendiente");

    base({ escritura: errorPg("42703") });
    expect(await pedirConexion()).toBe("migracion_pendiente");
  });

  it("un error de la base que no es de la 0048 sube, no se disfraza", async () => {
    graph();
    base({ escritura: errorPg("XX000") });
    await expect(pedirConexion()).rejects.toMatchObject({ code: "XX000" });
  });
});

// ── Las acciones de una sentencia ───────────────────────────────────────────

const ACCIONES = [
  {
    nombre: "suspenderNumero",
    correr: () => suspenderNumero(NUMERO, OP),
    id: NUMERO,
    evento: AuditEvent.WHATSAPP_NUMERO_SUSPENDIDO,
    escribe: "update public.whatsapp_numeros",
    objetivo: "whatsapp_numero",
    sobreAltas: "x.autoalta",
  },
  {
    nombre: "reactivarNumero",
    correr: () => reactivarNumero(NUMERO, OP),
    id: NUMERO,
    evento: AuditEvent.WHATSAPP_NUMERO_CONECTADO,
    escribe: "update public.whatsapp_numeros",
    objetivo: "whatsapp_numero",
    sobreAltas: "x.autoalta",
  },
  {
    nombre: "darDeBajaNumero",
    correr: () => darDeBajaNumero(NUMERO, OP),
    id: NUMERO,
    evento: AuditEvent.WHATSAPP_NUMERO_BAJA,
    escribe: "update public.whatsapp_numeros",
    objetivo: "whatsapp_numero",
    sobreAltas: "x.autoalta",
  },
  {
    nombre: "suspenderInquilino",
    correr: () => suspenderInquilino(CLIENTE, OP),
    id: CLIENTE,
    evento: AuditEvent.TENANT_SUSPENDED,
    escribe: "update public.tenants",
    objetivo: "tenant",
    sobreAltas: "t.autoalta",
  },
  {
    nombre: "reactivarInquilino",
    correr: () => reactivarInquilino(CLIENTE, OP),
    id: CLIENTE,
    evento: AuditEvent.TENANT_SUSPENDED,
    escribe: "update public.tenants",
    objetivo: "tenant",
    sobreAltas: "t.autoalta",
  },
  {
    nombre: "extenderPrueba",
    correr: () => extenderPrueba(CLIENTE, 14, OP),
    id: CLIENTE,
    evento: AuditEvent.TENANT_PLAN_CHANGED,
    escribe: "update public.tenants",
    objetivo: "tenant",
    sobreAltas: "t.autoalta",
  },
  {
    nombre: "activarInquilino",
    correr: () => activarInquilino(CLIENTE, terminosDeActivacion("piloto")!, OP),
    id: CLIENTE,
    evento: AuditEvent.TENANT_PLAN_CHANGED,
    escribe: "update public.tenants",
    objetivo: "tenant",
    sobreAltas: "t.autoalta",
  },
];

describe.each(ACCIONES)("$nombre", (a) => {
  it("es una sola sentencia con su asiento de auditoría, el actor, la IP y el id por parámetro", async () => {
    h.execute.mockResolvedValue(filas({ n: 1 }));

    expect(await a.correr()).toBe("ok");

    expect(h.execute).toHaveBeenCalledTimes(1);
    const q = consulta();
    expect(q.sql).toContain(a.escribe);
    expect(q.sql).toContain("insert into public.audit_log");
    expect(q.sql).toContain(a.sobreAltas);
    expect(q.params).toEqual(expect.arrayContaining([a.id, OP.userId, OP.ip, a.evento, a.objetivo]));
    expect(q.sql).not.toContain(a.id);
    expect(q.sql).not.toContain(OP.userId);
  });

  it("si no cambió ninguna fila (otro estado, otro espacio, no es un alta) es no_aplica, no un error", async () => {
    h.execute.mockResolvedValue(filas({ n: 0 }));
    expect(await a.correr()).toBe("no_aplica");
  });

  it("sin la 0048 devuelve migracion_pendiente, y otro error sube", async () => {
    h.execute.mockRejectedValueOnce(errorPg("42883"));
    expect(await a.correr()).toBe("migracion_pendiente");

    h.execute.mockRejectedValueOnce(errorPg("57014"));
    await expect(a.correr()).rejects.toMatchObject({ code: "57014" });
  });
});

describe("reglas de cada acción", () => {
  it("reactivar un número exige que ya tenga sus ids: uno sin conectar nunca se «reactiva»", async () => {
    h.execute.mockResolvedValue(filas({ n: 0 }));
    await reactivarNumero(NUMERO, OP);
    const { sql } = consulta();
    expect(sql).toContain("w.estado = 'suspendido'");
    expect(sql).toContain("w.phone_number_id is not null and w.waba_id is not null");
  });

  it("dar de baja no borra: la sentencia actualiza el estado y no hay ningún delete", async () => {
    h.execute.mockResolvedValue(filas({ n: 1 }));
    await darDeBajaNumero(NUMERO, OP);
    const { sql } = consulta();
    expect(sql).toContain("set estado = 'baja'");
    expect(sql.toLowerCase()).not.toContain("delete");
    expect(sql).toContain("actualizado_en = now()");
  });

  it("suspender un espacio sólo parte de prueba o activo; reactivar sólo desde suspendido", async () => {
    h.execute.mockResolvedValue(filas({ n: 1 }));
    await suspenderInquilino(CLIENTE, OP);
    expect(consulta().sql).toContain("t.billing_status in ('trial', 'active')");

    await reactivarInquilino(CLIENTE, OP);
    const { sql } = consulta();
    expect(sql).toContain("t.billing_status = 'suspended'");
    // Vuelve a active si alguna vez se activó (pagó) y a trial si nunca.
    expect(sql).toContain("case when t.activated_at is not null then 'active' else 'trial' end");
  });

  it("activar sólo toca un espacio en prueba o activo, marca activated_at una vez y deja el plan anterior en el asiento", async () => {
    h.execute.mockResolvedValue(filas({ n: 1 }));
    await activarInquilino(CLIENTE, terminosDeActivacion("piloto", { cuota: "199.5", incluidas: "300" })!, OP);
    const q = consulta();
    expect(q.sql).toContain("billing_status = 'active'");
    expect(q.sql).toContain("activated_at = coalesce(t.activated_at, now())");
    expect(q.sql).toContain("t.billing_status in ('trial', 'active')");
    expect(q.sql).toContain("plan_anterior");
    expect(q.params).toEqual(expect.arrayContaining(["piloto", "199.5", 300]));
  });

  it("H4: extender la prueba entre 1 y 90 días enteros, y nada fuera de eso toca la base", async () => {
    for (const dias of [0, -3, 91, 365, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await extenderPrueba(CLIENTE, dias, OP)).toBe("no_aplica");
    }
    expect(h.execute).not.toHaveBeenCalled();

    h.execute.mockResolvedValue(filas({ n: 1 }));
    expect(await extenderPrueba(CLIENTE, 90, OP)).toBe("ok");
    expect(consulta().params).toContain(90);
    // Sólo la alarga y sólo en prueba.
    expect(consulta().sql).toContain("t.billing_status = 'trial'");
    expect(consulta().sql).toContain("t.trial_ends_at < now()");
  });
});

// ── terminosDeActivacion ────────────────────────────────────────────────────

describe("terminosDeActivacion", () => {
  it("sin nada a mano usa los términos del catálogo", () => {
    const base = PLAN_CATALOG.piloto;
    expect(terminosDeActivacion("piloto")).toEqual({
      plan: "piloto",
      monthly_fee_usd: String(base.monthly_fee_usd),
      included_claims: base.included_claims,
      overage_price_usd: String(base.overage_price_usd),
    });
  });

  it("lo que el operador pisa a mano gana, y lo vacío no pisa", () => {
    expect(terminosDeActivacion("piloto", { cuota: " 150.25 ", incluidas: "40", excedente: "0.5" })).toMatchObject({
      monthly_fee_usd: "150.25",
      included_claims: 40,
      overage_price_usd: "0.5",
    });
    expect(terminosDeActivacion("piloto", { cuota: "", incluidas: " ", excedente: "" })).toMatchObject({
      included_claims: PLAN_CATALOG.piloto.included_claims,
    });
  });

  it("un plan que no existe, o un número que no es un número razonable, es null", () => {
    expect(terminosDeActivacion("platino")).toBeNull();
    expect(terminosDeActivacion(undefined)).toBeNull();
    expect(terminosDeActivacion("piloto", { cuota: "1e5" })).toBeNull();
    expect(terminosDeActivacion("piloto", { cuota: "-10" })).toBeNull();
    expect(terminosDeActivacion("piloto", { cuota: "10; drop table tenants" })).toBeNull();
    expect(terminosDeActivacion("piloto", { excedente: "1.23456" })).toBeNull();
    expect(terminosDeActivacion("piloto", { incluidas: "1.5" })).toBeNull();
    expect(terminosDeActivacion("piloto", { incluidas: "-1" })).toBeNull();
    expect(terminosDeActivacion("piloto", { incluidas: "10000001" })).toBeNull();
  });
});

// ── La lista ────────────────────────────────────────────────────────────────

describe("listarAltas", () => {
  it("lee todo en UNA consulta y arma cada fila con su número, la marca de revisión y los otros titulares", async () => {
    h.execute.mockResolvedValue(
      filas(
        {
          creadas_24h: 2,
          tenant_id: CLIENTE,
          nombre: "Seguros Fake",
          contact_email: "contacto@fake.example.com",
          created_at: new Date("2026-10-07T12:00:00Z"),
          plan: "piloto",
          billing_status: "trial",
          trial_ends_at: "2026-10-21T12:00:00.000Z",
          activated_at: null,
          numero_id: NUMERO,
          numero_e164: E164_DEL_CLIENTE,
          numero_estado: "pedido",
          phone_number_id: null,
          waba_id: null,
          numero_en_revision: false,
          repetido_en: JSON.stringify([
            { espacio: "Otra Fake", contact_email: "otra@fake.example.com", estado: "baja", desde: "2026-09-20T00:00:00Z" },
          ]),
        },
        {
          creadas_24h: 2,
          tenant_id: PLATAFORMA,
          nombre: "Sin Número SA",
          contact_email: null,
          created_at: "2026-10-06T12:00:00Z",
          plan: "piloto",
          billing_status: "suspended",
          trial_ends_at: null,
          activated_at: "2026-10-06T13:00:00Z",
          numero_id: null,
          numero_en_revision: true,
          repetido_en: [],
        }
      )
    );

    const panel = await listarAltas();

    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(panel).toMatchObject({ migracionPendiente: false, creadas24h: 2, tope: 20 });
    expect(panel.altas).toHaveLength(2);
    expect(panel.altas[0]).toMatchObject({
      tenantId: CLIENTE,
      nombre: "Seguros Fake",
      contactEmail: "contacto@fake.example.com",
      creadoEn: "2026-10-07T12:00:00.000Z",
      estadoDeFacturacion: "trial",
      numero: { id: NUMERO, e164: E164_DEL_CLIENTE, estado: "pedido", phoneNumberId: null, wabaId: null },
      numeroEnRevision: false,
      repetidoEn: [{ espacio: "Otra Fake", contactEmail: "otra@fake.example.com", estado: "baja" }],
    });
    expect(panel.altas[1]).toMatchObject({ numero: null, numeroEnRevision: true, repetidoEn: [], contactEmail: null });
  });

  it("la consulta compara el 9 argentino como mismoNumero, mira la baja de 90 días y la marca de revisión del asiento de alta", async () => {
    h.execute.mockResolvedValue(filas({ creadas_24h: 0, tenant_id: null }));
    await listarAltas();
    const q = consulta();
    expect(q.sql).toContain("regexp_replace(o.numero_e164, '^[+]549', '+54')");
    expect(q.sql).toContain("o.estado <> 'baja'");
    expect(q.params).toEqual(expect.arrayContaining([AuditEvent.TENANT_CREATED, 90, 200]));
    expect(q.sql).toContain("a.payload @>");
    expect(q.sql).toContain("t.autoalta");
  });

  it("sin altas igual trae el conteo de 24 h", async () => {
    h.execute.mockResolvedValue(filas({ creadas_24h: 5, tenant_id: null }));
    expect(await listarAltas()).toEqual({ migracionPendiente: false, altas: [], creadas24h: 5, tope: 20 });

    h.execute.mockResolvedValue(filas());
    expect(await listarAltas()).toMatchObject({ altas: [], creadas24h: 0 });
  });

  it("sin la 0048 devuelve migracionPendiente, y otro error sube", async () => {
    for (const codigo of ["42P01", "42703", "42883"]) {
      h.execute.mockRejectedValueOnce(errorPg(codigo));
      expect(await listarAltas()).toEqual({ migracionPendiente: true, altas: [], creadas24h: 0, tope: 20 });
    }
    h.execute.mockRejectedValueOnce(errorPg("08006"));
    await expect(listarAltas()).rejects.toMatchObject({ code: "08006" });
  });
});

// ── Lo que dice la pantalla ─────────────────────────────────────────────────

describe("resultadoDelPanel", () => {
  it("acepta sólo los códigos de la lista cerrada: lo demás del ?r= se descarta", () => {
    for (const r of RESULTADOS_DEL_PANEL) expect(resultadoDelPanel(r)).toBe(r);
    for (const raro of [undefined, null, "", "<script>", "OK", "ok ", ["ok"], 7]) expect(resultadoDelPanel(raro)).toBeNull();
  });

  it("cada código tiene su mensaje en los dos idiomas", () => {
    for (const r of RESULTADOS_DEL_PANEL) {
      const clave = `altas.r.${r}` as keyof typeof esARServidor;
      expect(esARServidor[clave], clave).toBeTruthy();
      expect(enUSServidor[clave], clave).toBeTruthy();
    }
  });

  it("cada motivo que conectarNumero puede devolver está en la lista", () => {
    const devueltos = [
      "ok", "no_aplica", "migracion_pendiente", "datos_invalidos", "id_de_la_plataforma", "en_cuarentena",
      "numero_duplicado", "id_ocupado", "sin_credencial", "waba_distinta", "meta_no_responde", "id_inexistente",
      "numero_distinto", "fuera_de_la_waba", "de_otro_ambiente",
    ];
    for (const r of devueltos) expect(resultadoDelPanel(r), r).toBe(r);
  });
});
