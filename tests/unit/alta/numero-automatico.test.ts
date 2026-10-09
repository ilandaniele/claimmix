/**
 * El número automático (`@/server/alta/numero-automatico`): quién puede pedir el
 * código, qué se suma a la WABA, qué cupo se devuelve en cada salida (sólo los de
 * lo que nunca salió a Graph) y qué se guarda.
 *
 * Graph, la base, el contador de cupos y el aviso al operador están simulados:
 * acá se prueba el orden de los pasos y la tabla de decisión. Qué URL y qué cuerpo
 * salen a Graph está en `tests/unit/whatsapp/alta-de-numero.test.ts`, y el SQL de
 * la función de la 0049 lo prueba `pnpm tenancy` contra una base de verdad.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  liberarCupo: vi.fn(),
  enControl: vi.fn(),
  /** Lo que devuelve la consulta de la fila del número. */
  leer: vi.fn(),
  /** Lo que devuelve `db.execute` (la función de la 0049). */
  guardar: vi.fn(),
  ejecutadas: [] as Array<{ queryChunks: unknown[] }>,
  credencial: vi.fn(),
  plataforma: vi.fn(),
  webhook: vi.fn(),
  espejar: vi.fn(),
  recorrer: vi.fn(),
  agregar: vi.fn(),
  pedirAMeta: vi.fn(),
  verificarEnMeta: vi.fn(),
  yaVerificado: vi.fn(),
  yaRegistrado: vi.fn(),
  registrar: vi.fn(),
  fijarWebhook: vi.fn(),
  leerWebhook: vi.fn(),
  aviso: vi.fn(),
  after: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // Igual que Next: la tarea corre después; acá corre en el momento y se cuenta.
  after: (tarea: () => unknown) => {
    h.after();
    void tarea();
  },
}));
vi.mock("@/data/scope", () => {
  const cadena: Record<string, unknown> = {};
  for (const paso of ["from", "innerJoin", "where", "limit"]) cadena[paso] = () => cadena;
  cadena.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => h.leer().then(ok, ko);
  const db = {
    select: () => cadena,
    execute: (consulta: { queryChunks: unknown[] }) => {
      h.ejecutadas.push(consulta);
      return h.guardar();
    },
  };
  return {
    enControl: async (ctx: unknown, armar: (db: unknown) => unknown) => {
      h.enControl(ctx);
      return armar(db);
    },
  };
});
vi.mock("@/server/bases/espejar-sin-fallar", () => ({ espejarSinFallar: h.espejar }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: h.debug, info: h.info, warn: h.warn, error: h.error },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: h.rateLimit, liberarCupo: h.liberarCupo }));
vi.mock("@/server/whatsapp/numeros", () => ({
  credencialDelEntorno: h.credencial,
  idDeLaPlataforma: h.plataforma,
  webhookDelEntorno: h.webhook,
}));
vi.mock("@/server/whatsapp/verificar-en-meta", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/whatsapp/verificar-en-meta")>()),
  recorrerLaWaba: h.recorrer,
}));
vi.mock("@/server/whatsapp/alta-de-numero", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/whatsapp/alta-de-numero")>()),
  agregarNumero: h.agregar,
  pedirCodigoAMeta: h.pedirAMeta,
  verificarCodigoEnMeta: h.verificarEnMeta,
  codigoYaVerificado: h.yaVerificado,
  numeroYaRegistrado: h.yaRegistrado,
  registrarNumero: h.registrar,
  fijarWebhookDelNumero: h.fijarWebhook,
  webhookPropioEs: h.leerWebhook,
}));
vi.mock("@/server/alta/aviso-operador", () => ({ avisarNumeroEnRevision: h.aviso }));

import { pedirCodigo, topesDelNumero, verificarCodigo, type QuienPide } from "@/server/alta/numero-automatico";

const HORA_MS = 60 * 60_000;
const DIA_MS = 24 * HORA_MS;
const VENTANA = 1_700_000_000_000;
const TENANT = "11111111-1111-4111-8111-111111111111";
const USUARIO = "22222222-2222-4222-8222-222222222222";
const IP = "203.0.113.7";
const WABA = "200000000000001";
const PLATAFORMA = "100000000000001";
const ID = "100000000000777";
const TOKEN = "fake-access-token";
const CODIGO = "123456";
const NUMERO = "+5491100000000";
const CRED = { accessToken: TOKEN, wabaId: WABA };
const WEBHOOK = { url: "https://claimmix.example.com/api/webhooks/whatsapp", verifyToken: "fake-verify-token" };

const QUIEN: QuienPide = { tenantId: TENANT, userId: USUARIO, ip: IP, idioma: "es-AR" };

const ENTORNO = [
  "ALTA_NUMERO_AUTOMATICO",
  "ALTA_NUMEROS_MAXIMOS_WABA",
  "ALTA_TOPE_NUMEROS_DIA",
  "ALTA_TOPE_CODIGOS_INQUILINO_DIA",
  "ALTA_TOPE_CODIGOS_IP_DIA",
  "ALTA_TOPE_CODIGOS_DIA",
  "ALTA_TOPE_VERIFICACIONES_HORA",
  "NUMEROS_DE_DEV",
] as const;
const guardado: Record<string, string | undefined> = {};

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

/** La WABA con sólo el número de la plataforma, o con las filas que se pidan. */
const waba = (filas: Array<Record<string, unknown>> = [], completa = true) => ({
  filas: [{ id: PLATAFORMA, display: "+54 9 291 642-6930", nombre: "Veltra" }, ...filas],
  completa,
});

const ok = <T>(valor: T) => ({ ok: true as const, valor });
const falla = (motivo: "esperar" | "meta" | "rechazo", codigo: number | null = null) => ({
  ok: false as const,
  falla: motivo,
  codigo,
});
const guardo = (resultado: string) => ({ rows: [{ r: { resultado } }] });

/** Todo bien hasta pedir el código; cada caso cambia lo suyo. */
function caminoFeliz() {
  h.leer.mockResolvedValue([fila()]);
  h.guardar.mockResolvedValue(guardo("ok"));
  h.recorrer.mockResolvedValue(waba());
  h.agregar.mockResolvedValue(ok(ID));
  h.pedirAMeta.mockResolvedValue(ok(true));
  h.verificarEnMeta.mockResolvedValue(ok(true));
  h.yaVerificado.mockResolvedValue(ok(true));
  h.yaRegistrado.mockResolvedValue(ok(false));
  h.registrar.mockResolvedValue(ok(true));
  h.fijarWebhook.mockResolvedValue(ok(true));
  h.leerWebhook.mockResolvedValue(ok(true));
}

