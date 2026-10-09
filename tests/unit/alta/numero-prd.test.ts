/**
 * El número por código en un ambiente que comparte la app de Meta con otro (prd y
 * dev): el contrato de punta a punta, con Graph simulado a nivel de `fetch`.
 *
 * Acá corre de verdad `numero-automatico`, `alta-de-numero`, `numeros` y
 * `espejar-sin-fallar`; sólo Graph, la base, el contador de cupos, el aviso al
 * operador y la copia a la base del cliente (`espejar`) están simulados. Se afirma
 * lo que importa del contrato:
 *
 *   - el número se escribe en control y recién después se espeja, sin que el espejo
 *     haga fallar el paso;
 *   - se le pone su webhook propio (`NEXT_PUBLIC_SITE_URL` + el token del ambiente)
 *     y 'conectado' se guarda sólo después de leer de Graph esa misma URL;
 *   - un número de la lista del otro ambiente no sale a Meta ni se guarda;
 *   - si Meta no da lugar, el número queda 'pedido' y el operador se entera.
 *
 * El orden de las llamadas y qué se manda en cada una está en `orden` y en los
 * cuerpos que vio el `fetch`; el detalle de cada URL, en
 * `tests/unit/whatsapp/alta-de-numero.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  liberarCupo: vi.fn(),
  /** Lo que devuelve la consulta de la fila del número. */
  leer: vi.fn(),
  /** Lo que devuelve `db.execute` (la función de la 0049). */
  guardar: vi.fn(),
  espejar: vi.fn(),
  aviso: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  /** Lo que pasó, en el orden en que pasó: llamadas a Graph, escrituras y copias. */
  orden: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // Igual que Next: la tarea corre después; acá corre en el momento.
  after: (tarea: () => unknown) => {
    void tarea();
  },
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/security/cifrado", () => ({ descifrar: (sobre: string) => sobre }));
vi.mock("@/data/scope", () => {
  const cadena: Record<string, unknown> = {};
  for (const paso of ["from", "innerJoin", "where", "limit"]) cadena[paso] = () => cadena;
  cadena.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => h.leer().then(ok, ko);
  const db = {
    select: () => cadena,
    execute: (consulta: { queryChunks: unknown[] }) => {
      const valores = consulta.queryChunks.filter((c) => typeof c !== "object" || c === null);
      h.orden.push(`guardar:${String(valores[2])}`);
      return h.guardar();
    },
  };
  return {
    enControl: async (_ctx: unknown, armar: (db: unknown) => unknown) => armar(db),
  };
});
vi.mock("@/server/bases/espejo", () => ({ espejar: h.espejar }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: h.error },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: h.rateLimit, liberarCupo: h.liberarCupo }));
vi.mock("@/server/alta/aviso-operador", () => ({ avisarNumeroEnRevision: h.aviso }));

import { enUS, esAR } from "@/lib/i18n";
import { pedirCodigo, verificarCodigo, type QuienPide } from "@/server/alta/numero-automatico";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USUARIO = "22222222-2222-4222-8222-222222222222";
const WABA = "200000000000001";
const PLATAFORMA = "100000000000001";
const ID = "100000000000777";
const NUMERO = "+5491100000000";
const CODIGO = "123456";
const SITIO = "https://claimmix.example.com";
const WEBHOOK = `${SITIO}/api/webhooks/whatsapp`;
const TOKEN_DE_APRETON = "fake-verify-token";
const WEBHOOK_DE_DEV = "https://dev.example.com/api/webhooks/whatsapp";
const BASE = "https://graph.facebook.com/v22.0";

const QUIEN: QuienPide = { tenantId: TENANT, userId: USUARIO, ip: "203.0.113.7", idioma: "es-AR" };

const ENTORNO = [
  "ALTA_NUMERO_AUTOMATICO",
  "NUMEROS_DE_DEV",
  "NEXT_PUBLIC_SITE_URL",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
  "WHATSAPP_API_VERSION",
] as const;
const guardado: Record<string, string | undefined> = {};

const RUTA = {
  recorrer: `GET ${WABA}/phone_numbers?fields=id,display_phone_number,verified_name&limit=100`,
  agregar: `POST ${WABA}/phone_numbers`,
  pedirCodigo: `POST ${ID}/request_code`,
  verificar: `POST ${ID}/verify_code`,
  estado: `GET ${ID}?fields=status,platform_type`,
  registrar: `POST ${ID}/register`,
  fijarWebhook: `POST ${ID}`,
  leerWebhook: `GET ${ID}?fields=webhook_configuration`,
};

const fila = (extra: Record<string, unknown> = {}) => ({
  numero_e164: NUMERO,
  estado: "pedido",
  phone_number_id: null,
  billing_status: "trial",
  trial_ends_at: "2099-01-01T00:00:00.000Z",
  autoalta: true,
  funcion: true,
  ...extra,
});

