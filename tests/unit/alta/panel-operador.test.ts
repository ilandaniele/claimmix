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

const h = vi.hoisted(() => ({ execute: vi.fn(), after: vi.fn(), continuarWaba: vi.fn(), soltarEnMeta: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { execute: h.execute } }));
vi.mock("@/data/scope", () => ({ enTenant: vi.fn() }));
vi.mock("@/server/alta/crear-inquilino", () => ({ topeGlobalDelDia: () => 20 }));
// `after` sólo corre dentro de un pedido: acá se junta lo que se agenda y cada test decide si lo corre.
vi.mock("next/server", async () => ({ ...(await vi.importActual<typeof import("next/server")>("next/server")), after: h.after }));
// El alta de la WABA y la suelta en Meta tienen sus propios tests; acá sólo importa con qué se las llama.
vi.mock("@/server/alta/waba-propia", () => ({ continuarWaba: h.continuarWaba, soltarEnMeta: h.soltarEnMeta }));

import { AuditEvent } from "@/lib/audit/log";
import { PLAN_CATALOG } from "@/lib/billing/plans";
import { enUSServidor } from "@/lib/i18n/en-US.servidor";
import { cifrar } from "@/lib/security/cifrado";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";
import { aadDelToken, cerrarSecreto, pruebaDelSecreto } from "@/server/whatsapp/sobres-del-cliente";
import { capturarLogs } from "../../mocks/capturar-logs";
import {
  RESULTADOS_DEL_PANEL,
  activarInquilino,
  almacenDelDueno,
  bajaDeWaba,
  conectarNumero,
  darDeBajaNumero,
  desvincularWaba,
  despublicarLegales,
  extenderPrueba,
  listarAltas,
  nombreDelNumero,
  nombreRehabilitado,
  plantillaCreada,
  reactivarInquilino,
  reactivarNumero,
  recordatorioEnviado,
  reintentarWaba,
  restriccionLevantada,
  resultadoDelPanel,
  suspenderInquilino,
  suspenderNumero,
  primeraRespuestaDeApp,
  primerMensajeDeApp,
  saludDeApp,
  terminosDeActivacion,
  wabaEnFalla,
  wabaRevocada,
  webhookDeAppVerificado,
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
  h.after.mockReset();
  h.continuarWaba.mockReset();
  h.soltarEnMeta.mockReset();
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "test-encryption-key";
  process.env.WHATSAPP_APP_SECRETS_KEY = "test-app-secrets-key";
  process.env.WHATSAPP_ACCESS_TOKEN = "fake-access-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = ID_PLATAFORMA;
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = WABA;
  process.env.WHATSAPP_TENANT_ID = PLATAFORMA;
  process.env.NEXT_PUBLIC_SITE_URL = "https://claimmix.test";
  process.env.WHATSAPP_VERIFY_TOKEN = "fake-verify-token";
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
  /** El webhook propio que el número ya trae, de otro ambiente. */
  webhookAjeno?: string;
  /** La lectura del webhook contesta con este status y sin cuerpo. */
  lecturaFalla?: number;
  /** El POST del webhook contesta con este status y sin `success`. */
  postFalla?: number;
  /** El POST dice `success` pero Graph no guarda nada. */
  noGuarda?: boolean;
}

/**
 * Un Graph de juguete: contesta el número, la lista de números de la WABA y el webhook propio del
 * número (el que le fijaron o el ajeno), y deja las URLs que le pidieron, los cuerpos de los POST
 * y el método y la URL de cada pedido de webhook.
 */
