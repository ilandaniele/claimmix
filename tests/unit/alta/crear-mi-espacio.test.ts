/**
 * `crearMiEspacio`: la acción de /alta, la del segundo paso del alta.
 *
 * Se prueba con `crearEspacio` y la función de `crearInquilino` de verdad; lo único que se
 * sustituye es la base (`enControl`), el limitador, el mail y la sesión. Lo que
 * importa acá no es que cree el espacio sino el orden de lo que se hace antes y
 * lo que se devuelve después:
 *   - nada de esto gasta un cupo hasta haber visto que hay algo que crear;
 *   - se libera SÓLO lo que se tomó, y sólo si no quedó espacio;
 *   - sin la 0048 (42883/42P01/42703) el alta queda cerrada, no rota;
 *   - el `redirect` va afuera de todo try/catch.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sesion: vi.fn(),
  fila: vi.fn(),
  enControl: vi.fn(),
  iniciarBase: vi.fn(),
  rateLimit: vi.fn(),
  liberarCupo: vi.fn(),
  remitente: vi.fn(),
  enviar: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  /** Lo que la acción dejó para después de responder (`after`). */
  pendientes: [] as Array<() => unknown>,
}));

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "x-forwarded-for": "203.0.113.7" })),
}));

/** `redirect` tira, igual que en Next: se atrapa el destino. */
class RedirigioA extends Error {
  constructor(public readonly destino: string) {
    super(`NEXT_REDIRECT:${destino}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new RedirigioA(destino);
  },
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (tarea: () => unknown) => {
    h.pendientes.push(tarea);
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSessionContext: h.sesion }));
vi.mock("@/lib/auth/user-row", () => ({ getUserRowOrThrow: h.fila }));
vi.mock("@/lib/auth/operator-emails", () => ({ operatorEmails: () => ["ops@example.com"] }));
vi.mock("@/lib/auth/require-operator", () => ({
  isOperatorEmail: (e: string | null | undefined) => e === "ops@example.com",
}));
vi.mock("@/data/scope", () => ({ enControl: h.enControl }));
vi.mock("@/server/bases/iniciar", () => ({ iniciarBase: h.iniciarBase }));
vi.mock("@/server/notify/remitente-sistema", () => ({
  remitenteDelSistema: h.remitente,
  enviarCorreoDelSistema: h.enviar,
}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: h.error },
}));
vi.mock("@/lib/rate-limit/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit/index")>()),
  rateLimit: h.rateLimit,
  liberarCupo: h.liberarCupo,
}));

import { claveDeCupo } from "@/lib/rate-limit/clave";
import { PRIMEROS_PASOS } from "@/server/alta/pasos-hechos";

const DIA_MS = 24 * 60 * 60_000;
const VENTANA = 1_700_000_000_000;
const USUARIO = "11111111-1111-4111-8111-111111111111";
const IP = "203.0.113.7";
const CLAVE_IP = claveDeCupo("alta:ip", IP);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const CAMPOS_BUENOS = {
  empresa: "  Seguros del Sur  ",
  whatsapp: "+54 9 (291) 642-6930",
  terminos: "on",
};

const cupo = (extra: Record<string, unknown> = {}) => ({
  allowed: true,
  remaining: 2,
  resetAt: VENTANA + DIA_MS,
  retryAfterSeconds: 0,
  ventana: VENTANA,
  ...extra,
});

const respuesta = (r: Record<string, unknown>) => [{ r }];

function sesion(extra: Record<string, unknown> = {}) {
  h.sesion.mockResolvedValue({
    user: { id: USUARIO, email: "ana@example.com", emailVerified: true, ...extra },
  });
}

/** Corre la acción y devuelve adónde redirigió. Que no redirija es un error de la prueba. */
async function crear(campos: Record<string, string> = CAMPOS_BUENOS): Promise<string> {
  const { crearMiEspacio } = await import("@/app/alta/actions");
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.set(k, v);
  try {
    await crearMiEspacio(fd);
  } catch (e) {
    if (e instanceof RedirigioA) return e.destino;
    throw e;
  }
  throw new Error("la acción no redirigió");
}

/** Lo que la base recibió: el contexto y la consulta ya armada, con sus parámetros. */
async function llamadaALaBase() {
  const [contexto, armar] = h.enControl.mock.calls[0];
  let consulta: Parameters<PgDialect["sqlToQuery"]>[0] | undefined;
  await armar({
    execute: (q: typeof consulta) => {
      consulta = q;
      return [];
    },
  });
  return { contexto, ...new PgDialect().sqlToQuery(consulta!) };
}

function errorDePg(code: string) {
  return Object.assign(new Error("fallo de la base"), { code });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.pendientes.length = 0;
  process.env.ALTA_AUTOMATICA = "1";
  delete process.env.SIGNUP_ALLOWED_EMAILS;
  delete process.env.ALTA_TOPE_IP_DIA;
  delete process.env.ALTA_TOPE_GLOBAL_DIA;
  delete process.env.ALTA_TOPE_BASES;
  delete process.env.ALTA_TOPE_MB;
  delete process.env.BASE_POR_CLIENTE;
  delete process.env.ALTA_PRUEBA_DIAS;
  sesion();
  h.fila.mockResolvedValue(null);
  h.rateLimit.mockResolvedValue(cupo());
  h.liberarCupo.mockResolvedValue(undefined);
  h.remitente.mockReturnValue("alta@example.com");
  h.iniciarBase.mockResolvedValue(undefined);
  h.enviar.mockResolvedValue({ enviado: true });
  h.enControl.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => unknown) =>
    armar({ execute: async () => respuesta({ resultado: "ok", creadas_24h: 3, tope: 20 }) })
  );
});

describe("lo que se mira antes de tomar un cupo", () => {
  it("sin sesión va a /login", async () => {
    h.sesion.mockResolvedValue(null);

    expect(await crear()).toBe("/login");
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.enControl).not.toHaveBeenCalled();
  });

  it("con el correo sin verificar vuelve a /alta, que se lo dice", async () => {
    sesion({ emailVerified: false });

    expect(await crear()).toBe("/alta");
    expect(h.fila).not.toHaveBeenCalled();
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.enControl).not.toHaveBeenCalled();
  });

  it("una cuenta de operación recibe el rechazo", async () => {
    sesion({ email: "ops@example.com" });

    expect(await crear()).toBe("/alta");
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.enControl).not.toHaveBeenCalled();
  });

  it("con el alta cerrada para esa dirección no hace nada", async () => {
    delete process.env.ALTA_AUTOMATICA;

    expect(await crear()).toBe("/alta");
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.enControl).not.toHaveBeenCalled();
  });

  it("con el alta apagada, una dirección de la lista sí crea", async () => {
    delete process.env.ALTA_AUTOMATICA;
    process.env.SIGNUP_ALLOWED_EMAILS = "ana@example.com";

    expect(await crear()).toBe(PRIMEROS_PASOS);
  });

  it("quien ya tiene espacio va a /bandeja sin tocar ningún contador", async () => {
    h.fila.mockResolvedValue({ id: USUARIO, tenant_id: "t-1", role: "owner" });

    expect(await crear()).toBe("/bandeja");
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.liberarCupo).not.toHaveBeenCalled();
    expect(h.enControl).not.toHaveBeenCalled();
  });

  it("si la base no deja leer el perfil, no cuenta nada y no crea", async () => {
    h.fila.mockRejectedValue(new Error("timeout"));

    expect(await crear()).toBe("/alta?e=falla");
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.enControl).not.toHaveBeenCalled();
    expect(h.error).toHaveBeenCalled();
  });

  it.each([
    ["una empresa de un carácter", { ...CAMPOS_BUENOS, empresa: "a" }],
    ["una empresa con un enlace", { ...CAMPOS_BUENOS, empresa: "Acme https://example.com" }],
    ["un número sin país", { ...CAMPOS_BUENOS, whatsapp: "291 642 6930" }],
    ["sin número", { empresa: "Acme", terminos: "on" }],
    ["sin aceptar los términos", { empresa: "Acme", whatsapp: "+5492916426930" }],
  ])("%s vuelve con «datos» y no cuenta nada", async (_caso, campos) => {
    expect(await crear(campos)).toBe("/alta?e=datos");
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.enControl).not.toHaveBeenCalled();
  });
});

describe("el cupo por IP", () => {
  it("toma `alta:ip`, 3 por día, y es lo único que toma", async () => {
    await crear();

    expect(h.rateLimit).toHaveBeenCalledTimes(1);
    expect(h.rateLimit).toHaveBeenCalledWith(CLAVE_IP, { limit: 3, windowMs: DIA_MS, fallaCerrada: true });
  });

  it("ALTA_TOPE_IP_DIA cambia el tope", async () => {
    process.env.ALTA_TOPE_IP_DIA = "5";
    await crear();

    expect(h.rateLimit).toHaveBeenCalledWith(CLAVE_IP, expect.objectContaining({ limit: 5 }));
  });

  it("con el cupo agotado vuelve con «intentos» y no llega a la base", async () => {
    h.rateLimit.mockResolvedValue(cupo({ allowed: false, remaining: 0 }));

    expect(await crear()).toBe("/alta?e=intentos");
    expect(h.enControl).not.toHaveBeenCalled();
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("si el contador no contestó (ventana 0) dice «falla» y no «intentos»", async () => {
    h.rateLimit.mockResolvedValue(cupo({ allowed: false, remaining: 0, ventana: 0 }));

    expect(await crear()).toBe("/alta?e=falla");
    expect(h.enControl).not.toHaveBeenCalled();
  });
});

describe("crear el espacio", () => {
  it("llama a la función con un id nuevo que es también el contexto, y con lo normalizado", async () => {
    await crear();

    const { contexto, sql, params } = await llamadaALaBase();
    expect(sql).toContain("claimmix_crear_inquilino");
    expect(contexto.tenantId).toMatch(UUID);
    expect(contexto.tenantId).not.toBe(USUARIO);
    // Los dos topes (bases y MB) se pasan dos veces cada uno; en 0 no cuentan.
    expect(params.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(params.slice(4)).toEqual([contexto.tenantId, USUARIO, "Seguros del Sur", "+5492916426930", 30, 20, IP]);
  });

  it("el tope global y los días de prueba salen del entorno", async () => {
    process.env.ALTA_TOPE_GLOBAL_DIA = "7";
    process.env.ALTA_PRUEBA_DIAS = "14";
    await crear();

    const { params } = await llamadaALaBase();
    expect(params.slice(8, 10)).toEqual([14, 7]);
  });

  it("una IP que no es una IP llega como null, no tira el alta", async () => {
    const { headers } = await import("next/headers");
    vi.mocked(headers).mockResolvedValueOnce(new Headers());
    await crear();

    const { params } = await llamadaALaBase();
    expect(params[10]).toBeNull();
  });

  it.each(["ok", "ok_numero_en_revision"])("%s: va a los primeros pasos sin otra consulta", async (resultado) => {
    h.enControl.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => unknown) =>
      armar({ execute: async () => respuesta({ resultado, creadas_24h: 3, tope: 20 }) })
    );

    expect(await crear()).toBe(PRIMEROS_PASOS);
    expect(h.enControl).toHaveBeenCalledTimes(1);
    expect(h.liberarCupo).not.toHaveBeenCalled();
    // El redirect no se confundió con una falla: afuera del try, no pasó por el catch.
    expect(h.error).not.toHaveBeenCalled();
  });

  it("con una base por cliente lanza la base del espacio nuevo y va a /preparando", async () => {
    process.env.BASE_POR_CLIENTE = "1";

    expect(await crear()).toBe("/preparando");
    const { contexto } = await llamadaALaBase();
    expect(h.enControl).toHaveBeenCalledTimes(1);
    expect(h.iniciarBase).toHaveBeenCalledTimes(1);
    expect(h.iniciarBase).toHaveBeenCalledWith(contexto.tenantId);
  });

  it("con una base por cliente, sin espacio no lanza nada", async () => {
    process.env.BASE_POR_CLIENTE = "1";
    h.enControl.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => unknown) =>
      armar({ execute: async () => respuesta({ resultado: "alta_cerrada", creadas_24h: 20, tope: 20 }) })
    );

    expect(await crear()).toBe("/alta?e=cerrada");
    expect(h.iniciarBase).not.toHaveBeenCalled();
  });

  it("apagada la bandera no lanza nada", async () => {
    expect(await crear()).toBe(PRIMEROS_PASOS);
    expect(h.iniciarBase).not.toHaveBeenCalled();
  });

  it("el resultado puede llegar como texto JSON", async () => {
    h.enControl.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => unknown) =>
      armar({
        execute: async () => ({ rows: [{ r: JSON.stringify({ resultado: "ok", creadas_24h: 1, tope: 20 }) }] }),
      })
    );

    expect(await crear()).toBe(PRIMEROS_PASOS);
  });
});

describe("lo que se libera", () => {
  const SIN_ESPACIO: Array<[string, string]> = [
    ["alta_cerrada", "/alta?e=cerrada"],
    ["ya_tiene_espacio", "/bandeja"],
    ["no_verificado", "/alta?e=falla"],
    ["datos_invalidos", "/alta?e=datos"],
  ];

  it.each(SIN_ESPACIO)("%s: libera sólo `alta:ip`, con su ventana, y va a %s", async (resultado, destino) => {
    h.enControl.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => unknown) =>
      armar({ execute: async () => respuesta({ resultado, creadas_24h: 20, tope: 20 }) })
    );

    expect(await crear()).toBe(destino);
    expect(h.liberarCupo).toHaveBeenCalledTimes(1);
    expect(h.liberarCupo).toHaveBeenCalledWith(CLAVE_IP, DIA_MS, VENTANA);
    expect(h.pendientes).toHaveLength(0);
  });

  it.each(["42883", "42P01", "42703", "23505"])(
    "el código %s de la base cierra el alta y devuelve el cupo",
    async (code) => {
      h.enControl.mockRejectedValue(errorDePg(code));

      expect(await crear()).toBe("/alta?e=cerrada");
      expect(h.liberarCupo).toHaveBeenCalledTimes(1);
      expect(h.liberarCupo).toHaveBeenCalledWith(CLAVE_IP, DIA_MS, VENTANA);
      expect(h.error).not.toHaveBeenCalled();
    }
  );

  it("el código de Postgres también se lee del `cause` que pone Drizzle", async () => {
    h.enControl.mockRejectedValue(new Error("Failed query", { cause: errorDePg("42883") }));

    expect(await crear()).toBe("/alta?e=cerrada");
  });

  it("cualquier otra falla de la base dice «falla», la anota y devuelve el cupo", async () => {
    h.enControl.mockRejectedValue(errorDePg("08006"));

    expect(await crear()).toBe("/alta?e=falla");
    expect(h.liberarCupo).toHaveBeenCalledWith(CLAVE_IP, DIA_MS, VENTANA);
    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "alta.crear_inquilino_fallo");
  });

  it("un resultado que la función no debería dar es una falla, no un cierre silencioso", async () => {
    h.enControl.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => unknown) =>
      armar({ execute: async () => respuesta({ resultado: "otra_cosa" }) })
    );

    expect(await crear()).toBe("/alta?e=falla");
    expect(h.liberarCupo).toHaveBeenCalledTimes(1);
  });

  it("si devolver el cupo falla, igual contesta", async () => {
    h.enControl.mockRejectedValue(errorDePg("42883"));
    h.liberarCupo.mockRejectedValue(new Error("sin base"));

    expect(await crear()).toBe("/alta?e=cerrada");
    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "alta.cupo_no_liberado");
  });
});

describe("el aviso al operador", () => {
  const conteo = (creadas_24h: number, tope: number) =>
    h.enControl.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => unknown) =>
      armar({ execute: async () => respuesta({ resultado: "ok", creadas_24h, tope }) })
    );

  it("antes del 80 % del tope no deja nada para después", async () => {
    conteo(15, 20);

    expect(await crear()).toBe(PRIMEROS_PASOS);
    expect(h.pendientes).toHaveLength(0);
  });

  it.each([
    [null, 20],
    [20, null],
    [null, null],
  ])("si la base no dijo el número (%s de %s), no avisa ni deja nada para después", async (creadas, tope) => {
    h.enControl.mockImplementation(async (_ctx: unknown, armar: (db: unknown) => unknown) =>
      armar({ execute: async () => respuesta({ resultado: "ok", creadas_24h: creadas, tope }) })
    );

    expect(await crear()).toBe(PRIMEROS_PASOS);
    expect(h.pendientes).toHaveLength(0);
  });

  it("al 80 % deja el aviso para después de responder, y sólo entonces lo manda", async () => {
    conteo(16, 20);

    expect(await crear()).toBe(PRIMEROS_PASOS);
    expect(h.pendientes).toHaveLength(1);
    expect(h.enviar).not.toHaveBeenCalled();

    await h.pendientes[0]();

    expect(h.rateLimit).toHaveBeenCalledTimes(2);
    expect(h.rateLimit).toHaveBeenLastCalledWith(claveDeCupo("alta:aviso80"), {
      limit: 1,
      windowMs: DIA_MS,
      fallaCerrada: true,
    });
    expect(h.enviar).toHaveBeenCalledTimes(1);
    const mail = h.enviar.mock.calls[0][0];
    expect(mail.to).toBe("ops@example.com");
    expect(mail.asunto).toContain("16");
    expect(mail.asunto).toContain("20");
    expect(mail.texto).toContain("16");
    expect(mail.texto).toContain("20");
    // Ni la empresa ni el número de nadie van en el mail.
    expect(`${mail.asunto}${mail.texto}`).not.toMatch(/Seguros del Sur|5492916426930/);
  });

  it("con el aviso de hoy ya mandado no manda otro y devuelve el intento", async () => {
    conteo(18, 20);
    expect(await crear()).toBe(PRIMEROS_PASOS);
    h.rateLimit.mockResolvedValueOnce(cupo({ allowed: false, remaining: 0 }));

    await h.pendientes[0]();

    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.liberarCupo).toHaveBeenCalledWith(claveDeCupo("alta:aviso80"), DIA_MS, VENTANA);
  });

  it("un aviso que no sale no rompe el alta, y deja intentar con la próxima", async () => {
    conteo(20, 20);
    expect(await crear()).toBe(PRIMEROS_PASOS);
    h.enviar.mockResolvedValue({ enviado: false, motivo: "sin_casilla" });

    await expect(h.pendientes[0]()).resolves.toBeUndefined();

    expect(h.liberarCupo).toHaveBeenCalledWith(claveDeCupo("alta:aviso80"), DIA_MS, VENTANA);
  });

  it("sin remitente del sistema no toma el cupo del aviso", async () => {
    conteo(20, 20);
    h.remitente.mockReturnValue(null);
    expect(await crear()).toBe(PRIMEROS_PASOS);

    await h.pendientes[0]();

    expect(h.rateLimit).toHaveBeenCalledTimes(1);
    expect(h.enviar).not.toHaveBeenCalled();
  });
});

describe("un +54 sin el 9 de los celulares", () => {
  const SIN_NUEVE = { ...CAMPOS_BUENOS, whatsapp: "+54 11 1234-5678" };

  afterEach(() => {
    delete process.env.ALTA_NUMERO_AUTOMATICO;
  });

  it("con el número automático prendido vuelve con «celular» y no cuenta nada", async () => {
    process.env.ALTA_NUMERO_AUTOMATICO = "1";

    expect(await crear(SIN_NUEVE)).toBe("/alta?e=celular");
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.enControl).not.toHaveBeenCalled();
    expect(h.iniciarBase).not.toHaveBeenCalled();
  });

  it("con el número automático prendido, el 9 y otros países pasan", async () => {
    process.env.ALTA_NUMERO_AUTOMATICO = "1";

    expect(await crear()).toBe(PRIMEROS_PASOS);
    expect(await crear({ ...CAMPOS_BUENOS, whatsapp: "+1 202-555-0123" })).toBe(PRIMEROS_PASOS);
  });

  it("apagado el número automático se acepta como hoy y se guarda tal cual", async () => {
    expect(await crear(SIN_NUEVE)).toBe(PRIMEROS_PASOS);

    const { params } = await llamadaALaBase();
    expect(params.slice(4)).toContain("+541112345678");
  });
});