const json = (cuerpo: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => cuerpo }) as Response;

/** Lo que Meta contesta a una ruta, en vez de lo de siempre. */
const forzadas = new Map<string, Response>();
/** El webhook propio que Meta tiene para el número, o null si nadie se lo puso. */
let webhookPuesto: { override_callback_uri: string; verify_token: string } | null;
/** Lo que mandó cada llamada con cuerpo, por ruta. */
let cuerpos: Map<string, unknown>;
/** Rutas que se pidieron y el simulador no conoce: tiene que quedar vacía. */
let sinSimular: string[];

function instalarGraph() {
  const fetchFalso = vi.fn(async (url: string, init: RequestInit) => {
    const clave = `${init.method ?? "GET"} ${url.replace(`${BASE}/`, "")}`;
    h.orden.push(clave);
    if (init.body) cuerpos.set(clave, JSON.parse(init.body as string));
    const forzada = forzadas.get(clave);
    if (forzada) return forzada;

    switch (clave) {
      case RUTA.recorrer:
        return json({ data: [{ id: PLATAFORMA, display_phone_number: "+54 9 291 642-6930", verified_name: "Veltra" }] });
      case RUTA.agregar:
        return json({ id: ID });
      case RUTA.pedirCodigo:
      case RUTA.verificar:
      case RUTA.registrar:
        return json({ success: true });
      case RUTA.estado:
        return json({ status: "PENDING", platform_type: "NOT_APPLICABLE" });
      case RUTA.fijarWebhook:
        webhookPuesto = (cuerpos.get(clave) as { webhook_configuration: NonNullable<typeof webhookPuesto> }).webhook_configuration;
        return json({ success: true });
      case RUTA.leerWebhook:
        return json({
          webhook_configuration: webhookPuesto
            ? { application: WEBHOOK_DE_DEV, phone_number: webhookPuesto.override_callback_uri }
            : { application: WEBHOOK_DE_DEV },
        });
      default:
        sinSimular.push(clave);
        return json({ error: { code: 100 } }, 404);
    }
  });
  vi.stubGlobal("fetch", fetchFalso);
  return fetchFalso;
}

const llamadasAGraph = () => h.orden.filter((x) => /^(GET|POST) /.test(x));
const escrituras = () => h.orden.filter((x) => x.startsWith("guardar:"));

beforeEach(() => {
  vi.clearAllMocks();
  h.orden.length = 0;
  forzadas.clear();
  cuerpos = new Map();
  sinSimular = [];
  webhookPuesto = null;
  for (const k of ENTORNO) {
    guardado[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ALTA_NUMERO_AUTOMATICO = "1";
  process.env.NEXT_PUBLIC_SITE_URL = SITIO;
  process.env.WHATSAPP_VERIFY_TOKEN = TOKEN_DE_APRETON;
  process.env.WHATSAPP_ACCESS_TOKEN = "fake-access-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = PLATAFORMA;
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = WABA;

  h.rateLimit.mockResolvedValue({ allowed: true, remaining: 0, resetAt: 0, retryAfterSeconds: 0, ventana: 1 });
  h.liberarCupo.mockResolvedValue(undefined);
  h.aviso.mockResolvedValue(undefined);
  h.leer.mockResolvedValue([fila()]);
  h.guardar.mockResolvedValue({ rows: [{ r: { resultado: "ok" } }] });
  h.espejar.mockImplementation(async () => {
    h.orden.push("espejar");
  });
  instalarGraph();
});

afterEach(() => {
  expect(sinSimular).toEqual([]);
  vi.unstubAllGlobals();
  for (const k of ENTORNO) {
    if (guardado[k] === undefined) delete process.env[k];
    else process.env[k] = guardado[k];
  }
});

describe("el número en control y su copia", () => {
  it("pedir el código: suma el número a la WABA, lo guarda en control, lo espeja y recién entonces pide el SMS", async () => {
    expect(await pedirCodigo(QUIEN, "SMS")).toBe("codigo_enviado");

    expect(h.orden).toEqual([RUTA.recorrer, RUTA.agregar, "guardar:agregado", "espejar", RUTA.pedirCodigo]);
    expect(h.espejar).toHaveBeenCalledWith(TENANT);
  });

  it("verificar el código: 'conectado' se guarda y se espeja al final, con el espacio de la sesión", async () => {
    h.leer.mockResolvedValue([fila({ phone_number_id: ID })]);

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("conectado");

    expect(h.orden.at(-2)).toBe("guardar:conectado");
    expect(h.orden.at(-1)).toBe("espejar");
    expect(h.espejar).toHaveBeenCalledTimes(1);
    expect(h.espejar).toHaveBeenCalledWith(TENANT);
  });

  it("si la copia no entra (la base del cliente caída), el paso sale igual y queda anotado el código, no las filas", async () => {
    h.leer.mockResolvedValue([fila({ phone_number_id: ID })]);
    h.espejar.mockRejectedValue(Object.assign(new Error("fila con ana@example.com"), { code: "08006" }));

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("conectado");

    expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT, detalle: "08006" }, "bases.espejo_pendiente");
    expect(JSON.stringify([h.warn.mock.calls, h.error.mock.calls])).not.toContain("ana@example.com");
  });

  it("si control no guardó el paso, no se espeja nada", async () => {
    h.guardar.mockResolvedValue({ rows: [{ r: { resultado: "no_aplica" } }] });

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    expect(h.espejar).not.toHaveBeenCalled();
  });
});