function graph(cfg: Graph = {}) {
  const pedidos: string[] = [];
  const posts: unknown[] = [];
  const webhook: string[] = [];
  let guardado: string | undefined;
  const respuesta = (cuerpo: unknown, status = 200) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => cuerpo }) as Response;
  const fetchFalso = vi.fn(async (url: string, init?: RequestInit) => {
    pedidos.push(url);
    const cuerpo = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (init?.method === "POST" && cuerpo?.webhook_configuration) {
      webhook.push(`POST ${url}`);
      posts.push(cuerpo);
      if (cfg.postFalla) return respuesta({}, cfg.postFalla);
      if (!cfg.noGuarda) guardado = cuerpo.webhook_configuration.override_callback_uri;
      return respuesta({ success: true });
    }
    if (url.includes("fields=webhook_configuration")) {
      webhook.push(`GET ${url}`);
      if (cfg.lecturaFalla) return respuesta({}, cfg.lecturaFalla);
      const propio = guardado ?? cfg.webhookAjeno;
      return respuesta(propio ? { webhook_configuration: { phone_number: propio } } : {});
    }
    if (url.includes("/phone_numbers")) {
      return respuesta({ data: (cfg.idsDeLaWaba ?? [ID_DEL_CLIENTE]).map((id) => ({ id })) }, cfg.estadoDeLaWaba ?? 200);
    }
    return respuesta(
      { display_phone_number: cfg.display ?? "+54 9 11 0000-0000", verified_name: "Seguros Fake" },
      cfg.estadoDelNumero ?? 200
    );
  });
  vi.stubGlobal("fetch", fetchFalso);
  return { pedidos, posts, webhook, fetchFalso };
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

    expect(g.pedidos).toHaveLength(5);
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

  it("el id de la plataforma sí puede ir al espacio de la plataforma, y su webhook no se toca", async () => {
    const g = graph({ idsDeLaWaba: [ID_PLATAFORMA] });
    base({ pedido: { tenant_id: PLATAFORMA.toUpperCase(), numero_e164: E164_DEL_CLIENTE } });

    expect(await pedirConexion({ phoneNumberId: ID_PLATAFORMA })).toBe("ok");
    expect(g.webhook).toEqual([]);
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

  it("un pedido con token propio (WABA propia) no se conecta a mano: ni al leerlo ni al escribir, para no dejarle su token a otra WABA", async () => {
    graph();
    base();

    await pedirConexion();

    expect(consulta(0).sql).toContain("w.token_cifrado is null");
    expect(consulta(1).sql).toContain("w.token_cifrado is null");
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

  it("le fija al número el webhook de este ambiente antes de escribir: lee, pone y relee", async () => {
    const g = graph();
    base();

    expect(await pedirConexion()).toBe("ok");

    expect(g.webhook.map((w) => w.split(" ")[0])).toEqual(["GET", "POST", "GET"]);
    expect(g.webhook.every((w) => w.includes(`/${ID_DEL_CLIENTE}`))).toBe(true);
    expect(h.execute).toHaveBeenCalledTimes(2);
  });

  it("el POST lleva la ruta del webhook de este ambiente y su token del apretón de manos", async () => {
    const g = graph();
    base();

    await pedirConexion();

    expect(g.posts).toEqual([
      {
        webhook_configuration: {
          override_callback_uri: "https://claimmix.test/api/webhooks/whatsapp",
          verify_token: "fake-verify-token",
        },
      },
    ]);
  });

  it("un número que ya tiene el webhook de este ambiente no es ajeno: se conecta", async () => {
    graph({ webhookAjeno: "https://claimmix.test/api/webhooks/whatsapp/" });
    base();

    expect(await pedirConexion()).toBe("ok");
  });

  it("un número con el webhook de otro ambiente no se toca ni se conecta: sin POST y sin escribir", async () => {
    const g = graph({ webhookAjeno: "https://otro.test/api/webhooks/whatsapp" });
    base();

    expect(await pedirConexion()).toBe("webhook_ajeno");

    expect(g.posts).toEqual([]);
    expect(g.webhook).toHaveLength(1);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("Meta rechaza el POST del webhook: sin_webhook, sin escribir", async () => {
    graph({ postFalla: 400 });
    base();

    expect(await pedirConexion()).toBe("sin_webhook");
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("Meta pide esperar, no contesta (5xx) o contesta sin `success` en el POST: meta_no_responde, sin escribir", async () => {
    for (const postFalla of [429, 503, 200]) {
      h.execute.mockReset();
      graph({ postFalla });
      base();
      expect(await pedirConexion(), String(postFalla)).toBe("meta_no_responde");
      expect(h.execute).toHaveBeenCalledTimes(1);
    }
  });

  it("si la relectura no trae el webhook de este ambiente: sin_webhook, sin escribir", async () => {
    const g = graph({ noGuarda: true });
    base();

    expect(await pedirConexion()).toBe("sin_webhook");

    expect(g.posts).toHaveLength(1);
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("la lectura previa del webhook falla: un rechazo es sin_webhook, esperar o no contestar es meta_no_responde; no se pone nada", async () => {
    for (const [lecturaFalla, esperado] of [[400, "sin_webhook"], [429, "meta_no_responde"], [503, "meta_no_responde"]] as const) {
      h.execute.mockReset();
      const g = graph({ lecturaFalla });
      base();
      expect(await pedirConexion(), String(lecturaFalla)).toBe(esperado);
      expect(g.posts).toEqual([]);
      expect(h.execute).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ["falta NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_SITE_URL", undefined],
    ["NEXT_PUBLIC_SITE_URL es http", "NEXT_PUBLIC_SITE_URL", "http://claimmix.test"],
    ["falta WHATSAPP_VERIFY_TOKEN", "WHATSAPP_VERIFY_TOKEN", undefined],
  ])("%s: sin_credencial, sin pedidos de webhook y sin escribir", async (_caso, variable, valor) => {
    if (valor === undefined) delete process.env[variable];
    else process.env[variable] = valor;
    const g = graph();
    base();

    expect(await pedirConexion()).toBe("sin_credencial");

    expect(g.webhook).toEqual([]);
    expect(h.execute).toHaveBeenCalledTimes(1);
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
    h.execute.mockRejectedValue(errorPg("42883"));
    expect(await a.correr()).toBe("migracion_pendiente");

    h.execute.mockReset();
    h.execute.mockRejectedValue(errorPg("57014"));
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

  it("dar de baja deja el token en NULL y revoca la WABA propia del número, sin pasar por la de la plataforma", async () => {
    h.execute.mockResolvedValue(filas({ n: 1 }));
    await darDeBajaNumero(NUMERO, OP);
    const q = consulta();
    expect(q.sql).toContain("token_cifrado = null");
    expect(q.sql).toContain("update public.whatsapp_wabas b set estado = 'revocada', falla = null, pin_cifrado = null");
    expect(q.sql).toContain("b.waba_id = u.waba_id");
    expect(q.sql).toContain("b.waba_id is distinct from");
    expect(q.params).toContain(WABA);
    expect(q.sql).not.toContain(WABA);
  });

  it("dar de baja sin la 0051 (falta la tabla de la WABA propia) lo da de baja igual, sin tocarla", async () => {
    h.execute.mockRejectedValueOnce(errorPg("42P01")).mockResolvedValueOnce(filas({ n: 1, tenant_id: CLIENTE }));

    expect(await darDeBajaNumero(NUMERO, OP)).toBe("ok");

    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(consulta(0).sql).toContain("whatsapp_wabas");
    const reintento = consulta(1);
    expect(reintento.sql).toContain("set estado = 'baja'");
    expect(reintento.sql).toContain("insert into public.audit_log");
    expect(reintento.sql).not.toContain("whatsapp_wabas");
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

// ── La WABA propia ──────────────────────────────────────────────────────────

const WABA_DEL_CLIENTE = "555000111222";
const TOKEN_DEL_CLIENTE = "test-waba-token";

/** Lo que la sentencia de baja devuelve por cada WABA: el token viene cifrado con el AAD del espacio y la WABA. */
const filaDeBaja = (cambios: Record<string, unknown> = {}) => ({
  tenant_id: CLIENTE,
  waba_id: WABA_DEL_CLIENTE,
  phone_number_id: ID_DEL_CLIENTE,
  numero_estado: "conectado",
  token_cifrado: cifrar(TOKEN_DEL_CLIENTE, aadDelToken(CLIENTE, WABA_DEL_CLIENTE)),
  ...cambios,
});

const cuantas = (texto: string, buscada: string) => texto.split(buscada).length - 1;

describe("bajaDeWaba", () => {
  it("la baja borra también lo de la app propia: el secreto, la ruta del webhook y su verificación", async () => {
    h.execute.mockResolvedValue(filas(filaDeBaja()));

    await bajaDeWaba({ tenantId: CLIENTE }, OP);

    const { sql } = consulta();
    expect(sql).toContain("update public.whatsapp_wabas w set estado = 'revocada'");
    for (const borrado of ["app_secreto_cifrado = null", "ruta_webhook = null", "webhook_app_verificado_en = null"]) {
      expect(sql, borrado).toContain(borrado);
    }
  });

  it("es UNA sentencia: cierra el número sin token, revoca la WABA sin PIN y asienta las dos cosas", async () => {
    h.execute.mockResolvedValue(filas(filaDeBaja()));

    await bajaDeWaba({ tenantId: CLIENTE }, OP);

    expect(h.execute).toHaveBeenCalledTimes(1);
    const { sql } = consulta();
    expect(sql).toContain("update public.whatsapp_numeros w set estado = 'baja', token_cifrado = null");
    expect(sql).toContain("update public.whatsapp_wabas w set estado = 'revocada', falla = null, pin_cifrado = null");
    expect(cuantas(sql, "insert into public.audit_log")).toBe(2);
    expect(sql.toLowerCase()).not.toContain("delete");
    // Sólo espacios del alta automática: un id armado a mano contra la casa no hace nada.
    expect(sql).toContain("x.autoalta");
  });

  it("la causa `token_vencido` sólo la deja Meta: el cliente o el operador que la sueltan no tienen una falla que mostrar", async () => {
    h.execute.mockResolvedValue(filas());

    await bajaDeWaba({ tenantId: CLIENTE }, OP);
    expect(consulta().sql).toContain("estado = 'revocada', falla = null, pin_cifrado = null");

    await bajaDeWaba({ wabaId: WABA_DEL_CLIENTE }, "sistema");
    expect(consulta().sql).toContain("estado = 'revocada', falla = null, pin_cifrado = null");

    await bajaDeWaba({ wabaId: WABA_DEL_CLIENTE }, "meta");
    expect(consulta().sql).toContain("estado = 'revocada', falla = 'token_vencido'::text, pin_cifrado = null");
  });

  it("no toca la WABA de la plataforma: su id va por parámetro y la fila sin WABA sí entra", async () => {
    h.execute.mockResolvedValue(filas());

    await bajaDeWaba({ tenantId: CLIENTE }, OP);

    const q = consulta();
    expect(q.sql).toContain("b.waba_id is null or b.waba_id is distinct from");
    expect(q.params).toContain(WABA);
    expect(q.sql).not.toContain(WABA);
  });

  it.each([
    [{ tenantId: CLIENTE }, "b.tenant_id =", CLIENTE],
    [{ wabaId: WABA_DEL_CLIENTE }, "b.waba_id =", WABA_DEL_CLIENTE],
    [{ fbUserId: "1234567890" }, "b.fb_user_id =", "1234567890"],
  ])("encuentra por %j, con el valor por parámetro", async (donde, condicion, valor) => {
    h.execute.mockResolvedValue(filas());

    await bajaDeWaba(donde, OP);

    const q = consulta();
    expect(q.sql).toContain(condicion);
    expect(q.params).toContain(valor);
    expect(q.sql).not.toContain(valor);
  });

  it("sólo da de baja lo que sigue vivo: una WABA ya revocada no se vuelve a asentar", async () => {
    h.execute.mockResolvedValue(filas());

    await bajaDeWaba({ wabaId: WABA_DEL_CLIENTE }, OP);

    const { sql } = consulta();
    expect(sql).toContain("b.estado in (");
    expect(sql).not.toContain("'revocada'::text");
  });

  it("devuelve el token ya abierto, para soltarlo en Meta: el borrado de la base ya lo borró", async () => {
    h.execute.mockResolvedValue(filas(filaDeBaja()));

    const bajas = await bajaDeWaba({ tenantId: CLIENTE }, OP);

    expect(bajas).toEqual([
      {
        tenantId: CLIENTE,
        wabaId: WABA_DEL_CLIENTE,
        phoneNumberId: ID_DEL_CLIENTE,
        numeroEstado: "conectado",
        token: TOKEN_DEL_CLIENTE,
      },
    ]);
  });

  describe("con la app propia del cliente", () => {
    const APP_ID = "500000000000001";
    const SECRETO = "fake-app-secret-del-cliente";
    const deApp = (cambios: Record<string, unknown> = {}) =>
      filaDeBaja({ origen: "app_propia", app_id: APP_ID, app_secreto_cifrado: cerrarSecreto(SECRETO, CLIENTE, APP_ID), ...cambios });

    it("el secreto se lee en la misma sentencia que lo borra: el `with` ve la fila de antes del update", async () => {
      h.execute.mockResolvedValue(filas(deApp()));

      await bajaDeWaba({ tenantId: CLIENTE }, OP);

      const { sql } = consulta();
      const lectura = sql.slice(0, sql.indexOf("update public.whatsapp_wabas"));
      expect(lectura).toContain("b.origen, b.app_id, b.app_secreto_cifrado");
    });

    it("devuelve el appsecret_proof ya armado, no el secreto", async () => {
      h.execute.mockResolvedValue(filas(deApp()));

      const [baja] = await bajaDeWaba({ tenantId: CLIENTE }, OP);

      expect(baja.app).toEqual({ prueba: pruebaDelSecreto(TOKEN_DEL_CLIENTE, SECRETO) });
      expect(JSON.stringify(baja)).not.toContain(SECRETO);
    });

    it("un secreto que no abre deja la baja sin prueba: no se inventa una", async () => {
      h.execute.mockResolvedValue(filas(deApp({ app_secreto_cifrado: cerrarSecreto(SECRETO, PLATAFORMA, APP_ID) })));

      const [baja] = await bajaDeWaba({ tenantId: CLIENTE }, OP);

      expect(baja.app).toEqual({ prueba: undefined });
    });

    it("con Embedded Signup no hay app que firmar", async () => {
      h.execute.mockResolvedValue(filas(filaDeBaja({ origen: "embedded_signup" })));

      const [baja] = await bajaDeWaba({ tenantId: CLIENTE }, OP);

      expect(baja.app).toBeUndefined();
    });
  });

  it("un token cifrado para otro espacio no abre: queda en null y el error no lo nombra", async () => {
    const logs = capturarLogs();
    h.execute.mockResolvedValue(
      filas(filaDeBaja({ token_cifrado: cifrar(TOKEN_DEL_CLIENTE, aadDelToken(PLATAFORMA, WABA_DEL_CLIENTE)) }))
    );

    const bajas = await bajaDeWaba({ tenantId: CLIENTE }, OP);
    logs.restaurar();

    expect(bajas[0].token).toBeNull();
    expect(logs.texto()).not.toContain(TOKEN_DEL_CLIENTE);
  });

  it("una WABA sin número vivo vuelve con todo lo del número en null", async () => {
    h.execute.mockResolvedValue(
      filas(filaDeBaja({ phone_number_id: null, numero_estado: null, token_cifrado: null }))
    );

    const bajas = await bajaDeWaba({ tenantId: CLIENTE }, OP);

    expect(bajas).toEqual([
      { tenantId: CLIENTE, wabaId: WABA_DEL_CLIENTE, phoneNumberId: null, numeroEstado: null, token: null },
    ]);
  });

  it("si nada coincide devuelve una lista vacía", async () => {
    h.execute.mockResolvedValue(filas());

    expect(await bajaDeWaba({ fbUserId: "1234567890" }, "meta")).toEqual([]);
  });

  it("el operador firma el asiento con su id y su IP; Meta y el sistema, sin autor", async () => {
    h.execute.mockResolvedValue(filas());

    await bajaDeWaba({ tenantId: CLIENTE }, OP);
    const delOperador = consulta();
    expect(delOperador.params).toEqual(
      expect.arrayContaining([OP.userId, OP.ip, AuditEvent.WHATSAPP_NUMERO_BAJA, AuditEvent.WHATSAPP_WABA_REVOCADA, '{"via":"operador"}'])
    );

    await bajaDeWaba({ fbUserId: "1234567890" }, "meta");
    const deMeta = consulta();
    expect(deMeta.params).toContain('{"via":"meta"}');
    expect(deMeta.params).not.toContain(OP.userId);

    await bajaDeWaba({ wabaId: WABA_DEL_CLIENTE }, "sistema");
    expect(consulta().params).toContain('{"via":"sistema"}');
  });

  it("sin el código de borrado de Meta no asienta nada más que la baja", async () => {
    h.execute.mockResolvedValue(filas());

    await bajaDeWaba({ fbUserId: "1234567890" }, "meta");

    const q = consulta();
    expect(cuantas(q.sql, "insert into public.audit_log")).toBe(2);
    expect(q.params).not.toContain(AuditEvent.META_BORRADO_DE_DATOS);
  });

  it("con el código de borrado de Meta, la constancia entra en la MISMA sentencia: por cada WABA dada de baja, con el código y sin autor", async () => {
    h.execute.mockResolvedValue(filas(filaDeBaja()));

    await bajaDeWaba({ fbUserId: "1234567890" }, "meta", "codigo-de-borrado");

    expect(h.execute).toHaveBeenCalledTimes(1);
    const q = consulta();
    expect(cuantas(q.sql, "insert into public.audit_log")).toBe(3);
    expect(q.sql).toContain("coalesce(b.waba_id, b.tenant_id::text) as id from b");
    expect(q.params).toEqual(expect.arrayContaining([AuditEvent.META_BORRADO_DE_DATOS, '{"codigo":"codigo-de-borrado"}']));
    expect(q.params).not.toContain(OP.userId);
  });

  it("sin la 0051 tira el error: quien llama decide qué decirle a su cliente", async () => {
    h.execute.mockRejectedValue(errorPg("42P01"));

    await expect(bajaDeWaba({ tenantId: CLIENTE }, OP)).rejects.toMatchObject({ code: "42P01" });
  });
});

describe("desvincularWaba", () => {
  it("da de baja el espacio y agenda soltar la WABA en Meta con el número vivo", async () => {
    h.execute.mockResolvedValue(filas(filaDeBaja()));

    expect(await desvincularWaba(CLIENTE, OP)).toBe("ok");

    expect(consulta().params).toContain(CLIENTE);
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.soltarEnMeta).not.toHaveBeenCalled();
    await h.after.mock.calls[0][0]();
    expect(h.soltarEnMeta).toHaveBeenCalledWith(CLIENTE, TOKEN_DEL_CLIENTE, WABA_DEL_CLIENTE, ID_DEL_CLIENTE, undefined);
  });

  it("con la app propia del cliente la suelta en Meta firmada con su appsecret_proof (el secreto ya no está en la base)", async () => {
    const APP_ID = "500000000000001";
    const SECRETO = "fake-app-secret-del-cliente";
    h.execute.mockResolvedValue(
      filas(filaDeBaja({ origen: "app_propia", app_id: APP_ID, app_secreto_cifrado: cerrarSecreto(SECRETO, CLIENTE, APP_ID) }))
    );

    await desvincularWaba(CLIENTE, OP);
    await h.after.mock.calls[0][0]();

    expect(h.soltarEnMeta).toHaveBeenCalledWith(CLIENTE, TOKEN_DEL_CLIENTE, WABA_DEL_CLIENTE, ID_DEL_CLIENTE, {
      prueba: pruebaDelSecreto(TOKEN_DEL_CLIENTE, SECRETO),
    });
  });

  it("un número que la base tiene como «pedido» también viaja: Meta puede tenerlo registrado, y soltarEnMeta decide", async () => {
    h.execute.mockResolvedValue(filas(filaDeBaja({ numero_estado: "pedido" })));

    await desvincularWaba(CLIENTE, OP);
    await h.after.mock.calls[0][0]();

    expect(h.soltarEnMeta).toHaveBeenCalledWith(CLIENTE, TOKEN_DEL_CLIENTE, WABA_DEL_CLIENTE, ID_DEL_CLIENTE, undefined);
  });

  it("sin número vivo de esa WABA sólo se saca la app", async () => {
    h.execute.mockResolvedValue(filas(filaDeBaja({ phone_number_id: null, numero_estado: null })));

    await desvincularWaba(CLIENTE, OP);
    await h.after.mock.calls[0][0]();

    expect(h.soltarEnMeta).toHaveBeenCalledWith(CLIENTE, TOKEN_DEL_CLIENTE, WABA_DEL_CLIENTE, null, undefined);
  });

  it("un número suspendido sigue siendo de la WABA: también se da de baja en Meta", async () => {
    h.execute.mockResolvedValue(filas(filaDeBaja({ numero_estado: "suspendido" })));

    await desvincularWaba(CLIENTE, OP);
    await h.after.mock.calls[0][0]();

    expect(h.soltarEnMeta).toHaveBeenCalledWith(CLIENTE, TOKEN_DEL_CLIENTE, WABA_DEL_CLIENTE, ID_DEL_CLIENTE, undefined);
  });

  it("sin token que soltar la baja igual se hace, y no se agenda nada", async () => {
    h.execute.mockResolvedValue(filas(filaDeBaja({ token_cifrado: null })));

    expect(await desvincularWaba(CLIENTE, OP)).toBe("ok");

    expect(h.after).not.toHaveBeenCalled();
  });

  it("si no había nada vivo es no_aplica", async () => {
    h.execute.mockResolvedValue(filas());

    expect(await desvincularWaba(CLIENTE, OP)).toBe("no_aplica");

    expect(h.after).not.toHaveBeenCalled();
  });

  it("sin la 0051 devuelve migracion_pendiente, y otro error sube", async () => {
    h.execute.mockRejectedValueOnce(errorPg("42P01"));
    expect(await desvincularWaba(CLIENTE, OP)).toBe("migracion_pendiente");

    h.execute.mockRejectedValueOnce(errorPg("57014"));
    await expect(desvincularWaba(CLIENTE, OP)).rejects.toMatchObject({ code: "57014" });
  });
});

describe("reintentarWaba", () => {
  it("retoma con el almacén del operador y avisa que se reintentó", async () => {
    h.continuarWaba.mockResolvedValue("conectado");

    expect(await reintentarWaba(CLIENTE, OP)).toBe("waba_reintentada");

    expect(h.continuarWaba).toHaveBeenCalledTimes(1);
    const [espacio, almacen] = h.continuarWaba.mock.calls[0];
    expect(espacio).toBe(CLIENTE);
    expect(almacen).toEqual({ leer: expect.any(Function), guardar: expect.any(Function) });
  });

  it.each([
    ["vencido", "waba_sin_token"],
    ["apagado", "no_aplica"],
    ["de_la_plataforma", "no_aplica"],
    ["meta", "meta_no_responde"],
    ["falta_codigo", "waba_reintentada"],
    ["falta_pin", "waba_reintentada"],
    ["conectado", "waba_reintentada"],
    ["coexistencia", "waba_reintentada"],
  ])("lo que devuelve la retoma (%s) se cuenta como %s", async (resultado, esperado) => {
    h.continuarWaba.mockResolvedValue(resultado);

    expect(await reintentarWaba(CLIENTE, OP)).toBe(esperado);
  });
});

describe("almacenDelDueno", () => {
  const filaDeLectura = (cambios: Record<string, unknown> = {}) => ({
    estado: "falla",
    falla: "suscripcion",
    waba_id: WABA_DEL_CLIENTE,
    business_id: "999000111",
    numero_meta: "+5491100000000",
    numero_aceptado: false,
    nombre_estado: null,
    plantilla_enviada_en: null,
    pin_cifrado: cifrar("123456", `wa-pin:${CLIENTE}:${WABA_DEL_CLIENTE}`),
    numero_estado: "pedido",
    phone_number_id: ID_DEL_CLIENTE,
    numero_tipeado: E164_DEL_CLIENTE,
    waba_del_numero: WABA_DEL_CLIENTE,
    token_cifrado: cifrar(TOKEN_DEL_CLIENTE, aadDelToken(CLIENTE, WABA_DEL_CLIENTE)),
    contact_email: "contacto@fake.example.com",
    ...cambios,
  });

  it("lee en UNA consulta, solo de un espacio del alta, y abre el token y el PIN con el AAD de la WABA", async () => {
    h.execute.mockResolvedValue(filas(filaDeLectura()));

    const fila = await almacenDelDueno(CLIENTE, OP).leer();

    expect(h.execute).toHaveBeenCalledTimes(1);
    const q = consulta();
    expect(q.sql).toContain("t.autoalta");
    expect(q.params).toContain(CLIENTE);
    expect(fila).toMatchObject({
      estado: "falla",
      falla: "suscripcion",
      wabaId: WABA_DEL_CLIENTE,
      phoneNumberId: ID_DEL_CLIENTE,
      token: TOKEN_DEL_CLIENTE,
      pin: "123456",
      numeroEstado: "pedido",
      emailDeContacto: "contacto@fake.example.com",
    });
  });

  it("el token de un número de OTRA WABA no se usa: sólo vale el de esta", async () => {
    h.execute.mockResolvedValue(filas(filaDeLectura({ waba_del_numero: "888000111222" })));

    expect((await almacenDelDueno(CLIENTE, OP).leer())?.token).toBeNull();
  });

  it("sin fila de WABA (el espacio usa la de la plataforma) no hay token ni PIN que abrir", async () => {
    h.execute.mockResolvedValue(
      filas(filaDeLectura({ estado: null, waba_id: null, pin_cifrado: null, token_cifrado: null, waba_del_numero: null }))
    );

    expect(await almacenDelDueno(CLIENTE, OP).leer()).toMatchObject({ estado: null, wabaId: null, token: null, pin: null });
  });

  it("un espacio que no es del alta no existe para el operador, y sin la 0051 tampoco hay nada que leer", async () => {
    h.execute.mockResolvedValueOnce(filas());
    expect(await almacenDelDueno(CLIENTE, OP).leer()).toBeNull();

    h.execute.mockRejectedValueOnce(errorPg("42P01"));
    expect(await almacenDelDueno(CLIENTE, OP).leer()).toBeNull();

    h.execute.mockRejectedValueOnce(errorPg("57014"));
    await expect(almacenDelDueno(CLIENTE, OP).leer()).rejects.toMatchObject({ code: "57014" });
  });

  it("el operador sólo escribe `estado` y `conectar`: cualquier otro paso es de la persona", async () => {
    for (const paso of ["pin", "codigo", "vincular", "cancelar", "numero"]) {
      expect(await almacenDelDueno(CLIENTE, OP).guardar(paso, {})).toBe("datos_invalidos");
    }
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("estado: solo estados y fallas de la lista, y nada fuera de ella toca la base", async () => {
    const casos: Array<Record<string, unknown>> = [
      { estado: "revocada" },
      { estado: "conectada", falla: "canje" },
      { estado: "falla", falla: "inventada" },
      { estado: "falla" },
      { estado: "conectada", nombre_estado: "approved" },
      { estado: "conectada", plantilla_enviada_en: "no es una fecha" },
    ];
    for (const datos of casos) {
      expect(await almacenDelDueno(CLIENTE, OP).guardar("estado", datos)).toBe("datos_invalidos");
    }
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("estado: una escritura válida es UNA sentencia, con el estado de salida por parámetro, y sin asiento", async () => {
    h.execute.mockResolvedValue(filas({ tenant_id: CLIENTE }));

    expect(await almacenDelDueno(CLIENTE, OP).guardar("estado", { estado: "falla", falla: "suscripcion" })).toBe("ok");

    expect(h.execute).toHaveBeenCalledTimes(1);
    const q = consulta();
    expect(q.sql).toContain("update public.whatsapp_wabas b");
    expect(q.sql).toContain("b.estado in (");
    expect(q.sql).not.toContain("audit_log");
    expect(q.params).toEqual(expect.arrayContaining([CLIENTE, "falla", "suscripcion"]));
  });

  it("estado: si la fila ya no está en un estado de salida es `transicion`", async () => {
    h.execute.mockResolvedValue(filas());

    expect(await almacenDelDueno(CLIENTE, OP).guardar("estado", { estado: "suscripta" })).toBe("transicion");
  });

  it("guardar traduce los errores de la base: 23505 id_ocupado, sin la 0051 sin_migracion, y el resto error", async () => {
    const datos = { estado: "suscripta" };
    h.execute.mockRejectedValueOnce(errorPg("23505"));
    expect(await almacenDelDueno(CLIENTE, OP).guardar("estado", datos)).toBe("id_ocupado");

    h.execute.mockRejectedValueOnce(errorPg("42703"));
    expect(await almacenDelDueno(CLIENTE, OP).guardar("estado", datos)).toBe("sin_migracion");

    const logs = capturarLogs();
    h.execute.mockRejectedValueOnce(errorPg("57014"));
    expect(await almacenDelDueno(CLIENTE, OP).guardar("estado", datos)).toBe("error");
    logs.restaurar();
    expect(logs.texto()).toContain("57014");
  });

  it("conectar: el número tiene que ser un id de Meta y no el de la plataforma, antes de tocar la base", async () => {
    expect(await almacenDelDueno(CLIENTE, OP).guardar("conectar", { phone_number_id: "no-es-un-id" })).toBe("datos_invalidos");
    expect(await almacenDelDueno(CLIENTE, OP).guardar("conectar", {})).toBe("datos_invalidos");
    expect(await almacenDelDueno(CLIENTE, OP).guardar("conectar", { phone_number_id: ID_PLATAFORMA })).toBe("de_la_plataforma");
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("conectar: una sentencia con su asiento, firmada por el operador, y la respuesta sale de la misma sentencia", async () => {
    h.execute.mockResolvedValue(filas({ resultado: "ok" }));

    expect(await almacenDelDueno(CLIENTE, OP).guardar("conectar", { phone_number_id: ID_DEL_CLIENTE })).toBe("ok");

    expect(h.execute).toHaveBeenCalledTimes(1);
    const q = consulta();
    expect(q.sql).toContain("insert into public.audit_log");
    expect(q.sql).toContain("n.token_cifrado is not null as con_token");
    expect(q.params).toEqual(expect.arrayContaining([CLIENTE, ID_DEL_CLIENTE, OP.userId, OP.ip, WABA]));
  });

  it("estado y conectar piden el mismo «espacio en prueba vigente o activo»: la condición está escrita una sola vez", async () => {
    h.execute.mockResolvedValue(filas({ tenant_id: CLIENTE, resultado: "ok" }));
    const condicion = (sentencia: string) =>
      /x\.autoalta and x\.billing_status in \('trial', 'active'\)\s+and \(x\.billing_status <> 'trial' or x\.trial_ends_at is null or x\.trial_ends_at > now\(\)\)/.exec(sentencia)?.[0];

    await almacenDelDueno(CLIENTE, OP).guardar("estado", { estado: "suscripta" });
    const delEstado = condicion(consulta().sql);
    await almacenDelDueno(CLIENTE, OP).guardar("conectar", { phone_number_id: ID_DEL_CLIENTE });
    const delConectar = condicion(consulta().sql);

    expect(delEstado).toBeDefined();
    expect(delConectar).toBe(delEstado);
  });

  it.each(["no_aplica", "transicion", "de_la_plataforma", "numero_ocupado"])(
    "conectar: lo que la sentencia contesta (%s) vuelve tal cual",
    async (resultado) => {
      h.execute.mockResolvedValue(filas({ resultado }));

      expect(await almacenDelDueno(CLIENTE, OP).guardar("conectar", { phone_number_id: ID_DEL_CLIENTE })).toBe(resultado);
    }
  );

  it("conectar: una respuesta que no es de la lista es error, no una conexión", async () => {
    h.execute.mockResolvedValue(filas({ resultado: "inventado" }));

    expect(await almacenDelDueno(CLIENTE, OP).guardar("conectar", { phone_number_id: ID_DEL_CLIENTE })).toBe("error");
  });
});

describe("lo que cuenta Meta de la WABA", () => {
  it("wabaRevocada da de baja por el id de la WABA, firmada por Meta", async () => {
    h.execute.mockResolvedValue(filas());

    await wabaRevocada(WABA_DEL_CLIENTE);

    const q = consulta();
    expect(q.sql).toContain("b.waba_id =");
    expect(q.params).toEqual(expect.arrayContaining([WABA_DEL_CLIENTE, '{"via":"meta"}']));
    expect(q.params).not.toContain(OP.userId);
  });

  it("wabaEnFalla sólo sale de `conectada` y deja el token y el número como están", async () => {
    h.execute.mockResolvedValue(filas({ tenant_id: CLIENTE }));

    await wabaEnFalla(CLIENTE, "token_vencido");

    expect(h.execute).toHaveBeenCalledTimes(1);
    const q = consulta();
    expect(q.sql).toContain("set estado = 'falla'");
    expect(q.sql).toContain("b.estado = 'conectada'");
    expect(q.sql).not.toContain("whatsapp_numeros");
    expect(q.sql).not.toContain("token_cifrado");
    expect(q.params).toEqual(expect.arrayContaining([CLIENTE, "token_vencido"]));
  });

  it("wabaEnFalla anota el cambio solo si la fila cambió", async () => {
    const logs = capturarLogs();
    h.execute.mockResolvedValueOnce(filas({ tenant_id: CLIENTE }));
    await wabaEnFalla(CLIENTE, "nombre_rechazado");
    expect(logs.lineas().map((l) => l.msg)).toContain("whatsapp.waba_en_falla");

    h.execute.mockResolvedValueOnce(filas());
    await wabaEnFalla(CLIENTE, "nombre_rechazado");
    logs.restaurar();
    expect(logs.lineas().filter((l) => l.msg === "whatsapp.waba_en_falla")).toHaveLength(1);
  });

  it("wabaEnFalla dice si la fila cambió, para que nadie avise de lo que no pasó", async () => {
    h.execute.mockResolvedValueOnce(filas({ tenant_id: CLIENTE }));
    expect(await wabaEnFalla(CLIENTE, "secreto_invalido")).toBe(true);

    h.execute.mockResolvedValueOnce(filas());
    expect(await wabaEnFalla(CLIENTE, "secreto_invalido")).toBe(false);
  });

  it("wabaEnFalla con `secretoCifrado` sólo marca la fila si todavía guarda ese secreto (el cliente pudo cambiarlo)", async () => {
    h.execute.mockResolvedValue(filas());

    await wabaEnFalla(CLIENTE, "secreto_invalido", { secretoCifrado: "cifrado:fake-viejo-key" });

    const q = consulta();
    expect(q.sql).toContain("b.app_secreto_cifrado =");
    expect(q.params).toContain("cifrado:fake-viejo-key");
    // Es un parámetro: el secreto en su sobre no viaja dentro del texto de la sentencia.
    expect(q.sql).not.toContain("cifrado:fake-viejo-key");
  });

  it("wabaEnFalla sin `secretoCifrado` no mira el secreto de la fila", async () => {
    h.execute.mockResolvedValue(filas());

    await wabaEnFalla(CLIENTE, "token_vencido");

    expect(consulta().sql).not.toContain("app_secreto_cifrado");
  });

  it.each([
    ["token_vencido", true],
    ["secreto_invalido", true],
    ["nombre_rechazado", false],
    ["waba_restringida", false],
    ["waba_bloqueada", false],
    ["pago_pendiente", false],
  ] as const)(
    "wabaEnFalla «%s»: pisar una restricción o un bloqueo de Meta es %s",
    async (falla, pisa) => {
      h.execute.mockResolvedValue(filas());

      await wabaEnFalla(CLIENTE, falla);

      const q = consulta();
      // Un token o un secreto muertos bajo la restricción pisan la vieja; ninguna otra falla pisa una falla.
      expect(q.sql).toContain("b.falla in ('waba_restringida', 'waba_bloqueada')");
      expect(q.params).toEqual([falla, CLIENTE, pisa]);
    }
  );

  it("restriccionLevantada devuelve la fila de la restricción o el bloqueo a conectada, sólo con el número vivo", async () => {
    h.execute.mockResolvedValue(filas({ tenant_id: CLIENTE }));

    expect(await restriccionLevantada(CLIENTE)).toBe(true);

    expect(h.execute).toHaveBeenCalledTimes(1);
    const q = consulta();
    expect(q.sql).toContain("set estado = 'conectada', falla = null");
    expect(q.sql).toContain("b.origen = 'app_propia' and b.estado = 'falla'");
    expect(q.sql).toContain("b.falla in ('waba_restringida', 'waba_bloqueada')");
    expect(q.sql).toContain("n.waba_id = b.waba_id and n.estado in ('conectado', 'suspendido')");
    expect(q.params).toEqual([CLIENTE]);
    expect(q.sql).not.toContain("token_cifrado");
  });

  it("restriccionLevantada dice que no cuando la fila ya no estaba restringida", async () => {
    h.execute.mockResolvedValue(filas());

    expect(await restriccionLevantada(CLIENTE)).toBe(false);
  });

  it("plantillaCreada anota la fecha una sola vez y solo de una WABA conectada", async () => {
    h.execute.mockResolvedValue(filas());

    await plantillaCreada(CLIENTE);

    const q = consulta();
    expect(q.sql).toContain("plantilla_enviada_en = now()");
    expect(q.sql).toContain("b.estado = 'conectada'");
    expect(q.sql).toContain("b.plantilla_enviada_en is null");
    expect(q.params).toContain(CLIENTE);
    // Es información: no mueve la hora del último cambio de estado, con la que se descarta un aviso de Meta viejo.
    expect(q.sql).not.toContain("actualizado_en");
  });

  it("nombreDelNumero guarda el estado del nombre tal cual lo manda Meta, y no toca una WABA revocada", async () => {
    h.execute.mockResolvedValue(filas());

    await nombreDelNumero(WABA_DEL_CLIENTE, "APPROVED");

    const q = consulta();
    expect(q.sql).toContain("nombre_estado =");
    expect(q.sql).toContain("b.estado not in ('revocada', 'cancelada')");
    expect(q.params).toEqual(expect.arrayContaining([WABA_DEL_CLIENTE, "APPROVED"]));
    expect(q.sql).not.toContain("actualizado_en");
  });

  it("nombreDelNumero ignora lo que no parece un estado de Meta (mayúsculas y guion bajo, hasta 30)", async () => {
    for (const raro of ["approved", "APPROVED; drop table", "", "A".repeat(31), "ESTADO 1"]) {
      await nombreDelNumero(WABA_DEL_CLIENTE, raro);
    }

    expect(h.execute).not.toHaveBeenCalled();
  });

  it("nombreRehabilitado devuelve la fila a conectada, con una sola sentencia y el espacio por parámetro", async () => {
    h.execute.mockResolvedValue(filas({ tenant_id: CLIENTE }));

    expect(await nombreRehabilitado(CLIENTE)).toBe(true);

    expect(h.execute).toHaveBeenCalledTimes(1);
    const q = consulta();
    expect(q.sql).toContain("set estado = 'conectada', falla = null, nombre_estado = 'APPROVED'");
    expect(q.params).toEqual([CLIENTE]);
    expect(q.sql).not.toContain(CLIENTE);
  });

  it("nombreRehabilitado sólo toca una fila caída por el nombre y sólo si su número sigue conectado o suspendido", async () => {
    h.execute.mockResolvedValue(filas());

    await nombreRehabilitado(CLIENTE);

    const q = consulta();
    expect(q.sql).toContain("b.estado = 'falla' and b.falla = 'nombre_rechazado'");
    expect(q.sql).toMatch(/n\.waba_id = b\.waba_id and n\.estado in \('conectado', 'suspendido'\)/);
    // Rehabilita sin dejar rastro del token ni del PIN: no los lee.
    expect(q.sql).not.toContain("token_cifrado");
    expect(q.sql).not.toContain("pin_cifrado");
  });

  it("nombreRehabilitado dice que no cuando la fila ya no estaba caída por el nombre", async () => {
    h.execute.mockResolvedValue(filas());

    expect(await nombreRehabilitado(CLIENTE)).toBe(false);
  });

  it("recordatorioEnviado marca el recordatorio una sola vez y sólo en un alta que sigue a medias", async () => {
    h.execute.mockResolvedValue(filas());

    await recordatorioEnviado(CLIENTE);

    expect(h.execute).toHaveBeenCalledTimes(1);
    const q = consulta();
    expect(q.sql).toContain("set recordatorio_en = now()");
    expect(q.sql).toContain("b.estado = 'armando'");
    expect(q.sql).toContain("b.recordatorio_en is null");
    expect(q.params).toEqual([CLIENTE]);
    // Es información: no mueve la hora del último cambio, con la que se mide cuánto lleva a medias.
    expect(q.sql).not.toContain("actualizado_en");
  });
});

describe("la app propia: su webhook y su envío", () => {
  const RUTA = "fake-ruta-webhook-0123456789abcdef";

  it.each(["token_vencido", "nombre_rechazado", "secreto_invalido", "waba_restringida", "waba_bloqueada", "pago_pendiente"] as const)(
    "wabaEnFalla deja la falla «%s» en la fila, por parámetro",
    async (falla) => {
      h.execute.mockResolvedValue(filas({ tenant_id: CLIENTE }));

      await wabaEnFalla(CLIENTE, falla);

      const q = consulta();
      expect(q.params).toEqual([falla, CLIENTE, falla === "token_vencido" || falla === "secreto_invalido"]);
      expect(q.sql).toContain("falla = $1::text");
    }
  );

  describe("webhookDeAppVerificado", () => {
    it("marca la hora en la fila de esa ruta, de una app propia y viva, con la ruta por parámetro", async () => {
      h.execute.mockResolvedValue(filas({ tenant_id: CLIENTE }));

      expect(await webhookDeAppVerificado(RUTA)).toBe(true);

      expect(h.execute).toHaveBeenCalledTimes(1);
      const q = consulta();
      expect(q.sql).toContain("webhook_app_verificado_en = now()");
      expect(q.sql).toContain("b.ruta_webhook =");
      expect(q.sql).toContain("b.origen = 'app_propia'");
      expect(q.sql).toContain("b.estado not in ('revocada', 'cancelada')");
      expect(q.params).toEqual([RUTA]);
      expect(q.sql).not.toContain(RUTA);
    });

    it("una ruta que no es de ninguna fila viva: false, para que el webhook conteste 404", async () => {
      h.execute.mockResolvedValue(filas());

      expect(await webhookDeAppVerificado(RUTA)).toBe(false);
    });

    it("un error de la base se tira: el webhook responde 500 y Meta reintenta", async () => {
      h.execute.mockRejectedValue(new Error("fetch failed"));

      await expect(webhookDeAppVerificado(RUTA)).rejects.toThrow("fetch failed");
    });
  });

  describe("primerMensajeDeApp", () => {
    it("anota la hora una sola vez y sólo en una app propia", async () => {
      h.execute.mockResolvedValue(filas());

      await primerMensajeDeApp(CLIENTE);

      expect(h.execute).toHaveBeenCalledTimes(1);
      const q = consulta();
      expect(q.sql).toContain("set primer_mensaje_en = now()");
      expect(q.sql).toContain("b.origen = 'app_propia'");
      expect(q.sql).toContain("b.primer_mensaje_en is null");
      expect(q.params).toEqual([CLIENTE]);
    });

    it("sólo en una fila conectada o en falla: en una alta a medias nadie atendió el mensaje", async () => {
      h.execute.mockResolvedValue(filas());

      await primerMensajeDeApp(CLIENTE);

      expect(consulta().sql).toContain("b.estado in ('conectada', 'falla')");
    });

    it("es información: no mueve la hora del último cambio de estado", async () => {
      h.execute.mockResolvedValue(filas());

      await primerMensajeDeApp(CLIENTE);

      expect(consulta().sql).not.toContain("actualizado_en");
    });
  });

  describe("primeraRespuestaDeApp", () => {
    it("anota la hora una sola vez, sólo en una app propia conectada o en falla, con el espacio por parámetro", async () => {
      h.execute.mockResolvedValue(filas());

      await primeraRespuestaDeApp(CLIENTE);

      expect(h.execute).toHaveBeenCalledTimes(1);
      const q = consulta();
      expect(q.sql).toContain("primera_respuesta_en = now()");
      expect(q.sql).toContain("b.origen = 'app_propia'");
      expect(q.sql).toContain("b.primera_respuesta_en is null");
      expect(q.sql).toContain("b.estado in ('conectada', 'falla')");
      expect(q.params).toEqual(expect.arrayContaining([CLIENTE]));
      expect(q.sql).not.toContain(CLIENTE);
    });

    it("sólo levanta la falla pago_pendiente: ninguna otra falla vuelve a conectada por una respuesta", async () => {
      h.execute.mockResolvedValue(filas());

      await primeraRespuestaDeApp(CLIENTE);

      const q = consulta();
      expect(q.sql).toContain("when b.estado = 'falla' and b.falla = 'pago_pendiente' then 'conectada'");
      expect(q.sql).toContain("when b.estado = 'falla' and b.falla = 'pago_pendiente' then null else b.falla");
      for (const otra of ["token_vencido", "secreto_invalido", "waba_restringida", "waba_bloqueada", "nombre_rechazado"]) {
        expect(q.sql).not.toContain(otra);
      }
    });

    it("no toca el número, el token ni el secreto", async () => {
      h.execute.mockResolvedValue(filas());

      await primeraRespuestaDeApp(CLIENTE);

      const q = consulta();
      expect(q.sql).not.toContain("whatsapp_numeros");
      expect(q.sql).not.toContain("token_cifrado");
      expect(q.sql).not.toContain("app_secreto_cifrado");
    });
  });

  describe("saludDeApp", () => {
    it.each(["AVAILABLE", "LIMITED", "BLOCKED"] as const)("guarda «%s» por parámetro, sólo si cambió", async (puede) => {
      h.execute.mockResolvedValue(filas());

      await saludDeApp(CLIENTE, puede);

      expect(h.execute).toHaveBeenCalledTimes(1);
      const q = consulta();
      expect(q.sql).toContain("set puede_enviar =");
      expect(q.sql).toContain("b.puede_enviar is distinct from");
      expect(q.sql).toContain("b.origen = 'app_propia'");
      expect(q.sql).toContain("b.estado in ('conectada', 'falla')");
      expect(q.params).toEqual(expect.arrayContaining([CLIENTE, puede]));
      expect(q.sql).not.toContain(puede);
    });

    it("es información: no mueve la hora del último cambio de estado", async () => {
      h.execute.mockResolvedValue(filas());

      await saludDeApp(CLIENTE, "AVAILABLE");

      expect(consulta().sql).not.toContain("actualizado_en");
    });
  });
});

describe("despublicarLegales", () => {
  it("es una sola sentencia: borra el slug de una app propia y asienta el evento, con el actor, la IP y el espacio por parámetro", async () => {
    h.execute.mockResolvedValue(filas({ n: 1, tenant_id: CLIENTE }));

    expect(await despublicarLegales(CLIENTE, OP)).toBe("ok");

    expect(h.execute).toHaveBeenCalledTimes(1);
    const q = consulta();
    expect(q.sql).toContain("update public.whatsapp_wabas b set slug_legal = null");
    expect(q.sql).toContain("b.origen = 'app_propia'");
    expect(q.sql).toContain("b.slug_legal is not null");
    expect(cuantas(q.sql, "insert into public.audit_log")).toBe(1);
    expect(q.params).toEqual(
      expect.arrayContaining([CLIENTE, OP.userId, OP.ip, AuditEvent.WHATSAPP_APP_LEGALES_DESPUBLICADAS, "whatsapp_waba"])
    );
    expect(q.sql).not.toContain(CLIENTE);
    expect(q.sql).not.toContain(OP.userId);
  });

  it("el asiento lleva sólo la vía del operador: ni el slug ni nada del cliente", async () => {
    h.execute.mockResolvedValue(filas({ n: 1, tenant_id: CLIENTE }));

    await despublicarLegales(CLIENTE, OP);

    const { params } = consulta();
    expect(params.filter((x) => typeof x === "string" && x.startsWith("{"))).toEqual([JSON.stringify({ via: "operador" })]);
  });

  it("no toca el estado, el token ni el secreto: el cliente sigue conectado, sólo cambian las páginas", async () => {
    h.execute.mockResolvedValue(filas({ n: 1, tenant_id: CLIENTE }));

    await despublicarLegales(CLIENTE, OP);

    const { sql } = consulta();
    expect(sql).not.toContain("estado =");
    expect(sql).not.toContain("token_cifrado");
    expect(sql).not.toContain("app_secreto_cifrado");
    expect(sql.toLowerCase()).not.toContain("delete");
  });

  it("es sólo de control: no espeja a la base del cliente", async () => {
    h.execute.mockResolvedValue(filas({ n: 1, tenant_id: CLIENTE }));

    await despublicarLegales(CLIENTE, OP);

    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("si no había páginas publicadas (ya bajadas, otra vía, otro espacio) es no_aplica, no un error", async () => {
    h.execute.mockResolvedValue(filas({ n: 0, tenant_id: null }));

    expect(await despublicarLegales(CLIENTE, OP)).toBe("no_aplica");
  });

  it("sin la 0051 devuelve migracion_pendiente, y otro error de la base sube", async () => {
    h.execute.mockRejectedValue(errorPg("42P01"));
    expect(await despublicarLegales(CLIENTE, OP)).toBe("migracion_pendiente");

    h.execute.mockReset();
    h.execute.mockRejectedValue(errorPg("57014"));
    await expect(despublicarLegales(CLIENTE, OP)).rejects.toMatchObject({ code: "57014" });
  });
});

describe("listarAltas con la WABA propia", () => {
  const sinWaba = { creadas_24h: 1, tenant_id: CLIENTE, nombre: "Seguros Fake", plan: "piloto", billing_status: "trial", numero_id: null };

  it("trae la WABA en la misma consulta y la arma en camelCase", async () => {
    h.execute.mockResolvedValue(
      filas({
        ...sinWaba,
        waba_estado: "falla",
        waba_falla: "token_vencido",
        waba_paso_cancelado: null,
        waba_propia_id: WABA_DEL_CLIENTE,
        waba_business_id: "999000111",
        waba_nombre_estado: "APPROVED",
        waba_plantilla_enviada_en: new Date("2026-10-08T12:00:00Z"),
        waba_actualizado_en: "2026-10-09T01:02:03Z",
      })
    );

    const panel = await listarAltas();

    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(consulta().sql).toContain("left join public.whatsapp_wabas b on b.tenant_id = t.id");
    expect(panel.altas[0].waba).toEqual({
      estado: "falla",
      falla: "token_vencido",
      pasoCancelado: null,
      wabaId: WABA_DEL_CLIENTE,
      businessId: "999000111",
      nombreEstado: "APPROVED",
      plantillaEnviadaEn: "2026-10-08T12:00:00.000Z",
      actualizadoEn: "2026-10-09T01:02:03Z",
      origen: "embedded_signup",
      appId: null,
      webhookVerificadoEn: null,
      datosAppEn: null,
      primerMensajeEn: null,
      primeraRespuestaEn: null,
      puedeEnviar: null,
      recordatorioEn: null,
      legalesPublicadas: false,
    });
  });

  it("de la app propia trae el origen, el App ID y los hitos del alta, en la misma consulta", async () => {
    h.execute.mockResolvedValue(
      filas({
        ...sinWaba,
        waba_estado: "conectada",
        waba_origen: "app_propia",
        waba_app_id: "123456789012345",
        waba_webhook_verificado_en: "2026-10-09T01:00:00Z",
        waba_datos_app_en: new Date("2026-10-09T01:05:00Z"),
        waba_primer_mensaje_en: "2026-10-09T02:00:00Z",
        waba_primera_respuesta_en: "2026-10-09T02:00:30Z",
        waba_puede_enviar: "LIMITED",
        waba_recordatorio_en: "2026-10-10T12:00:00Z",
        waba_legales: true,
      })
    );

    const panel = await listarAltas();

    expect(h.execute).toHaveBeenCalledTimes(1);
    const { sql: texto } = consulta();
    for (const columna of ["b.origen", "b.app_id", "b.webhook_app_verificado_en", "b.datos_app_en", "b.primer_mensaje_en"]) {
      expect(texto).toContain(columna);
    }
    expect(texto).toContain("(b.slug_legal is not null) as waba_legales");
    expect(panel.altas[0].waba).toMatchObject({
      origen: "app_propia",
      appId: "123456789012345",
      webhookVerificadoEn: "2026-10-09T01:00:00Z",
      datosAppEn: "2026-10-09T01:05:00.000Z",
      primerMensajeEn: "2026-10-09T02:00:00Z",
      primeraRespuestaEn: "2026-10-09T02:00:30Z",
      puedeEnviar: "LIMITED",
      recordatorioEn: "2026-10-10T12:00:00Z",
      legalesPublicadas: true,
    });
  });

  it("nunca trae el secreto ni el slug de las páginas legales: el panel sólo ve si hay páginas publicadas", async () => {
    h.execute.mockResolvedValue(filas(sinWaba));

    await listarAltas();

    const { sql: texto } = consulta();
    expect(texto).not.toContain("app_secreto_cifrado");
    expect(texto).not.toMatch(/b\.slug_legal(?! is not null)/);
  });

  it.each(["otra", null, undefined])("un origen raro (%s) se muestra como Embedded Signup, la vía de antes", async (origen) => {
    h.execute.mockResolvedValue(filas({ ...sinWaba, waba_estado: "conectada", waba_origen: origen }));

    expect((await listarAltas()).altas[0].waba?.origen).toBe("embedded_signup");
  });

  it("sin fila de WABA la propiedad es null: el espacio usa la de la plataforma", async () => {
    h.execute.mockResolvedValue(filas(sinWaba));

    expect((await listarAltas()).altas[0].waba).toBeNull();
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
    expect(await listarAltas()).toEqual({
      migracionPendiente: false,
      altas: [],
      creadas24h: 5,
      tope: 20,
      demoraDeAlta: { mediana: null, p95: null },
    });

    h.execute.mockResolvedValue(filas());
    expect(await listarAltas()).toMatchObject({ altas: [], creadas24h: 0 });
  });

  it("la mediana y el p95 de 30 días salen de tenant_bases en la misma consulta", async () => {
    h.execute.mockResolvedValue(filas({ creadas_24h: 0, tenant_id: null, demora_mediana_s: 95, demora_p95_s: 610 }));

    const panel = await listarAltas();

    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(panel.demoraDeAlta).toEqual({ mediana: 95, p95: 610 });
    const q = consulta();
    expect(q.sql).toContain("percentile_cont(0.5)");
    expect(q.sql).toContain("percentile_cont(0.95)");
    expect(q.sql).toContain("from public.tenant_bases tb");
    expect(q.sql).toContain("tb.lista_at - tb.creada_at");
    expect(q.sql).toContain("x.autoalta");
    expect(q.params).toEqual(expect.arrayContaining([30]));
  });

  it("sin altas listas en 30 días la demora es null, no cero", async () => {
    h.execute.mockResolvedValue(filas({ creadas_24h: 1, tenant_id: null, demora_mediana_s: null, demora_p95_s: null }));
    expect((await listarAltas()).demoraDeAlta).toEqual({ mediana: null, p95: null });

    h.execute.mockResolvedValue(filas());
    expect((await listarAltas()).demoraDeAlta).toEqual({ mediana: null, p95: null });
  });

  it("sin la 0048 devuelve migracionPendiente, y otro error sube", async () => {
    for (const codigo of ["42P01", "42703", "42883"]) {
      h.execute.mockReset();
      h.execute.mockRejectedValue(errorPg(codigo));
      expect(await listarAltas()).toEqual({
        migracionPendiente: true,
        altas: [],
        creadas24h: 0,
        tope: 20,
        demoraDeAlta: { mediana: null, p95: null },
      });
    }
    h.execute.mockReset();
    h.execute.mockRejectedValue(errorPg("08006"));
    await expect(listarAltas()).rejects.toMatchObject({ code: "08006" });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });

  it("sin la 0051 (falta sólo whatsapp_wabas) el panel sigue: reintenta sin esa tabla y ningún espacio tiene WABA propia", async () => {
    h.execute
      .mockRejectedValueOnce(errorPg("42P01"))
      .mockResolvedValueOnce(filas({ creadas_24h: 1, tenant_id: CLIENTE, nombre: "Seguros Fake", plan: "piloto", billing_status: "trial", numero_id: null, waba_estado: null }));

    const panel = await listarAltas();

    expect(panel.migracionPendiente).toBe(false);
    expect(panel.altas).toHaveLength(1);
    expect(panel.altas[0].waba).toBeNull();
    expect(h.execute).toHaveBeenCalledTimes(2);
    expect(consulta(0).sql).toContain("public.whatsapp_wabas");
    expect(consulta(1).sql).not.toContain("whatsapp_wabas");
  });
});

// ── Lo que dice la pantalla ─────────────────────────────────────────────────

describe("resultadoDelPanel", () => {
  it("acepta sólo los códigos de la lista cerrada: lo demás del ?r= se descarta", () => {
    for (const r of RESULTADOS_DEL_PANEL) expect(resultadoDelPanel(r)).toBe(r);
    for (const raro of [undefined, null, "", "<script>", "OK", "ok ", ["ok"], 7]) expect(resultadoDelPanel(raro)).toBeNull();
  });

  it("el webhook del número tiene sus dos códigos en la lista cerrada", () => {
    for (const r of ["sin_webhook", "webhook_ajeno"]) {
      expect(RESULTADOS_DEL_PANEL).toContain(r);
      expect(resultadoDelPanel(r)).toBe(r);
    }
  });

  it("bajar las páginas legales tiene su código", () => {
    expect(RESULTADOS_DEL_PANEL).toContain("legales_despublicadas");
    expect(resultadoDelPanel("legales_despublicadas")).toBe("legales_despublicadas");
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
      "numero_distinto", "fuera_de_la_waba", "de_otro_ambiente", "sin_webhook", "webhook_ajeno",
    ];
    for (const r of devueltos) expect(resultadoDelPanel(r), r).toBe(r);
  });
});