/** El contador rechaza las claves que empiezan con alguna de éstas. */
function contadorRechaza(...prefijos: string[]) {
  h.rateLimit.mockImplementation(async (clave: string) => ({
    allowed: !prefijos.some((p) => clave.startsWith(p)),
    remaining: 0,
    resetAt: 0,
    retryAfterSeconds: 0,
    ventana: VENTANA,
  }));
}

const clavesTomadas = () => h.rateLimit.mock.calls.map(([clave]) => clave as string);
const clavesLiberadas = () => h.liberarCupo.mock.calls.map(([clave]) => clave as string);
const ordenadas = (claves: string[]) => [...claves].sort();

/** Los valores sueltos que llevó la consulta a la función de la 0049, en orden. */
const valoresDe = (consulta: { queryChunks: unknown[] }) =>
  consulta.queryChunks.filter((c) => typeof c !== "object" || c === null);

const sinGraph = () => {
  for (const f of [h.recorrer, h.agregar, h.pedirAMeta, h.verificarEnMeta, h.yaVerificado, h.yaRegistrado, h.registrar, h.fijarWebhook, h.leerWebhook]) {
    expect(f).not.toHaveBeenCalled();
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  h.ejecutadas.length = 0;
  for (const k of ENTORNO) {
    guardado[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ALTA_NUMERO_AUTOMATICO = "1";
  contadorRechaza();
  h.liberarCupo.mockResolvedValue(undefined);
  h.aviso.mockResolvedValue(undefined);
  h.credencial.mockReturnValue({ accessToken: TOKEN, phoneNumberId: PLATAFORMA, wabaId: WABA });
  h.plataforma.mockReturnValue(PLATAFORMA);
  h.webhook.mockReturnValue(WEBHOOK);
  h.espejar.mockResolvedValue(true);
  caminoFeliz();
});

afterEach(() => {
  for (const k of ENTORNO) {
    if (guardado[k] === undefined) delete process.env[k];
    else process.env[k] = guardado[k];
  }
});

describe("topesDelNumero", () => {
  it("sin variables: 2 números en la WABA, 2 nuevos por día, 3 códigos por espacio, 5 por red, 10 en total y 5 verificaciones por hora", () => {
    expect(topesDelNumero()).toEqual({
      numerosWaba: 2,
      numerosDia: 2,
      codigosInquilino: 3,
      codigosIp: 5,
      codigosDia: 10,
      verificacionesHora: 5,
    });
  });

  it("lee las variables, con 0 donde cierra, y un valor roto o fuera de rango vuelve al de siempre", () => {
    process.env.ALTA_NUMEROS_MAXIMOS_WABA = "20";
    process.env.ALTA_TOPE_NUMEROS_DIA = "0";
    process.env.ALTA_TOPE_CODIGOS_INQUILINO_DIA = "1";
    process.env.ALTA_TOPE_CODIGOS_IP_DIA = "abc";
    process.env.ALTA_TOPE_CODIGOS_DIA = "501";
    process.env.ALTA_TOPE_VERIFICACIONES_HORA = "20";
    expect(topesDelNumero()).toEqual({
      numerosWaba: 20,
      numerosDia: 0,
      codigosInquilino: 1,
      codigosIp: 5,
      codigosDia: 10,
      verificacionesHora: 20,
    });
  });

  it("la WABA no baja de 1 número: un 0 vuelve al de siempre", () => {
    process.env.ALTA_NUMEROS_MAXIMOS_WABA = "0";
    expect(topesDelNumero().numerosWaba).toBe(2);
  });
});

describe("pedirCodigo: antes de tocar nada", () => {
  it.each([undefined, "0", "true", ""])("con la bandera en %j: revision, sin contador, sin base y sin Graph", async (valor) => {
    if (valor === undefined) delete process.env.ALTA_NUMERO_AUTOMATICO;
    else process.env.ALTA_NUMERO_AUTOMATICO = valor;

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");
    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("revision");

    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.enControl).not.toHaveBeenCalled();
    sinGraph();
  });

  it("los cupos de código son por espacio, por red y global, de 24 h y siempre cerrando si el contador no contesta", async () => {
    await pedirCodigo(QUIEN, "SMS");

    const llamadas = h.rateLimit.mock.calls as Array<[string, { limit: number; windowMs: number; fallaCerrada: boolean }]>;
    expect(llamadas.map(([clave, c]) => [clave, c.limit, c.windowMs])).toEqual([
      [`wa:codigo:${TENANT}`, 3, DIA_MS],
      [`wa:codigo-ip:${IP}`, 5, DIA_MS],
      ["wa:codigos", 10, DIA_MS],
      [`wa:alta-numero:${TENANT}`, 1, HORA_MS],
      ["wa:altas-numero", 2, DIA_MS],
    ]);
    expect(llamadas.every(([, c]) => c.fallaCerrada === true)).toBe(true);
  });

  it("sin IP la red es 'sin-ip' (compartida), y una IPv6 cuenta por su /56", async () => {
    await pedirCodigo({ ...QUIEN, ip: null }, "SMS");
    expect(clavesTomadas()).toContain("wa:codigo-ip:sin-ip");

    h.rateLimit.mockClear();
    await pedirCodigo({ ...QUIEN, ip: "2001:db8:1234:5678::1" }, "SMS");
    expect(clavesTomadas()).toContain("wa:codigo-ip:2001:db8:1234:5600::/56");
  });

  it("un tope de código en 0 es «esperar» sin llamar al contador de ese cupo, y devuelve los que ya tomó", async () => {
    process.env.ALTA_TOPE_CODIGOS_DIA = "0";

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("esperar");

    expect(clavesTomadas()).toEqual([`wa:codigo:${TENANT}`, `wa:codigo-ip:${IP}`]);
    expect(clavesLiberadas()).toEqual([`wa:codigo:${TENANT}`, `wa:codigo-ip:${IP}`]);
    expect(h.enControl).not.toHaveBeenCalled();
    sinGraph();
  });

  it("el tope por espacio en 0 no llama a ningún contador", async () => {
    process.env.ALTA_TOPE_CODIGOS_INQUILINO_DIA = "0";

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("esperar");

    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it.each([
    ["el espacio", `wa:codigo:${TENANT}`, 1],
    ["la red", "wa:codigo-ip:", 2],
    ["el total", "wa:codigos", 3],
  ])("si %s no tiene lugar: esperar, sin base ni Graph, y se devuelve todo lo tomado, también lo rechazado", async (_cual, prefijo, tomadas) => {
    contadorRechaza(prefijo);

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("esperar");

    expect(h.rateLimit).toHaveBeenCalledTimes(tomadas);
    expect(h.liberarCupo).toHaveBeenCalledTimes(tomadas);
    for (const [clave, ventana, windowMs] of h.liberarCupo.mock.calls.map(([c, w, v]) => [c, v, w])) {
      expect(clavesTomadas()).toContain(clave);
      expect(ventana).toBe(VENTANA);
      expect(windowMs).toBe(DIA_MS);
    }
    expect(h.enControl).not.toHaveBeenCalled();
    sinGraph();
  });
});

describe("pedirCodigo: las compuertas del espacio", () => {
  it.each([
    ["no es de alta automática", { autoalta: false }],
    ["está suspendido", { billing_status: "suspended" }],
    ["la prueba venció", { billing_status: "trial", trial_ends_at: "2020-01-01T00:00:00.000Z" }],
    ["la 0049 no está aplicada", { funcion: false }],
    ["el número ya está conectado", { estado: "conectado" }],
    ["el número está suspendido", { estado: "suspendido" }],
  ])("%s: revision sin Graph, sin aviso, y vuelven los tres cupos de código", async (_cual, extra) => {
    h.leer.mockResolvedValue([fila(extra)]);

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    sinGraph();
    expect(h.aviso).not.toHaveBeenCalled();
    expect(clavesLiberadas()).toEqual(clavesTomadas());
    expect(clavesLiberadas()).toHaveLength(3);
    expect(h.ejecutadas).toHaveLength(0);
  });

  it("un espacio que ya paga (active) con la fecha de la prueba vencida sigue: la fecha sólo corta la prueba", async () => {
    h.leer.mockResolvedValue([fila({ billing_status: "active", trial_ends_at: "2020-01-01T00:00:00.000Z" })]);

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("codigo_enviado");
  });

  it.each(["42P01", "42703"])("la base sin la 0048 (%s): se lee como sin fila y manda a revision", async (code) => {
    h.leer.mockRejectedValue(Object.assign(new Error("falta"), { code }));

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    sinGraph();
    expect(clavesLiberadas()).toHaveLength(3);
    expect(h.error).not.toHaveBeenCalled();
    expect(h.aviso).toHaveBeenCalledWith("sin_fila", TENANT);
  });

  it("sin fila (el espacio no tiene número): revision, y el operador se entera (sin_fila) después de contestar", async () => {
    h.leer.mockResolvedValue([]);

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    sinGraph();
    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.aviso).toHaveBeenCalledTimes(1);
    expect(h.aviso).toHaveBeenCalledWith("sin_fila", TENANT);
    expect(clavesLiberadas()).toHaveLength(3);
  });

  it("la consulta de la fila va dentro de enControl, con el espacio de la sesión", async () => {
    await pedirCodigo(QUIEN, "SMS");

    expect(h.enControl).toHaveBeenCalledWith({ tenantId: TENANT });
  });

  it.each([
    ["sin credencial", () => h.credencial.mockReturnValue(null)],
    ["sin WABA", () => h.credencial.mockReturnValue({ accessToken: TOKEN, phoneNumberId: PLATAFORMA, wabaId: null })],
    ["sin número de la plataforma", () => h.plataforma.mockReturnValue(null)],
    ["sin el webhook del ambiente (URL https o token del apretón de manos)", () => h.webhook.mockReturnValue(null)],
  ])("%s: revision sin Graph, aviso sin_credencial y vuelven los cupos", async (_cual, preparar) => {
    preparar();

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    sinGraph();
    expect(h.aviso).toHaveBeenCalledTimes(1);
    expect(h.aviso).toHaveBeenCalledWith("sin_credencial", TENANT);
    expect(clavesLiberadas()).toHaveLength(3);
  });

  it("un error de la base que no es de migración: «meta», se anota sólo el nombre y vuelven los cupos", async () => {
    h.leer.mockRejectedValue(new Error(`password=fake-secreto token=${TOKEN} codigo=${CODIGO}`));

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("meta");

    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "alta.numero_automatico_fallo");
    expect(JSON.stringify(h.error.mock.calls)).not.toContain("fake-secreto");
    expect(clavesLiberadas()).toHaveLength(3);
    sinGraph();
  });
});

describe("pedirCodigo: sumar el número a la WABA", () => {
  it("camino feliz: recorre la WABA con el nombre, agrega con el nombre de la plataforma, guarda el id de Graph y pide el código", async () => {
    expect(await pedirCodigo(QUIEN, "SMS")).toBe("codigo_enviado");

    expect(h.recorrer).toHaveBeenCalledWith(WABA, "id,display_phone_number,verified_name", TOKEN);
    expect(h.agregar).toHaveBeenCalledTimes(1);
    expect(h.agregar).toHaveBeenCalledWith(CRED, { cc: "54", numero: "91100000000" }, "Veltra");
    expect(h.ejecutadas).toHaveLength(1);
    expect(valoresDe(h.ejecutadas[0])).toEqual([TENANT, USUARIO, "agregado", ID, WABA, PLATAFORMA, IP]);
    expect(h.pedirAMeta).toHaveBeenCalledWith(CRED, ID, "SMS", "es-AR");
    // Ya se contó el código: no se devuelve ningún cupo.
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("el número que entra a la WABA avisa al operador (agregado), después de contestar y con el espacio sólo para el registro", async () => {
    await pedirCodigo(QUIEN, "SMS");

    expect(h.after).toHaveBeenCalledTimes(1);
    expect(h.aviso).toHaveBeenCalledTimes(1);
    expect(h.aviso).toHaveBeenCalledWith("agregado", TENANT);
  });

  it("el nombre visible es el de la plataforma, no algo del espacio", async () => {
    h.recorrer.mockResolvedValue({ filas: [{ id: PLATAFORMA, display: "+54 9 291 642-6930", nombre: "Otro Nombre S.A." }], completa: true });
    h.leer.mockResolvedValue([fila({ empresa: "Banco Nación", name: "Banco Nación" })]);

    await pedirCodigo(QUIEN, "SMS");

    expect(h.agregar.mock.calls[0][2]).toBe("Otro Nombre S.A.");
  });

  it("VOICE llega como VOICE y el idioma de la cuenta, tal cual", async () => {
    await pedirCodigo({ ...QUIEN, idioma: "en-US" }, "VOICE");

    expect(h.pedirAMeta).toHaveBeenCalledWith(CRED, ID, "VOICE", "en-US");
  });

  it.each([
    ["con el 9 y separadores", "+54 9 11 0000-0000"],
    ["sin el 9", "+54 11 0000-0000"],
    ["pegado", "+5491100000000"],
  ])("el número ya está en la WABA (%s): revision y aviso ya_en_la_waba, sin agregar, y vuelven los cupos", async (_c, display) => {
    h.recorrer.mockResolvedValue(waba([{ id: "100000000000555", display, nombre: null }]));

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("ya_en_la_waba", TENANT);
    expect(h.agregar).not.toHaveBeenCalled();
    expect(h.pedirAMeta).not.toHaveBeenCalled();
    expect(h.ejecutadas).toHaveLength(0);
    // El recorrido de la WABA ya salió a Graph: los cupos de código se quedan.
    expect(clavesTomadas()).toEqual([`wa:codigo:${TENANT}`, `wa:codigo-ip:${IP}`, "wa:codigos"]);
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("la WABA llena (2 números con el de la plataforma): revision y aviso sin_lugar, sin agregar ni tomar cupos de alta", async () => {
    h.recorrer.mockResolvedValue(waba([{ id: "100000000000555", display: "+54 9 11 5555-1111", nombre: null }]));

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("sin_lugar", TENANT);
    expect(h.agregar).not.toHaveBeenCalled();
    expect(clavesTomadas()).toEqual([`wa:codigo:${TENANT}`, `wa:codigo-ip:${IP}`, "wa:codigos"]);
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("con ALTA_NUMEROS_MAXIMOS_WABA=3 y 2 números en la WABA, sigue", async () => {
    process.env.ALTA_NUMEROS_MAXIMOS_WABA = "3";
    h.recorrer.mockResolvedValue(waba([{ id: "100000000000555", display: "+54 9 11 5555-1111", nombre: null }]));

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("codigo_enviado");

    expect(h.agregar).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Graph no contestó", null],
    ["el recorrido quedó a medias", waba([], false)],
  ])("%s: «meta» sin agregar, y los cupos de código se quedan (el GET ya salió a Graph)", async (_cual, respuesta) => {
    h.recorrer.mockResolvedValue(respuesta);

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("meta");

    expect(h.agregar).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("repetir un recorrido que falla no devuelve nada: tres pedidos gastan tres veces los cupos de código", async () => {
    h.recorrer.mockResolvedValue(null);

    for (let i = 0; i < 3; i++) expect(await pedirCodigo(QUIEN, "SMS")).toBe("meta");

    expect(h.recorrer).toHaveBeenCalledTimes(3);
    expect(clavesTomadas().filter((c) => c === `wa:codigo:${TENANT}`)).toHaveLength(3);
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it.each([
    ["la WABA no trae la fila de la plataforma", { filas: [{ id: "100000000000555", display: "+54 9 11 5555-1111", nombre: "Otro" }], completa: true }],
    ["la fila de la plataforma no trae nombre", { filas: [{ id: PLATAFORMA, display: "+54 9 291 642-6930", nombre: null }], completa: true }],
  ])("%s: revision y aviso sin_nombre, sin agregar nada", async (_cual, respuesta) => {
    h.recorrer.mockResolvedValue(respuesta);

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("sin_nombre", TENANT);
    expect(h.agregar).not.toHaveBeenCalled();
    expect(clavesTomadas()).toEqual([`wa:codigo:${TENANT}`, `wa:codigo-ip:${IP}`, "wa:codigos"]);
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it.each([
    ["de Estados Unidos", "+12025550000"],
    ["de España", "+34612345678"],
    ["fijo argentino", "+541100000001"],
    ["móvil argentino corto", "+5491155"],
    ["sin forma de número", "no es un número"],
  ])("un número %s: revision y aviso pais, sin recorrer la WABA", async (_cual, numero) => {
    h.leer.mockResolvedValue([fila({ numero_e164: numero })]);

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("pais", TENANT);
    expect(h.recorrer).not.toHaveBeenCalled();
    sinGraphMenosRecorrer();
    expect(clavesLiberadas()).toHaveLength(3);
  });

  it("un espacio que ya pidió un número en la última hora: esperar; vuelven los cupos de alta, también el rechazado, y los de código se quedan", async () => {
    contadorRechaza("wa:alta-numero:");

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("esperar");

    expect(h.agregar).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
    expect(clavesTomadas()).toHaveLength(4);
    expect(clavesLiberadas()).toEqual([`wa:alta-numero:${TENANT}`]);
  });

  it("el tope diario de números nuevos lleno: revision y aviso sin_lugar, sin agregar; vuelven los cupos de alta y los de código se quedan", async () => {
    contadorRechaza("wa:altas-numero");

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("sin_lugar", TENANT);
    expect(h.agregar).not.toHaveBeenCalled();
    expect(ordenadas(clavesLiberadas())).toEqual([`wa:alta-numero:${TENANT}`, "wa:altas-numero"]);
    expect(clavesTomadas()).toHaveLength(5);
  });

  it("ALTA_TOPE_NUMEROS_DIA=0 cierra sin llamar a su contador", async () => {
    process.env.ALTA_TOPE_NUMEROS_DIA = "0";

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("sin_lugar", TENANT);
    expect(clavesTomadas()).not.toContain("wa:altas-numero");
    expect(h.agregar).not.toHaveBeenCalled();
    expect(clavesLiberadas()).toEqual([`wa:alta-numero:${TENANT}`]);
  });

  it("agregar da «esperar»: esperar, vuelven los cupos de alta (Meta no hizo nada) y los de código se quedan", async () => {
    h.agregar.mockResolvedValue(falla("esperar", 130429));

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("esperar");

    expect(h.aviso).not.toHaveBeenCalled();
    expect(h.ejecutadas).toHaveLength(0);
    expect(h.pedirAMeta).not.toHaveBeenCalled();
    expect(ordenadas(clavesLiberadas())).toEqual([`wa:alta-numero:${TENANT}`, "wa:altas-numero"]);
  });

  it.each([
    ["un timeout o un 5xx", falla("meta")],
    ["un 2xx sin id", falla("meta", null)],
  ])("agregar da «meta» (%s): el número pudo entrar a la WABA; revision y aviso incierto, y no vuelve ningún cupo", async (_cual, respuesta) => {
    h.agregar.mockResolvedValue(respuesta);

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    expect(h.aviso).toHaveBeenCalledTimes(1);
    expect(h.aviso).toHaveBeenCalledWith("incierto", TENANT);
    expect(h.aviso).not.toHaveBeenCalledWith("agregado", TENANT);
    expect(h.ejecutadas).toHaveLength(0);
    expect(h.pedirAMeta).not.toHaveBeenCalled();
    expect(clavesTomadas()).toHaveLength(5);
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("agregar rechazado: revision y aviso rechazo; ni los cupos de alta ni los de código vuelven", async () => {
    h.agregar.mockResolvedValue(falla("rechazo", 100));

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("rechazo", TENANT);
    expect(h.pedirAMeta).not.toHaveBeenCalled();
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("Graph devuelve el id de la plataforma: revision y aviso sin_dueno, sin guardar, sin pedir el código", async () => {
    h.agregar.mockResolvedValue(ok(PLATAFORMA));

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("sin_dueno", TENANT);
    expect(h.ejecutadas).toHaveLength(0);
    expect(h.pedirAMeta).not.toHaveBeenCalled();
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it.each(["12345", "123456789012345678901", "10000000000000A"])(
    "un id de Graph que la base no acepta (%s): revision y aviso sin_dueno, sin guardar ni pedir el código",
    async (id) => {
      h.agregar.mockResolvedValue(ok(id));

      expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

      expect(h.aviso).toHaveBeenCalledWith("sin_dueno", TENANT);
      expect(h.ejecutadas).toHaveLength(0);
      expect(h.pedirAMeta).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["id_ocupado", () => h.guardar.mockResolvedValue(guardo("id_ocupado"))],
    ["no_aplica", () => h.guardar.mockResolvedValue(guardo("no_aplica"))],
    ["datos_invalidos", () => h.guardar.mockResolvedValue(guardo("datos_invalidos"))],
    ["id_de_la_plataforma", () => h.guardar.mockResolvedValue(guardo("id_de_la_plataforma"))],
    ["un resultado que no se conoce", () => h.guardar.mockResolvedValue(guardo("quien_sabe"))],
    ["una respuesta vacía", () => h.guardar.mockResolvedValue({ rows: [] })],
    ["el resultado como texto JSON que no es JSON", () => h.guardar.mockResolvedValue({ rows: [{ r: "{no" }] })],
    ["la función sin crear (42883)", () => h.guardar.mockRejectedValue(Object.assign(new Error("x"), { code: "42883" }))],
    ["la tabla sin crear (42P01)", () => h.guardar.mockRejectedValue(Object.assign(new Error("x"), { code: "42P01" }))],
    ["un índice único pisado (23505)", () => h.guardar.mockRejectedValue(Object.assign(new Error("x"), { code: "23505" }))],
    ["un error cualquiera de la base", () => h.guardar.mockRejectedValue(new Error("se cayó"))],
  ])("guardar da %s: revision y aviso sin_dueno, y ninguna llamada a Graph después", async (_cual, preparar) => {
    preparar();

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("sin_dueno", TENANT);
    expect(h.pedirAMeta).not.toHaveBeenCalled();
    expect(h.verificarEnMeta).not.toHaveBeenCalled();
    expect(h.registrar).not.toHaveBeenCalled();
    // El número ya entró a la WABA: el aviso de «agregado» salió igual, antes.
    expect(h.aviso).toHaveBeenCalledWith("agregado", TENANT);
    // request_code nunca salió, pero el recorrido y el alta sí: nada vuelve.
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("la función de la 0049 no tiene el nombre ni el código de nadie: sólo ids, el paso y la IP", async () => {
    await pedirCodigo(QUIEN, "SMS");

    expect(h.ejecutadas[0].queryChunks.some((c) => typeof c === "object" && c !== null && "queryChunks" in c)).toBe(false);
    expect(JSON.stringify(valoresDe(h.ejecutadas[0]))).not.toContain("Veltra");
  });
});

/** Sin las llamadas de alta de Graph (el recorrido se afirma aparte). */
function sinGraphMenosRecorrer() {
  for (const f of [h.agregar, h.pedirAMeta, h.verificarEnMeta, h.yaVerificado, h.yaRegistrado, h.registrar, h.fijarWebhook, h.leerWebhook]) {
    expect(f).not.toHaveBeenCalled();
  }
}

describe("pedirCodigo: fila con el número ya agregado", () => {
  beforeEach(() => {
    h.leer.mockResolvedValue([fila({ phone_number_id: ID })]);
  });

  it("no recorre la WABA ni agrega ni guarda: pide el código directo, sin cupos de alta", async () => {
    expect(await pedirCodigo(QUIEN, "VOICE")).toBe("codigo_enviado");

    expect(h.recorrer).not.toHaveBeenCalled();
    expect(h.agregar).not.toHaveBeenCalled();
    expect(h.ejecutadas).toHaveLength(0);
    expect(h.aviso).not.toHaveBeenCalled();
    expect(h.pedirAMeta).toHaveBeenCalledWith(CRED, ID, "VOICE", "es-AR");
    expect(clavesTomadas()).toEqual([`wa:codigo:${TENANT}`, `wa:codigo-ip:${IP}`, "wa:codigos"]);
  });

  it("si el id de la fila es el de la plataforma: revision y aviso sin_dueno, sin tocarlo", async () => {
    h.leer.mockResolvedValue([fila({ phone_number_id: PLATAFORMA })]);

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("sin_dueno", TENANT);
    expect(h.pedirAMeta).not.toHaveBeenCalled();
    expect(clavesLiberadas()).toHaveLength(3);
  });

  it("request_code «esperar»: esperar, y los cupos de código se quedan (el pedido salió)", async () => {
    h.pedirAMeta.mockResolvedValue(falla("esperar", 130429));

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("esperar");

    expect(h.liberarCupo).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("request_code «meta» (timeout o respuesta rara): meta, y los cupos de código NO vuelven: Meta pudo haber mandado el SMS", async () => {
    h.pedirAMeta.mockResolvedValue(falla("meta"));

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("meta");

    expect(h.liberarCupo).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("request_code rechazado: revision y aviso rechazo, y los cupos se quedan", async () => {
    h.pedirAMeta.mockResolvedValue(falla("rechazo", 100));

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("rechazo", TENANT);
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("si devolver un cupo falla, el resultado no cambia", async () => {
    h.liberarCupo.mockRejectedValue(new Error("la base no contesta"));
    h.leer.mockResolvedValue([fila({ autoalta: false })]);

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");
  });
});

describe("pedirCodigo: nunca tira", () => {
  it.each([
    ["recorrer la WABA", () => h.recorrer.mockRejectedValue(new Error(`boom ${TOKEN}`))],
    ["agregar", () => h.agregar.mockRejectedValue(new Error(`boom ${TOKEN}`))],
    ["pedir el código", () => h.pedirAMeta.mockRejectedValue(new Error(`boom ${TOKEN}`))],
    ["el contador", () => h.rateLimit.mockRejectedValue(new Error(`boom ${TOKEN}`))],
  ])("si falla %s: «meta» y se anota sólo el nombre del error", async (_cual, preparar) => {
    preparar();

    await expect(pedirCodigo(QUIEN, "SMS")).resolves.toBe("meta");

    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "alta.numero_automatico_fallo");
    expect(JSON.stringify(h.error.mock.calls)).not.toContain(TOKEN);
  });
});

describe("verificarCodigo", () => {
  beforeEach(() => {
    h.leer.mockResolvedValue([fila({ phone_number_id: ID })]);
  });

  it.each(["12345", "1234567", "abcdef", "12 456", "123-456", "", " 123456", "١٢٣٤٥٦"])(
    "el código %j no son seis números: codigo_invalido, sin contador, sin base ni Graph",
    async (codigo) => {
      expect(await verificarCodigo(QUIEN, codigo)).toBe("codigo_invalido");

      expect(h.rateLimit).not.toHaveBeenCalled();
      expect(h.enControl).not.toHaveBeenCalled();
      sinGraph();
    }
  );

  it("camino feliz: verifica, mira si ya está registrado, registra, guarda 'conectado' con el id de la fila y conecta", async () => {
    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("conectado");

    expect(h.verificarEnMeta).toHaveBeenCalledWith(CRED, ID, CODIGO);
    expect(h.yaVerificado).not.toHaveBeenCalled();
    expect(h.yaRegistrado).toHaveBeenCalledWith(CRED, ID);
    expect(h.registrar).toHaveBeenCalledTimes(1);
    expect(h.registrar).toHaveBeenCalledWith(CRED, ID);
    expect(h.fijarWebhook).toHaveBeenCalledWith(CRED, ID, WEBHOOK);
    expect(h.leerWebhook).toHaveBeenCalledWith(CRED, ID, WEBHOOK.url);
    expect(h.ejecutadas).toHaveLength(1);
    expect(valoresDe(h.ejecutadas[0])).toEqual([TENANT, USUARIO, "conectado", ID, WABA, PLATAFORMA, IP]);
    expect(h.aviso).not.toHaveBeenCalled();
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("los cupos: verificar es por espacio, 5 por hora; registrar, 3 por día", async () => {
    await verificarCodigo(QUIEN, CODIGO);

    const llamadas = h.rateLimit.mock.calls as Array<[string, { limit: number; windowMs: number; fallaCerrada: boolean }]>;
    expect(llamadas.map(([clave, c]) => [clave, c.limit, c.windowMs, c.fallaCerrada])).toEqual([
      [`wa:verificar:${TENANT}`, 5, HORA_MS, true],
      [`wa:registrar:${TENANT}`, 3, DIA_MS, true],
    ]);
  });

  it("sin lugar para verificar: esperar, sin base ni Graph", async () => {
    contadorRechaza("wa:verificar:");

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("esperar");

    expect(h.enControl).not.toHaveBeenCalled();
    sinGraph();
    expect(clavesLiberadas()).toEqual([`wa:verificar:${TENANT}`]);
  });

  it("ALTA_TOPE_VERIFICACIONES_HORA=0 cierra sin llamar al contador", async () => {
    process.env.ALTA_TOPE_VERIFICACIONES_HORA = "0";

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("esperar");

    expect(h.rateLimit).not.toHaveBeenCalled();
    sinGraph();
  });

  it("sin id de Graph todavía: pedi_primero, sin Graph, y el intento de verificar vuelve", async () => {
    h.leer.mockResolvedValue([fila({ phone_number_id: null })]);

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("pedi_primero");

    sinGraph();
    expect(clavesLiberadas()).toEqual([`wa:verificar:${TENANT}`]);
  });

  it.each([
    ["no es de alta automática", { autoalta: false }],
    ["la prueba venció", { trial_ends_at: "2020-01-01T00:00:00.000Z" }],
    ["la 0049 no está", { funcion: false }],
    ["ya está conectado", { estado: "conectado" }],
  ])("%s: revision sin Graph", async (_cual, extra) => {
    h.leer.mockResolvedValue([fila({ phone_number_id: ID, ...extra })]);

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("revision");

    sinGraph();
    expect(clavesLiberadas()).toEqual([`wa:verificar:${TENANT}`]);
  });

  it("sin credencial: revision sin Graph, con aviso sin_credencial y el intento de verificar vuelve", async () => {
    h.credencial.mockReturnValue(null);

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("revision");

    sinGraph();
    expect(h.aviso).toHaveBeenCalledTimes(1);
    expect(h.aviso).toHaveBeenCalledWith("sin_credencial", TENANT);
    expect(clavesLiberadas()).toEqual([`wa:verificar:${TENANT}`]);
  });

  it("sin fila: revision sin Graph, con aviso sin_fila", async () => {
    h.leer.mockResolvedValue([]);

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("revision");

    sinGraph();
    expect(h.aviso).toHaveBeenCalledWith("sin_fila", TENANT);
  });

  it("si el id de la fila es el de la plataforma: revision y aviso sin_dueno, sin verificar nada", async () => {
    h.leer.mockResolvedValue([fila({ phone_number_id: PLATAFORMA })]);

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("sin_dueno", TENANT);
    sinGraph();
  });

  describe("cuando Meta rechaza el código", () => {
    beforeEach(() => {
      h.verificarEnMeta.mockResolvedValue(falla("rechazo", 100));
    });

    it("y el número no está verificado: codigo_incorrecto, sin registrar, y el intento se cuenta", async () => {
      h.yaVerificado.mockResolvedValue(ok(false));

      expect(await verificarCodigo(QUIEN, CODIGO)).toBe("codigo_incorrecto");

      expect(h.yaVerificado).toHaveBeenCalledWith(CRED, ID);
      expect(h.yaRegistrado).not.toHaveBeenCalled();
      expect(h.registrar).not.toHaveBeenCalled();
      expect(h.ejecutadas).toHaveLength(0);
      expect(h.aviso).not.toHaveBeenCalled();
      expect(h.liberarCupo).not.toHaveBeenCalled();
    });

    it("pero el número ya figura verificado (un intento anterior): sigue al registro y conecta", async () => {
      h.yaVerificado.mockResolvedValue(ok(true));

      expect(await verificarCodigo(QUIEN, CODIGO)).toBe("conectado");

      expect(h.registrar).toHaveBeenCalledTimes(1);
      expect(valoresDe(h.ejecutadas[0])[2]).toBe("conectado");
    });

    it.each([
      ["esperar", "esperar"],
      ["meta", "meta"],
    ] as const)("y preguntar si ya está verificado da %s: se devuelve %s", async (motivo, esperado) => {
      h.yaVerificado.mockResolvedValue(falla(motivo));

      expect(await verificarCodigo(QUIEN, CODIGO)).toBe(esperado);

      expect(h.registrar).not.toHaveBeenCalled();
    });

    it("y preguntar si ya está verificado también se rechaza: revision y aviso rechazo", async () => {
      h.yaVerificado.mockResolvedValue(falla("rechazo", 100));

      expect(await verificarCodigo(QUIEN, CODIGO)).toBe("revision");

      expect(h.aviso).toHaveBeenCalledWith("rechazo", TENANT);
      expect(h.registrar).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["esperar", "esperar"],
    ["meta", "meta"],
  ] as const)("verify_code da %s: se devuelve %s, sin preguntar ni registrar", async (motivo, esperado) => {
    h.verificarEnMeta.mockResolvedValue(falla(motivo));

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe(esperado);

    expect(h.yaVerificado).not.toHaveBeenCalled();
    expect(h.registrar).not.toHaveBeenCalled();
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("un número que Meta ya tiene registrado no se registra otra vez: pasa directo a 'conectado'", async () => {
    h.yaRegistrado.mockResolvedValue(ok(true));

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("conectado");

    expect(h.registrar).not.toHaveBeenCalled();
    expect(h.fijarWebhook).toHaveBeenCalledTimes(1);
    expect(clavesTomadas()).toEqual([`wa:verificar:${TENANT}`]);
    expect(valoresDe(h.ejecutadas[0])[2]).toBe("conectado");
  });

  it.each([
    ["esperar", "esperar"],
    ["meta", "meta"],
  ] as const)("no poder ver si está registrado (%s): se devuelve %s, sin registrar", async (motivo, esperado) => {
    h.yaRegistrado.mockResolvedValue(falla(motivo));

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe(esperado);

    expect(h.registrar).not.toHaveBeenCalled();
    expect(h.ejecutadas).toHaveLength(0);
  });

  it("el cupo de registrar sin lugar: esperar, sin llamar a register", async () => {
    contadorRechaza("wa:registrar:");

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("esperar");

    expect(h.registrar).not.toHaveBeenCalled();
    expect(h.ejecutadas).toHaveLength(0);
    expect(clavesLiberadas()).toEqual([`wa:registrar:${TENANT}`]);
  });

  it.each([
    ["esperar", "esperar"],
    ["meta", "meta"],
  ] as const)("register da %s: se devuelve %s, sin guardar", async (motivo, esperado) => {
    h.registrar.mockResolvedValue(falla(motivo));

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe(esperado);

    expect(h.ejecutadas).toHaveLength(0);
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("register rechazado: revision y aviso rechazo, sin guardar 'conectado'", async () => {
    h.registrar.mockResolvedValue(falla("rechazo", 133005));

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("rechazo", TENANT);
    expect(h.ejecutadas).toHaveLength(0);
  });

  it.each([
    ["no_aplica", () => h.guardar.mockResolvedValue(guardo("no_aplica"))],
    ["id_ocupado", () => h.guardar.mockResolvedValue(guardo("id_ocupado"))],
    ["un error de la base", () => h.guardar.mockRejectedValue(new Error("se cayó"))],
  ])("guardar 'conectado' da %s: revision y aviso sin_dueno (Meta lo tiene registrado)", async (_cual, preparar) => {
    preparar();

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("revision");

    expect(h.registrar).toHaveBeenCalledTimes(1);
    expect(h.aviso).toHaveBeenCalledWith("sin_dueno", TENANT);
  });

  it("nunca tira, y anota sólo el nombre del error", async () => {
    h.verificarEnMeta.mockRejectedValue(new Error(`boom ${TOKEN} ${CODIGO}`));

    await expect(verificarCodigo(QUIEN, CODIGO)).resolves.toBe("meta");

    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "alta.numero_automatico_fallo");
    expect(JSON.stringify(h.error.mock.calls)).not.toContain(CODIGO);
  });
});

describe("verificarCodigo: el webhook propio del número", () => {
  beforeEach(() => {
    h.leer.mockResolvedValue([fila({ phone_number_id: ID })]);
  });

  it("se pone después de registrar y antes de guardar 'conectado'", async () => {
    const orden: string[] = [];
    const anota = <T>(paso: string, devuelve: T) => async () => {
      orden.push(paso);
      return devuelve;
    };
    h.registrar.mockImplementation(anota("registrar", ok(true)));
    h.fijarWebhook.mockImplementation(anota("fijar", ok(true)));
    h.leerWebhook.mockImplementation(anota("leer", ok(true)));
    h.guardar.mockImplementation(anota("guardar", guardo("ok")));

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("conectado");

    expect(orden).toEqual(["registrar", "fijar", "leer", "guardar"]);
  });

  it("Graph no lo devuelve como puesto: revision y aviso sin_webhook, sin guardar 'conectado' ni espejar", async () => {
    h.leerWebhook.mockResolvedValue(ok(false));

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("sin_webhook", TENANT);
    expect(h.ejecutadas).toHaveLength(0);
    expect(h.espejar).not.toHaveBeenCalled();
  });

  it.each([
    ["esperar", "esperar"],
    ["meta", "meta"],
  ] as const)("ponerlo da %s: se devuelve %s, sin leerlo ni guardar", async (motivo, esperado) => {
    h.fijarWebhook.mockResolvedValue(falla(motivo));

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe(esperado);

    expect(h.leerWebhook).not.toHaveBeenCalled();
    expect(h.ejecutadas).toHaveLength(0);
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("ponerlo rechazado: revision y aviso rechazo, sin guardar", async () => {
    h.fijarWebhook.mockResolvedValue(falla("rechazo", 100));

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("rechazo", TENANT);
    expect(h.leerWebhook).not.toHaveBeenCalled();
    expect(h.ejecutadas).toHaveLength(0);
  });

  it.each([
    ["esperar", "esperar"],
    ["meta", "meta"],
  ] as const)("leerlo da %s: se devuelve %s, sin guardar 'conectado'", async (motivo, esperado) => {
    h.leerWebhook.mockResolvedValue(falla(motivo));

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe(esperado);

    expect(h.ejecutadas).toHaveLength(0);
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("otro intento con el webhook mal vuelve a ponerlo sin registrar de nuevo: el número ya figura registrado", async () => {
    h.leerWebhook.mockResolvedValueOnce(ok(false));
    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("revision");

    h.yaRegistrado.mockResolvedValue(ok(true));
    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("conectado");

    expect(h.registrar).toHaveBeenCalledTimes(1);
    expect(h.fijarWebhook).toHaveBeenCalledTimes(2);
  });

  it("el token del apretón de manos no llega al registro, al aviso ni a la base", async () => {
    h.leerWebhook.mockResolvedValueOnce(ok(false));
    await verificarCodigo(QUIEN, CODIGO);
    h.leerWebhook.mockRejectedValueOnce(new Error(`boom ${WEBHOOK.verifyToken}`));
    await verificarCodigo(QUIEN, CODIGO);

    const visto = JSON.stringify([
      h.info.mock.calls,
      h.warn.mock.calls,
      h.error.mock.calls,
      h.aviso.mock.calls,
      h.ejecutadas.map(valoresDe),
    ]);
    expect(visto).not.toContain(WEBHOOK.verifyToken);
  });
});

describe("el espejo a la base del cliente", () => {
  it("después de guardar 'agregado' y después de guardar 'conectado', con el espacio de la sesión", async () => {
    await pedirCodigo(QUIEN, "SMS");
    expect(h.espejar).toHaveBeenCalledTimes(1);
    expect(h.espejar).toHaveBeenLastCalledWith(TENANT);

    h.leer.mockResolvedValue([fila({ phone_number_id: ID })]);
    await verificarCodigo(QUIEN, CODIGO);
    expect(h.espejar).toHaveBeenCalledTimes(2);
    expect(h.espejar).toHaveBeenLastCalledWith(TENANT);
  });

  it("sólo después de que la escritura en control salió: ni antes, ni cuando la función dice que no", async () => {
    h.guardar.mockImplementation(async () => {
      expect(h.espejar).not.toHaveBeenCalled();
      return guardo("ok");
    });
    await pedirCodigo(QUIEN, "SMS");
    expect(h.espejar).toHaveBeenCalledTimes(1);

    h.espejar.mockClear();
    h.guardar.mockResolvedValue(guardo("no_aplica"));
    await pedirCodigo(QUIEN, "SMS");
    h.guardar.mockRejectedValue(new Error("se cayó"));
    await pedirCodigo(QUIEN, "SMS");
    expect(h.espejar).not.toHaveBeenCalled();
  });

  it("si la copia no entra, la persona igual avanza: el espejo no hace fallar el paso", async () => {
    h.espejar.mockResolvedValue(false);
    expect(await pedirCodigo(QUIEN, "SMS")).toBe("codigo_enviado");

    h.leer.mockResolvedValue([fila({ phone_number_id: ID })]);
    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("conectado");
  });
});

describe("un número del otro ambiente", () => {
  it.each([
    ["por su número", NUMERO],
    ["por su número con otro formato (+54 sin el 9)", "+54 11 0000-0000"],
  ])("%s: revision, aviso de_otro_ambiente, sin Graph ni base, y vuelven los cupos de código", async (_cual, enLaLista) => {
    process.env.NUMEROS_DE_DEV = `100000000000999, ${enLaLista}`;

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("revision");

    sinGraph();
    expect(h.aviso).toHaveBeenCalledTimes(1);
    expect(h.aviso).toHaveBeenCalledWith("de_otro_ambiente", TENANT);
    expect(h.ejecutadas).toHaveLength(0);
    expect(h.espejar).not.toHaveBeenCalled();
    expect(clavesLiberadas()).toEqual(clavesTomadas());
    expect(clavesLiberadas()).toHaveLength(3);
  });

  it("por el id que Graph ya le dio: no se verifica ni se registra ni se le pone webhook", async () => {
    process.env.NUMEROS_DE_DEV = ID;
    h.leer.mockResolvedValue([fila({ phone_number_id: ID })]);

    expect(await verificarCodigo(QUIEN, CODIGO)).toBe("revision");

    sinGraph();
    expect(h.aviso).toHaveBeenCalledWith("de_otro_ambiente", TENANT);
    expect(h.ejecutadas).toHaveLength(0);
    expect(clavesLiberadas()).toEqual([`wa:verificar:${TENANT}`]);
  });

  it("sin NUMEROS_DE_DEV (dev, QA, local) no cambia nada", async () => {
    delete process.env.NUMEROS_DE_DEV;

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("codigo_enviado");
    expect(h.aviso).not.toHaveBeenCalledWith("de_otro_ambiente", TENANT);
  });

  it("un número que no está en la lista sigue", async () => {
    process.env.NUMEROS_DE_DEV = "+5491100009999, 100000000000999";

    expect(await pedirCodigo(QUIEN, "SMS")).toBe("codigo_enviado");
  });
});

describe("lo que no se anota ni se guarda", () => {
  it("enControl se llama como mucho dos veces por llamada: leer la fila y guardar el paso", async () => {
    await pedirCodigo(QUIEN, "SMS");
    expect(h.enControl.mock.calls.length).toBeLessThanOrEqual(2);

    h.enControl.mockClear();
    h.leer.mockResolvedValue([fila({ phone_number_id: ID })]);
    await verificarCodigo(QUIEN, CODIGO);
    expect(h.enControl.mock.calls.length).toBeLessThanOrEqual(2);
    for (const [ctx] of h.enControl.mock.calls) expect(ctx).toEqual({ tenantId: TENANT });
  });

  it("ni el token ni el código llegan al registro, al aviso, a la base o al resultado, ni siquiera cuando algo falla", async () => {
    h.leer.mockResolvedValue([fila({ phone_number_id: ID })]);
    const resultados: string[] = [];

    for (const preparar of [
      () => undefined,
      () => h.yaVerificado.mockResolvedValue(ok(false)),
      () => h.guardar.mockResolvedValue(guardo("no_aplica")),
      () => h.guardar.mockRejectedValue(new Error(`boom ${TOKEN} ${CODIGO}`)),
      () => h.verificarEnMeta.mockRejectedValue(new Error(`boom ${TOKEN} ${CODIGO}`)),
    ]) {
      caminoFeliz();
      h.leer.mockResolvedValue([fila({ phone_number_id: ID })]);
      h.verificarEnMeta.mockResolvedValue(falla("rechazo", 100));
      preparar();
      resultados.push(await verificarCodigo(QUIEN, CODIGO));
    }

    const visto = JSON.stringify([
      h.debug.mock.calls,
      h.info.mock.calls,
      h.warn.mock.calls,
      h.error.mock.calls,
      h.aviso.mock.calls,
      h.ejecutadas.map(valoresDe),
      h.rateLimit.mock.calls,
      h.liberarCupo.mock.calls,
      resultados,
    ]);
    expect(visto).not.toContain(CODIGO);
    expect(visto).not.toContain(TOKEN);
    expect(h.error).toHaveBeenCalled();
  });

  it("el número de la plataforma nunca llega a Graph como destino ni a la base como id del espacio", async () => {
    await pedirCodigo(QUIEN, "SMS");
    h.leer.mockResolvedValue([fila({ phone_number_id: ID })]);
    await verificarCodigo(QUIEN, CODIGO);

    for (const f of [h.pedirAMeta, h.verificarEnMeta, h.yaRegistrado, h.registrar, h.yaVerificado]) {
      for (const [, id] of f.mock.calls) expect(id).not.toBe(PLATAFORMA);
    }
    for (const consulta of h.ejecutadas) expect(valoresDe(consulta)[3]).not.toBe(PLATAFORMA);
  });
});