describe("el webhook propio del número", () => {
  beforeEach(() => {
    h.leer.mockResolvedValue([fila({ phone_number_id: ID })]);
  });

  it("se pone con la URL de este sitio y el token del ambiente, se lee de Graph y recién entonces queda 'conectado'", async () => {
    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("conectado");

    expect(h.orden).toEqual([
      RUTA.verificar,
      RUTA.estado,
      RUTA.registrar,
      RUTA.fijarWebhook,
      RUTA.leerWebhook,
      "guardar:conectado",
      "espejar",
    ]);
    expect(cuerpos.get(RUTA.fijarWebhook)).toEqual({
      webhook_configuration: { override_callback_uri: WEBHOOK, verify_token: TOKEN_DE_APRETON },
    });
    expect(webhookPuesto?.override_callback_uri).toBe(`${process.env.NEXT_PUBLIC_SITE_URL}/api/webhooks/whatsapp`);
  });

  it("un número que Meta ya tiene registrado no se registra otra vez, pero sí se le pone el webhook", async () => {
    forzadas.set(RUTA.estado, json({ status: "CONNECTED", platform_type: "CLOUD_API" }));

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("conectado");

    expect(llamadasAGraph()).not.toContain(RUTA.registrar);
    expect(llamadasAGraph()).toContain(RUTA.fijarWebhook);
    expect(escrituras()).toEqual(["guardar:conectado"]);
  });

  it.each([
    ["el webhook de dev (el de la app)", json({ webhook_configuration: { application: WEBHOOK_DE_DEV } })],
    ["otra URL en el propio del número", json({ webhook_configuration: { phone_number: WEBHOOK_DE_DEV } })],
    ["una URL parecida, con un camino de más", json({ webhook_configuration: { phone_number: `${WEBHOOK}/dev` } })],
    ["sin webhook_configuration", json({ id: ID })],
    ["una configuración vacía", json({ webhook_configuration: {} })],
  ])("el GET trae %s, no el de este sitio: no queda 'conectado', se avisa al operador y no se espeja", async (_cual, respuesta) => {
    forzadas.set(RUTA.leerWebhook, respuesta);

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("revision");

    expect(llamadasAGraph()).toContain(RUTA.fijarWebhook);
    expect(escrituras()).toEqual([]);
    expect(h.espejar).not.toHaveBeenCalled();
    expect(h.aviso).toHaveBeenCalledTimes(1);
    expect(h.aviso).toHaveBeenCalledWith("sin_webhook", TENANT);
  });

  it("Meta no contesta el GET (500): «meta», sin 'conectado' ni aviso, para que la persona reintente", async () => {
    forzadas.set(RUTA.leerWebhook, json({}, 500));

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("meta");

    expect(escrituras()).toEqual([]);
    expect(h.espejar).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("Meta rechaza ponerlo: revision y aviso rechazo, sin leerlo ni guardar", async () => {
    forzadas.set(RUTA.fijarWebhook, json({ error: { code: 100 } }, 400));

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("revision");

    expect(llamadasAGraph()).not.toContain(RUTA.leerWebhook);
    expect(escrituras()).toEqual([]);
    expect(h.aviso).toHaveBeenCalledWith("rechazo", TENANT);
  });

  it("el reintento tras un webhook que no quedó repite el webhook sin registrar de nuevo", async () => {
    forzadas.set(RUTA.leerWebhook, json({ webhook_configuration: { application: WEBHOOK_DE_DEV } }));
    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("revision");

    forzadas.clear();
    forzadas.set(RUTA.estado, json({ status: "CONNECTED", platform_type: "CLOUD_API" }));
    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("conectado");

    expect(llamadasAGraph().filter((x) => x === RUTA.registrar)).toHaveLength(1);
    expect(llamadasAGraph().filter((x) => x === RUTA.fijarWebhook)).toHaveLength(2);
    expect(escrituras()).toEqual(["guardar:conectado"]);
  });

  it.each([
    ["sin NEXT_PUBLIC_SITE_URL", () => delete process.env.NEXT_PUBLIC_SITE_URL],
    ["con un sitio http", () => (process.env.NEXT_PUBLIC_SITE_URL = "http://claimmix.example.com")],
    ["sin WHATSAPP_VERIFY_TOKEN", () => delete process.env.WHATSAPP_VERIFY_TOKEN],
  ])("%s: no se toca Meta, no se guarda nada y el operador se entera", async (_cual, preparar) => {
    preparar();

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("revision");
    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    expect(h.orden).toEqual([]);
    expect(h.aviso).toHaveBeenCalledWith("sin_credencial", TENANT);
    expect(h.espejar).not.toHaveBeenCalled();
  });

  it("el token del apretón de manos viaja sólo en el cuerpo del pedido: ni en una URL, ni en el log, ni en el aviso", async () => {
    forzadas.set(RUTA.leerWebhook, json({ webhook_configuration: { application: WEBHOOK_DE_DEV } }));

    await verificarCodigo(QUIEN, CODIGO);

    expect(h.orden.join("\n")).not.toContain(TOKEN_DE_APRETON);
    expect(JSON.stringify([h.warn.mock.calls, h.error.mock.calls, h.aviso.mock.calls])).not.toContain(TOKEN_DE_APRETON);
  });
});

describe("un número del otro ambiente", () => {
  it.each([
    ["por su número", NUMERO],
    ["por su número escrito con otro formato", "+54 11 0000-0000"],
  ])("%s: no sale a Meta, no se guarda, no se espeja, avisa y devuelve los cupos", async (_cual, enLaLista) => {
    process.env.NUMEROS_DE_DEV = `5490000000001, ${enLaLista}`;

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    expect(h.orden).toEqual([]);
    expect(h.espejar).not.toHaveBeenCalled();
    expect(h.aviso).toHaveBeenCalledTimes(1);
    expect(h.aviso).toHaveBeenCalledWith("de_otro_ambiente", TENANT);
    expect(h.liberarCupo).toHaveBeenCalledTimes(3);
  });

  it("por el id de Meta que ya tenía: no se verifica, no se registra y no se le pone webhook", async () => {
    process.env.NUMEROS_DE_DEV = ID;
    h.leer.mockResolvedValue([fila({ phone_number_id: ID })]);

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("revision");

    expect(h.orden).toEqual([]);
    expect(h.aviso).toHaveBeenCalledWith("de_otro_ambiente", TENANT);
  });

  it("sin NUMEROS_DE_DEV, o con otros números en la lista, el alta sigue", async () => {
    expect(await pedirCodigo(QUIEN, "SMS")).toBe("codigo_enviado");

    process.env.NUMEROS_DE_DEV = "5490000000001, 5490000000021";
    h.orden.length = 0;
    expect(await pedirCodigo(QUIEN, "SMS")).toBe("codigo_enviado");
    expect(h.aviso).not.toHaveBeenCalledWith("de_otro_ambiente", TENANT);
  });
});

describe("cuando Meta no da lugar", () => {
  it("rechaza sumar el número (tope de números sin verificar el negocio): queda 'pedido', sin código ni copia, y avisa", async () => {
    forzadas.set(RUTA.agregar, json({ error: { code: 100 } }, 400));

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    expect(h.orden).toEqual([RUTA.recorrer, RUTA.agregar]);
    expect(escrituras()).toEqual([]);
    expect(h.espejar).not.toHaveBeenCalled();
    expect(h.aviso).toHaveBeenCalledWith("rechazo", TENANT);
  });

  it("la WABA ya está en su tope: ni se intenta sumar, queda 'pedido' y avisa", async () => {
    forzadas.set(
      RUTA.recorrer,
      json({
        data: [
          { id: PLATAFORMA, display_phone_number: "+54 9 291 642-6930", verified_name: "Veltra" },
          { id: "100000000000555", display_phone_number: "+54 9 11 5555-1111" },
        ],
      })
    );

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    expect(h.orden).toEqual([RUTA.recorrer]);
    expect(escrituras()).toEqual([]);
    expect(h.espejar).not.toHaveBeenCalled();
    expect(h.aviso).toHaveBeenCalledWith("sin_lugar", TENANT);
  });
});

describe("avisar que el número no puede seguir en la app de WhatsApp", () => {
  it.each([
    ["es-AR", esAR, /app de WhatsApp/],
    ["en-US", enUS, /WhatsApp or WhatsApp Business app/],
  ] as const)("la pantalla lo dice antes de pedir el código (%s)", (_idioma, textos, frase) => {
    expect(textos["configuracion.numero.antes"]).toMatch(frase);
  });
});
