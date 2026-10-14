/**
 * El alta con la WABA propia (`@/server/alta/waba-propia`): el orden de los pasos,
 * qué se le contesta a la persona en cada salida, qué cupo se devuelve y qué se
 * guarda, sobre todo qué NO llega nunca a un resultado ni a un registro (el token,
 * el PIN y el código del popup).
 *
 * Graph, la base, el contador de cupos y el aviso al operador están simulados. El
 * cifrado es el de verdad, para probar que lo que se guarda abre con su AAD y con
 * ningún otro. Qué URL y qué cuerpo salen a Graph está en los tests de
 * `embedded-signup` y `alta-de-numero`, y el SQL de la función de la 0051 lo prueba
 * `pnpm tenancy` contra una base de verdad.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  liberarCupo: vi.fn(),
  enControl: vi.fn(),
  /** Lo que devuelve la consulta de la fila (el espacio con su WABA y su número). */
  leer: vi.fn(),
  /** Lo que devuelve `db.execute` para el paso que se le pasa (la función de la 0051). */
  guardar: vi.fn(),
  ejecutadas: [] as Array<{ queryChunks: unknown[] }>,
  idPlataforma: vi.fn(),
  wabaPlataforma: vi.fn(),
  webhook: vi.fn(),
  credencial: vi.fn(),
  espejar: vi.fn(),
  recorrer: vi.fn(),
  estaEnLaWaba: vi.fn(),
  pedirAMeta: vi.fn(),
  verificarEnMeta: vi.fn(),
  yaVerificado: vi.fn(),
  yaRegistrado: vi.fn(),
  registrar: vi.fn(),
  fijarWebhook: vi.fn(),
  leerWebhook: vi.fn(),
  canjear: vi.fn(),
  revisar: vi.fn(),
  suscribir: vi.fn(),
  desuscribir: vi.fn(),
  datos: vi.fn(),
  negocio: vi.fn(),
  plantilla: vi.fn(),
  baja: vi.fn(),
  otroAmbiente: vi.fn(),
  aviso: vi.fn(),
  leerApp: vi.fn(),
  leerSalud: vi.fn(),
  perfil: vi.fn(),
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
  for (const paso of ["from", "leftJoin", "innerJoin", "where", "limit"]) cadena[paso] = () => cadena;
  cadena.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => h.leer().then(ok, ko);
  const db = {
    select: () => cadena,
    execute: (consulta: { queryChunks: unknown[] }) => {
      h.ejecutadas.push(consulta);
      const paso = consulta.queryChunks.filter((c) => typeof c !== "object" || c === null)[2];
      return h.guardar(paso);
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
  idDeLaPlataforma: h.idPlataforma,
  wabaDeLaPlataforma: h.wabaPlataforma,
  webhookDelEntorno: h.webhook,
}));
vi.mock("@/server/whatsapp/verificar-en-meta", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/whatsapp/verificar-en-meta")>()),
  recorrerLaWaba: h.recorrer,
  estaEnLaWaba: h.estaEnLaWaba,
}));
vi.mock("@/server/whatsapp/alta-de-numero", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/whatsapp/alta-de-numero")>()),
  pedirCodigoAMeta: h.pedirAMeta,
  verificarCodigoEnMeta: h.verificarEnMeta,
  codigoYaVerificado: h.yaVerificado,
  numeroYaRegistrado: h.yaRegistrado,
  registrarNumero: h.registrar,
  fijarWebhookDelNumero: h.fijarWebhook,
  webhookPropioEs: h.leerWebhook,
}));
vi.mock("@/server/whatsapp/embedded-signup", async (importOriginal) => ({
  // `codigoVencido` es la de verdad: qué subcódigo de Meta cuenta como código vencido es parte de lo que se prueba.
  ...(await importOriginal<typeof import("@/server/whatsapp/embedded-signup")>()),
  appDeMeta: () => ({ appId: "fake-app-id", configId: "fake-config-id" }),
  canjearCodigo: h.canjear,
  revisarToken: h.revisar,
  suscribirApp: h.suscribir,
  desuscribirApp: h.desuscribir,
  datosDelNumero: h.datos,
  negocioDeLaWaba: h.negocio,
  crearPlantillaReabrir: h.plantilla,
  bajaDelNumero: h.baja,
}));
vi.mock("@/server/whatsapp/app-del-cliente", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/whatsapp/app-del-cliente")>()),
  leerApp: h.leerApp,
  leerSalud: h.leerSalud,
  completarPerfil: h.perfil,
}));
vi.mock("@/server/ambiente/de-otro-ambiente", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/ambiente/de-otro-ambiente")>()),
  esNumeroDeOtroAmbiente: h.otroAmbiente,
}));
vi.mock("@/server/alta/aviso-operador", () => ({ avisarNumeroEnRevision: h.aviso }));

import { esAR } from "@/lib/i18n";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { cifrar, descifrar } from "@/lib/security/cifrado";
import { CATEGORIA_INICIAL, CATEGORIAS_DE_PERFIL } from "@/lib/whatsapp-categorias";
import type { QuienPide } from "@/server/alta/pasos-del-numero";
import { cerrarSecreto, pruebaDelSecreto } from "@/server/whatsapp/sobres-del-cliente";
import {
  aceptarNumero,
  almacenDelInquilino,
  cancelarWaba,
  codigoWaba,
  continuarWaba,
  desconectarWaba,
  iniciarWaba,
  pinWaba,
  reintentarWaba,
  vincularWaba,
  type PedidoDeVinculo,
} from "@/server/alta/waba-propia";

const HORA_MS = 60 * 60_000;
const DIA_MS = 24 * HORA_MS;
const VENTANA = 1_700_000_000_000;
const TENANT = "11111111-1111-4111-8111-111111111111";
const USUARIO = "22222222-2222-4222-8222-222222222222";
const IP = "203.0.113.7";
/** La WABA del cliente, su negocio y su número. */
const WABA = "200000000000001";
const BUSINESS = "400000000000001";
const ID = "100000000000777";
/** Lo de la plataforma, que no se asigna a nadie. */
const WABA_PLATAFORMA = "300000000000001";
const ID_PLATAFORMA = "100000000000001";
const TOKEN = "fake-client-access-token";
const PIN = "482915";
const CODE = "fake-popup-code";
const NUMERO = "+5491112345678";
const DISPLAY = "+54 9 11 1234-5678";
const CRED = { accessToken: TOKEN, wabaId: WABA };
const WEBHOOK = { url: "https://claimmix.example.com/api/webhooks/whatsapp", verifyToken: "fake-verify-token" };

const QUIEN: QuienPide = { tenantId: TENANT, userId: USUARIO, ip: IP, idioma: "es-AR" };
const PEDIDO: PedidoDeVinculo = { code: CODE, evento: "FINISH", wabaId: WABA, phoneNumberId: ID };

// La clave va al cargar el módulo: las tablas de `it.each` arman sobres antes de que corra cualquier beforeEach.
process.env.GMAIL_TOKEN_ENCRYPTION_KEY = "test-waba-encryption-key";
process.env.WHATSAPP_APP_SECRETS_KEY = "test-app-secrets-key";

const APP_DE_LA_PLATAFORMA = "100000000000009";
/** Las banderas y credenciales que prenden el popup (`wabaPropia()`): cada test parte con la vía prendida. */
const POPUP_PRENDIDO = {
  ALTA_WABA_PROPIA: "1",
  META_APP_ID: APP_DE_LA_PLATAFORMA,
  META_ES_CONFIG_ID: "fake-config-id",
  WHATSAPP_APP_SECRET: "fake-app-secret",
};
/** Lo que prende la vía de la app propia (`appPropia()`): sólo la usan los tests de esa vía. */
const APP_PRENDIDA = { ALTA_APP_PROPIA: "1", NEXT_PUBLIC_SITE_URL: "https://claimmix.example.com" };
const ENTORNO = ["ALTA_TOPE_WABAS_SEMANA", "ALTA_TOPE_NUMEROS_DIA", ...Object.keys(POPUP_PRENDIDO), ...Object.keys(APP_PRENDIDA)] as const;
const guardado: Record<string, string | undefined> = {};

const aadToken = (waba = WABA) => `wa:${TENANT}:${waba}`;
const aadPin = (waba = WABA) => `wa-pin:${TENANT}:${waba}`;

/** Lo que devuelve la consulta de la fila: un espacio sin WABA, con el número que tipeó la persona. */
const filaDb = (extra: Record<string, unknown> = {}) => ({
  estado: null,
  falla: null,
  wabaId: null,
  businessId: null,
  numeroMeta: null,
  numeroAceptado: false,
  nombreEstado: null,
  plantilla: null,
  pinCifrado: null,
  numeroEstado: "pedido",
  phoneNumberId: null,
  numeroTipeado: NUMERO,
  wabaDelNumero: null,
  tokenCifrado: null,
  emailDeContacto: "dueno@example.com",
  ...extra,
});

/** La fila de una WABA ya vinculada, con el token y el PIN cifrados como los guarda la base. */
const vinculada = (extra: Record<string, unknown> = {}) =>
  filaDb({
    estado: "vinculada",
    wabaId: WABA,
    businessId: BUSINESS,
    numeroMeta: NUMERO,
    phoneNumberId: ID,
    wabaDelNumero: WABA,
    tokenCifrado: cifrar(TOKEN, aadToken()),
    pinCifrado: cifrar(PIN, aadPin()),
    ...extra,
  });

const ok = <T>(valor: T) => ({ ok: true as const, valor });
const falla = (motivo: "esperar" | "meta" | "rechazo", codigo: number | null = null) => ({
  ok: false as const,
  falla: motivo,
  codigo,
});
const guardo = (resultado: string) => ({ rows: [{ r: { resultado } }] });
const errorPg = (code: string) => Object.assign(new Error("pg"), { code });

const datosDelNumero = (extra: Record<string, unknown> = {}) =>
  ok({ display: DISPLAY, nombre: "Seguros Sur", verificado: true, nombreEstado: "APPROVED", enLaApp: false, ...extra });

/** Cómo contesta la función de la base a cada paso; lo que no se nombra es 'ok'. Un Error se lanza. */
function guardaSegun(respuestas: Record<string, string | Error> = {}) {
  h.guardar.mockReset();
  h.guardar.mockImplementation(async (paso: string) => {
    const r = respuestas[paso] ?? "ok";
    if (r instanceof Error) throw r;
    return guardo(r);
  });
}

/** La primera lectura es la de antes de vincular; las que siguen, la de después. */
function lecturas(primera: unknown, siguiente: unknown = primera) {
  h.leer.mockReset();
  h.leer.mockResolvedValueOnce([primera]).mockResolvedValue([siguiente]);
}

/** Todo bien de punta a punta; cada caso cambia lo suyo. */
function caminoFeliz() {
  guardaSegun();
  lecturas(filaDb(), vinculada());
  h.canjear.mockResolvedValue(ok({ token: TOKEN }));
  h.revisar.mockResolvedValue(ok({ wabaIds: [WABA], fbUserId: "1234567890" }));
  h.estaEnLaWaba.mockResolvedValue(true);
  h.recorrer.mockResolvedValue({ filas: [{ id: ID, display: null, nombre: null }], completa: true });
  h.datos.mockResolvedValue(datosDelNumero());
  h.negocio.mockResolvedValue(ok(BUSINESS));
  h.suscribir.mockResolvedValue(ok(true));
  h.desuscribir.mockResolvedValue(ok(true));
  h.yaRegistrado.mockResolvedValue(ok(false));
  h.registrar.mockResolvedValue(ok(true));
  h.fijarWebhook.mockResolvedValue(ok(true));
  h.leerWebhook.mockResolvedValue(ok(true));
  h.pedirAMeta.mockResolvedValue(ok(true));
  h.verificarEnMeta.mockResolvedValue(ok(true));
  h.yaVerificado.mockResolvedValue(ok(true));
  h.plantilla.mockResolvedValue(ok(true));
  h.baja.mockResolvedValue(ok(true));
  h.otroAmbiente.mockReturnValue(false);
  h.leerApp.mockResolvedValue(ok("ninguno"));
  h.leerSalud.mockResolvedValue(ok({ puedeEnviar: "AVAILABLE" }));
  h.perfil.mockResolvedValue(ok(true));
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

/** Los valores sueltos que llevó la consulta a la función de la 0051: espacio, usuario, paso, datos, WABA y número de la plataforma, IP. */
const valoresDe = (consulta: { queryChunks: unknown[] }) =>
  consulta.queryChunks.filter((c) => typeof c !== "object" || c === null);

/** Los pasos que se escribieron, en orden, con sus datos. */
const escrito = () =>
  h.ejecutadas.map((q) => {
    const v = valoresDe(q);
    return { paso: v[2] as string, datos: JSON.parse(v[3] as string) as Record<string, unknown> };
  });
const pasosEscritos = () => escrito().map((e) => e.paso);
const datosDe = (paso: string, indice = 0) => escrito().filter((e) => e.paso === paso)[indice]?.datos;

const sinGraph = () => {
  for (const f of [h.canjear, h.revisar, h.suscribir, h.desuscribir, h.datos, h.plantilla, h.baja, h.yaRegistrado, h.registrar, h.fijarWebhook, h.pedirAMeta, h.verificarEnMeta, h.recorrer, h.estaEnLaWaba]) {
    expect(f).not.toHaveBeenCalled();
  }
};

/** Todo lo que se anotó en el registro, junto: ahí no puede haber ni token, ni PIN, ni código. */
const registro = () => JSON.stringify([h.debug.mock.calls, h.info.mock.calls, h.warn.mock.calls, h.error.mock.calls]);

beforeEach(() => {
  vi.clearAllMocks();
  h.ejecutadas.length = 0;
  for (const k of ENTORNO) {
    guardado[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, POPUP_PRENDIDO);
  contadorRechaza();
  h.liberarCupo.mockResolvedValue(undefined);
  h.aviso.mockResolvedValue(undefined);
  h.credencial.mockReturnValue({ accessToken: "fake-platform-token", phoneNumberId: ID_PLATAFORMA, wabaId: WABA_PLATAFORMA });
  h.idPlataforma.mockReturnValue(ID_PLATAFORMA);
  h.wabaPlataforma.mockReturnValue(WABA_PLATAFORMA);
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

describe("iniciarWaba", () => {
  beforeEach(() => lecturas(filaDb()));

  it("deja todo listo para el popup: el perfil sale del nombre, el correo y el número del espacio, y no escribe nada salvo el chequeo del cupo", async () => {
    const r = await iniciarWaba(QUIEN, { nombre: "Seguros Sur", web: "https://seguros.example.com" });

    expect(r).toEqual({
      resultado: "listo",
      setup: {
        business: {
          name: "Seguros Sur",
          email: "dueno@example.com",
          website: "https://seguros.example.com",
          phone: { code: 54, number: "91112345678" },
          address: { country: "AR" },
          timezone: "UTC-03:00",
        },
        phone: {
          displayName: "Seguros Sur",
          category: "FINANCE",
          description: esAR["alta.whatsapp.descripcionPerfil"].replace("{empresa}", "Seguros Sur"),
        },
      },
    });
    expect(escrito()).toEqual([{ paso: "iniciar", datos: { tope: 10 } }]);
    expect(clavesTomadas()).toEqual([claveDeCupo("wa:es:inicio", TENANT)]);
    expect(h.rateLimit).toHaveBeenCalledWith(claveDeCupo("wa:es:inicio", TENANT), { limit: 3, windowMs: DIA_MS, fallaCerrada: true });
    expect(h.liberarCupo).not.toHaveBeenCalled();
    sinGraph();
  });

  it("sin sitio web, sin correo o con un número que no es un móvil argentino, el popup no los precarga", async () => {
    lecturas(filaDb({ emailDeContacto: null, numeroTipeado: "+541123456789" }));

    const r = await iniciarWaba(QUIEN, { nombre: "Seguros Sur" });

    expect(r).toMatchObject({ resultado: "listo" });
    if (r.resultado !== "listo" || !("setup" in r)) throw new Error("falta el setup");
    expect(r.setup.business).toEqual({ name: "Seguros Sur", address: { country: "AR" }, timezone: "UTC-03:00" });
  });

  it("la descripción sale del idioma de quien pide", async () => {
    const r = await iniciarWaba({ ...QUIEN, idioma: "en-US" }, { nombre: "Seguros Sur" });

    if (r.resultado !== "listo" || !("setup" in r)) throw new Error("falta el setup");
    expect(r.setup.phone.description).toBe("Insurance claims for Seguros Sur");
  });

  it.each(CATEGORIAS_DE_PERFIL)("el rubro %s que eligió el cliente es el que precarga el popup", async (categoria) => {
    const r = await iniciarWaba(QUIEN, { nombre: "Seguros Sur", categoria });

    if (r.resultado !== "listo" || !("setup" in r)) throw new Error("falta el setup");
    expect(r.setup.phone.category).toBe(categoria);
  });

  it.each([
    ["ausente", undefined],
    ["fuera de la lista", "CRYPTO"],
    ["en minúsculas", "finance"],
    ["que Meta no ofrece", "UNDEFINED"],
    ["que no es texto", 7],
  ])("un rubro %s se descarta y el popup trae el inicial", async (_caso, categoria) => {
    const r = await iniciarWaba(QUIEN, { nombre: "Seguros Sur", categoria: categoria as never });

    if (r.resultado !== "listo" || !("setup" in r)) throw new Error("falta el setup");
    expect(r.setup.phone.category).toBe(CATEGORIA_INICIAL);
    expect(CATEGORIA_INICIAL).toBe("FINANCE");
  });

  it("el rubro viaja sólo en el setup: no se escribe nada más que el chequeo del cupo", async () => {
    await iniciarWaba(QUIEN, { nombre: "Seguros Sur", categoria: "EDU" });

    expect(escrito()).toEqual([{ paso: "iniciar", datos: { tope: 10 } }]);
  });

  it("el tope semanal sale de ALTA_TOPE_WABAS_SEMANA", async () => {
    process.env.ALTA_TOPE_WABAS_SEMANA = "3";

    await iniciarWaba(QUIEN, { nombre: "Seguros Sur" });

    expect(datosDe("iniciar")).toEqual({ tope: 3 });
  });

  it("sin lugar esta semana: avisa una vez al operador, contesta «cupo» y devuelve el intento", async () => {
    guardaSegun({ iniciar: "cupo" });

    expect(await iniciarWaba(QUIEN, { nombre: "Seguros Sur" })).toEqual({ resultado: "cupo" });

    expect(h.aviso).toHaveBeenCalledWith("cupo_semanal", TENANT);
    expect(clavesLiberadas()).toEqual([claveDeCupo("wa:es:inicio", TENANT)]);
  });

  it("un espacio que no puede pasar por acá (sin alta automática o sin servicio) se mira a mano, sin avisar", async () => {
    guardaSegun({ iniciar: "no_aplica" });

    expect(await iniciarWaba(QUIEN, { nombre: "Seguros Sur" })).toEqual({ resultado: "revision" });

    expect(h.aviso).not.toHaveBeenCalled();
    expect(clavesLiberadas()).toHaveLength(1);
  });

  it("ya conectado: no escribe nada y devuelve el intento", async () => {
    lecturas(filaDb({ numeroEstado: "conectado" }));

    expect(await iniciarWaba(QUIEN, { nombre: "Seguros Sur" })).toEqual({ resultado: "conectado" });

    expect(h.ejecutadas).toHaveLength(0);
    expect(clavesLiberadas()).toHaveLength(1);
  });

  it("una WABA propia ya conectada también cierra la puerta", async () => {
    lecturas(vinculada({ estado: "conectada", numeroEstado: "conectado" }));

    expect(await iniciarWaba(QUIEN, { nombre: "Seguros Sur" })).toEqual({ resultado: "conectado" });
  });

  it("tres inicios por día y por espacio: el cuarto espera, y no toca la base", async () => {
    contadorRechaza("wa:es:inicio");

    expect(await iniciarWaba(QUIEN, { nombre: "Seguros Sur" })).toEqual({ resultado: "esperar" });

    expect(h.leer).not.toHaveBeenCalled();
    expect(h.ejecutadas).toHaveLength(0);
  });

  it("sin la migración 0051 (la tabla no existe) el alta propia está apagada", async () => {
    h.leer.mockReset();
    h.leer.mockRejectedValue(errorPg("42P01"));

    expect(await iniciarWaba(QUIEN, { nombre: "Seguros Sur" })).toEqual({ resultado: "apagado" });

    expect(h.error).not.toHaveBeenCalled();
  });

  it("la función de la 0051 sin aplicar (42883) también es «apagado»", async () => {
    guardaSegun({ iniciar: errorPg("42883") });

    expect(await iniciarWaba(QUIEN, { nombre: "Seguros Sur" })).toEqual({ resultado: "apagado" });
  });

  it("una falla de la base no tira: se anota por nombre y vuelve «meta»", async () => {
    h.leer.mockReset();
    h.leer.mockRejectedValue(new TypeError("conexión caída para 11111111"));

    expect(await iniciarWaba(QUIEN, { nombre: "Seguros Sur" })).toEqual({ resultado: "meta" });

    expect(registro()).toContain("TypeError");
    expect(registro()).not.toContain("conexión caída");
    expect(clavesLiberadas()).toHaveLength(1);
  });
});

describe("vincularWaba: el camino entero", () => {
  it("canjea, revisa el token, guarda el vínculo cifrado y sigue hasta dejar el número conectado", async () => {
    const r = await vincularWaba(QUIEN, PEDIDO);

    expect(r).toEqual({ resultado: "conectado" });
    expect(pasosEscritos()).toEqual(["vincular", "estado", "conectar", "estado"]);

    expect(h.canjear).toHaveBeenCalledWith(CODE);
    expect(h.revisar).toHaveBeenCalledWith(TOKEN);
    expect(h.estaEnLaWaba).toHaveBeenCalledWith(WABA, ID, TOKEN);
    expect(h.datos).toHaveBeenCalledWith(TOKEN, ID);
    expect(h.suscribir).toHaveBeenCalledWith(TOKEN, WABA);
    expect(h.registrar).toHaveBeenCalledWith(CRED, ID, PIN);
    expect(h.fijarWebhook).toHaveBeenCalledWith(CRED, ID, WEBHOOK);
    expect(datosDe("conectar")).toEqual({ phone_number_id: ID });
    // Se espeja la base del cliente después de vincular y de conectar, no después de los pasos de estado.
    expect(h.espejar).toHaveBeenCalledTimes(2);
    expect(clavesTomadas()).toEqual([claveDeCupo("wa:es", TENANT), claveDeCupo("wa:registrar", TENANT)]);
    expect(h.rateLimit).toHaveBeenCalledWith(claveDeCupo("wa:es", TENANT), { limit: 5, windowMs: HORA_MS, fallaCerrada: true });
    // Graph se tocó: el cupo de vincular queda gastado.
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("guarda el token y el PIN cifrados con el espacio y la WABA, y ni el uno ni el otro en claro", async () => {
    await vincularWaba(QUIEN, PEDIDO);

    const v = datosDe("vincular")!;
    expect(v).toMatchObject({
      business_id: BUSINESS,
      waba_id: WABA,
      phone_number_id: ID,
      numero_meta: NUMERO,
      fb_user_id: "1234567890",
      tope: 10,
    });
    const token = v.token_cifrado as string;
    const pin = v.pin_cifrado as string;
    expect(descifrar(token, undefined, aadToken())).toBe(TOKEN);
    expect(descifrar(pin, undefined, aadPin())).toMatch(/^\d{6}$/);
    // El sobre de un espacio o de una WABA no abre en otra fila, ni el del PIN con el AAD del token.
    expect(() => descifrar(token, undefined, `wa:otro-espacio:${WABA}`)).toThrow();
    expect(() => descifrar(token, undefined, aadToken("200000000000002"))).toThrow();
    expect(() => descifrar(pin, undefined, aadToken())).toThrow();
    const escritura = JSON.stringify(escrito());
    expect(escritura).not.toContain(TOKEN);
    expect(escritura).not.toContain(CODE);
  });

  it("ni el token, ni el PIN, ni el código del popup llegan al resultado ni al registro", async () => {
    const r = await vincularWaba(QUIEN, PEDIDO);

    for (const secreto of [TOKEN, PIN, CODE]) {
      expect(JSON.stringify(r)).not.toContain(secreto);
      expect(registro()).not.toContain(secreto);
    }
  });

  it("el portfolio del cupo semanal lo da Meta para esa WABA, no el navegador", async () => {
    await vincularWaba(QUIEN, { ...PEDIDO, businessId: "400000000000099" } as PedidoDeVinculo);

    expect(h.negocio).toHaveBeenCalledWith(TOKEN, WABA);
    expect(datosDe("vincular")!.business_id).toBe(BUSINESS);
  });

  it.each([
    ["Meta no informa el portfolio", ok(null)],
    ["Meta rechaza la consulta del portfolio", falla("rechazo", 100)],
  ])("si %s, el cupo semanal cuenta por la WABA", async (_nombre, respuesta) => {
    h.negocio.mockResolvedValue(respuesta);

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "conectado" });

    expect(datosDe("vincular")!.business_id).toBe(WABA);
  });

  it.each(["esperar", "meta"] as const)("si Meta no contesta el portfolio (%s), no se guarda nada y la persona reintenta", async (motivo) => {
    h.negocio.mockResolvedValue(falla(motivo));

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: motivo });

    expect(pasosEscritos()).toEqual([]);
  });

  it("si la misma WABA se vuelve a vincular, el PIN que ya tenía se conserva", async () => {
    lecturas(vinculada({ estado: "falla", falla: "token_vencido", numeroEstado: "pedido" }), vinculada());

    await vincularWaba(QUIEN, PEDIDO);

    expect(descifrar(datosDe("vincular")!.pin_cifrado as string, undefined, aadPin())).toBe(PIN);
  });

  it("con otra WABA el PIN es nuevo, no el de la anterior", async () => {
    lecturas(vinculada({ estado: "falla", falla: "token_vencido", wabaId: "200000000000009", pinCifrado: cifrar(PIN, aadPin("200000000000009")) }), vinculada());

    await vincularWaba(QUIEN, PEDIDO);

    const nuevo = descifrar(datosDe("vincular")!.pin_cifrado as string, undefined, aadPin());
    expect(nuevo).toMatch(/^\d{6}$/);
    expect(nuevo).not.toBe(PIN);
  });

  it("el userID del popup gana sobre el del token (que es de un usuario del sistema), y sin él queda el del token", async () => {
    await vincularWaba(QUIEN, { ...PEDIDO, userId: "9876543210" });
    expect(datosDe("vincular")).toMatchObject({ fb_user_id: "9876543210" });

    await vincularWaba(QUIEN, { ...PEDIDO, userId: "no-es-un-id" });
    expect(datosDe("vincular", 1)).toMatchObject({ fb_user_id: "1234567890" });
  });

  it("el fb_user_id que no es un número no se guarda", async () => {
    h.revisar.mockResolvedValue(ok({ wabaIds: [WABA], fbUserId: "no-es-un-id" }));

    await vincularWaba(QUIEN, PEDIDO);

    expect(datosDe("vincular")).not.toHaveProperty("fb_user_id");
  });
});

describe("vincularWaba: antes de gastar el código", () => {
  it("cinco intentos por hora y por espacio: el sexto espera sin tocar nada", async () => {
    contadorRechaza("wa:es:");

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "esperar" });

    expect(h.leer).not.toHaveBeenCalled();
    sinGraph();
  });

  it("sin fila (sin la migración) es «apagado» y devuelve el intento", async () => {
    h.leer.mockReset();
    h.leer.mockResolvedValue([]);

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "apagado" });

    expect(clavesLiberadas()).toEqual([claveDeCupo("wa:es", TENANT)]);
    sinGraph();
  });

  it.each([
    ["una WABA propia conectada", vinculada({ estado: "conectada", numeroEstado: "conectado" })],
    ["un número conectado por el camino viejo", filaDb({ numeroEstado: "conectado" })],
    ["un número suspendido", filaDb({ numeroEstado: "suspendido" })],
  ])("con %s ya no hay nada que vincular", async (_nombre, fila) => {
    lecturas(fila);

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "conectado" });

    expect(clavesLiberadas()).toHaveLength(1);
    sinGraph();
  });

  it("una WABA propia en falla con el número todavía vivo y su token sí se vincula de nuevo: es la reconexión", async () => {
    lecturas(vinculada({ estado: "falla", falla: "token_vencido", numeroEstado: "conectado" }), vinculada());

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "conectado" });

    expect(h.canjear).toHaveBeenCalledWith(CODE);
  });

  describe("vincular otra WABA sobre una que ya estaba vinculada", () => {
    const WABA_VIEJA = "777700001111";
    const ID_VIEJO = "777700002222";
    const TOKEN_VIEJO = "fake-token-de-la-waba-vieja";
    const vieja = (extra: Record<string, unknown> = {}) =>
      vinculada({
        estado: "suscripta",
        wabaId: WABA_VIEJA,
        wabaDelNumero: WABA_VIEJA,
        phoneNumberId: ID_VIEJO,
        tokenCifrado: cifrar(TOKEN_VIEJO, aadToken(WABA_VIEJA)),
        pinCifrado: cifrar(PIN, aadPin(WABA_VIEJA)),
        ...extra,
      });

    it("la anterior se suelta en Meta con SU token: se saca la app y se da de baja su número", async () => {
      h.yaRegistrado.mockResolvedValue(ok(true));
      lecturas(vieja(), vinculada());

      await vincularWaba(QUIEN, PEDIDO);

      await vi.waitFor(() => expect(h.desuscribir).toHaveBeenCalledWith(TOKEN_VIEJO, WABA_VIEJA));
      expect(h.yaRegistrado).toHaveBeenCalledWith({ accessToken: TOKEN_VIEJO, wabaId: WABA_VIEJA }, ID_VIEJO);
      expect(h.baja).toHaveBeenCalledWith(TOKEN_VIEJO, ID_VIEJO);
      // Lo del token nuevo no se mezcla con lo de la vieja.
      expect(h.desuscribir).not.toHaveBeenCalledWith(TOKEN, WABA);
    });

    it("si el número es el mismo no se da de baja con el token viejo: sólo se saca la app de la WABA anterior", async () => {
      lecturas(vieja({ phoneNumberId: ID }), vinculada());

      await vincularWaba(QUIEN, PEDIDO);

      await vi.waitFor(() => expect(h.desuscribir).toHaveBeenCalledWith(TOKEN_VIEJO, WABA_VIEJA));
      expect(h.yaRegistrado).not.toHaveBeenCalledWith({ accessToken: TOKEN_VIEJO, wabaId: WABA_VIEJA }, expect.anything());
      expect(h.baja).not.toHaveBeenCalled();
    });

    it("la misma WABA de nuevo, o una fila sin WABA, no suelta nada", async () => {
      lecturas(vinculada({ estado: "falla", falla: "token_vencido", numeroEstado: "conectado" }), vinculada());
      await vincularWaba(QUIEN, PEDIDO);

      lecturas(filaDb(), vinculada());
      await vincularWaba(QUIEN, PEDIDO);

      expect(h.desuscribir).not.toHaveBeenCalledWith(expect.anything(), WABA_VIEJA);
      expect(h.baja).not.toHaveBeenCalled();
    });

    it("si la base no deja guardar el vínculo nuevo, la anterior sigue vinculada y no se toca", async () => {
      guardaSegun({ vincular: "transicion" });
      lecturas(vieja());

      await vincularWaba(QUIEN, PEDIDO);

      expect(h.desuscribir).not.toHaveBeenCalledWith(TOKEN_VIEJO, WABA_VIEJA);
      expect(h.baja).not.toHaveBeenCalled();
    });
  });

  it("sin el número de la plataforma o su WABA cargados, se mira a mano y no se gasta el código", async () => {
    h.wabaPlataforma.mockReturnValue(null);

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "revision" });

    expect(h.aviso).toHaveBeenCalledWith("sin_credencial", TENANT);
    expect(clavesLiberadas()).toHaveLength(1);
    sinGraph();
  });

  it("el evento «sólo la WABA» (sin número) corta antes de Graph y no escribe nada: lo dice el navegador, sin token que lo confirme", async () => {
    expect(await vincularWaba(QUIEN, { ...PEDIDO, evento: "FINISH_ONLY_WABA" })).toEqual({ resultado: "sin_numero" });

    expect(pasosEscritos()).toEqual([]);
    expect(clavesLiberadas()).toHaveLength(1);
    sinGraph();
  });

  it("el evento de la app de WhatsApp Business (coexistencia) corta antes de Graph y no escribe nada: la coexistencia no está en esta versión", async () => {
    expect(await vincularWaba(QUIEN, { ...PEDIDO, evento: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" })).toEqual({
      resultado: "coexistencia",
    });

    expect(pasosEscritos()).toEqual([]);
    sinGraph();
  });

  it.each(["FINISH_ONLY_WABA", "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"])(
    "%s sobre una WABA que se está reconectando no la pisa con una falla",
    async (evento) => {
      lecturas(vinculada({ estado: "falla", falla: "token_vencido", numeroEstado: "conectado" }));

      await vincularWaba(QUIEN, { ...PEDIDO, evento });

      expect(pasosEscritos()).toEqual([]);
    }
  );
});

describe("vincularWaba: el canje y la revisión del token", () => {
  it.each([36007, 36009])("un código vencido o ya usado (Graph 100, subcódigo %s) es «vencido»: se abre el popup de nuevo", async (subcodigo) => {
    h.canjear.mockResolvedValue({ ...falla("rechazo", 100), subcodigo });

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "vencido" });

    expect(h.revisar).not.toHaveBeenCalled();
    expect(pasosEscritos()).toEqual([]);
    expect(h.aviso).not.toHaveBeenCalled();
    // El código se gastó: el intento no vuelve.
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it.each([
    ["un rechazo sin subcódigo (la app o su secreto mal puestos)", { ...falla("rechazo", 100), subcodigo: null }],
    ["otro subcódigo del 100", { ...falla("rechazo", 100), subcodigo: 33 }],
    ["otro código de Graph", { ...falla("rechazo", 190), subcodigo: 36007 }],
  ])("%s no es un código vencido: «meta», con la causa anotada y el aviso al operador", async (_nombre, respuesta) => {
    h.canjear.mockResolvedValue(respuesta);

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "meta" });

    expect(datosDe("estado")).toEqual({ estado: "falla", falla: "canje" });
    expect(h.aviso).toHaveBeenCalledWith("canje", TENANT);
  });

  it("Meta pide esperar: «esperar», sin anotar nada", async () => {
    h.canjear.mockResolvedValue(falla("esperar"));

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "esperar" });

    expect(pasosEscritos()).toEqual([]);
  });

  it("una respuesta rara en el canje: «meta», con la causa anotada y el aviso al operador", async () => {
    h.canjear.mockResolvedValue(falla("meta"));

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "meta" });

    expect(datosDe("estado")).toEqual({ estado: "falla", falla: "canje" });
    expect(h.aviso).toHaveBeenCalledWith("canje", TENANT);
  });

  it("un token que Meta no reconoce como de nuestra app: se mira a mano, con la causa anotada", async () => {
    h.revisar.mockResolvedValue(falla("rechazo", 190));

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "revision" });

    expect(datosDe("estado")).toEqual({ estado: "falla", falla: "token_invalido" });
    expect(h.aviso).toHaveBeenCalledWith("canje", TENANT);
    expect(h.datos).not.toHaveBeenCalled();
  });

  it("si revisar el token falla por Meta, vuelve tal cual: sin anotar una causa", async () => {
    h.revisar.mockResolvedValue(falla("esperar"));

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "esperar" });

    expect(pasosEscritos()).toEqual([]);
  });

  it("un token sin ninguna WABA compartida: se mira a mano", async () => {
    h.revisar.mockResolvedValue(ok({ wabaIds: [], fbUserId: null }));

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "revision" });

    expect(datosDe("estado")).toEqual({ estado: "falla", falla: "token_invalido" });
    expect(h.aviso).toHaveBeenCalledWith("canje", TENANT);
  });

  it("varias WABA y el navegador no dijo cuál (o dijo una que el token no autoriza): no se adivina", async () => {
    h.revisar.mockResolvedValue(ok({ wabaIds: [WABA, "200000000000002"], fbUserId: null }));

    expect(await vincularWaba(QUIEN, { ...PEDIDO, wabaId: "200000000000003" })).toEqual({ resultado: "revision" });

    expect(pasosEscritos()).toEqual(["estado"]);
    expect(h.aviso).toHaveBeenCalledWith("canje", TENANT);
    expect(h.datos).not.toHaveBeenCalled();
  });

  it("varias WABA y el navegador dijo una que el token sí autoriza: esa", async () => {
    h.revisar.mockResolvedValue(ok({ wabaIds: ["200000000000002", WABA], fbUserId: null }));

    await vincularWaba(QUIEN, PEDIDO);

    expect(datosDe("vincular")!.waba_id).toBe(WABA);
  });

  it("el navegador dice una WABA y el token autoriza una sola, otra: vale la del token", async () => {
    h.revisar.mockResolvedValue(ok({ wabaIds: ["200000000000002"], fbUserId: null }));
    h.estaEnLaWaba.mockResolvedValue(false);
    h.recorrer.mockResolvedValue({ filas: [{ id: ID, display: null, nombre: null }], completa: true });

    await vincularWaba(QUIEN, { ...PEDIDO, wabaId: "200000000000003" });

    expect(datosDe("vincular")!.waba_id).toBe("200000000000002");
    expect(h.recorrer).toHaveBeenCalledWith("200000000000002", "id", TOKEN);
  });

  it("la WABA de la plataforma no se vincula a nadie, diga lo que diga el navegador", async () => {
    h.revisar.mockResolvedValue(ok({ wabaIds: [WABA_PLATAFORMA], fbUserId: null }));

    expect(await vincularWaba(QUIEN, { ...PEDIDO, wabaId: WABA_PLATAFORMA })).toEqual({ resultado: "de_la_plataforma" });

    expect(h.datos).not.toHaveBeenCalled();
    expect(pasosEscritos()).toEqual([]);
  });
});

describe("vincularWaba: qué número es", () => {
  it("el número que dice el navegador tiene que figurar en la WABA: si no, se lista la WABA y se toma el único", async () => {
    h.estaEnLaWaba.mockResolvedValue(false);
    h.recorrer.mockResolvedValue({ filas: [{ id: "100000000000888", display: null, nombre: null }], completa: true });

    await vincularWaba(QUIEN, PEDIDO);

    expect(datosDe("vincular")!.phone_number_id).toBe("100000000000888");
    expect(h.datos).toHaveBeenCalledWith(TOKEN, "100000000000888");
  });

  it("sin pista del navegador se lista la WABA y se toma el único número", async () => {
    await vincularWaba(QUIEN, { code: CODE });

    expect(h.estaEnLaWaba).not.toHaveBeenCalled();
    expect(h.recorrer).toHaveBeenCalledWith(WABA, "id", TOKEN);
    expect(datosDe("vincular")!.phone_number_id).toBe(ID);
  });

  it("si Graph no contesta al buscar el número, «meta» y no se guarda nada", async () => {
    h.estaEnLaWaba.mockResolvedValue(null);

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "meta" });

    expect(pasosEscritos()).toEqual([]);
  });

  it("una lista de números a medias no es una lista: «meta»", async () => {
    h.estaEnLaWaba.mockResolvedValue(false);
    h.recorrer.mockResolvedValue({ filas: [{ id: ID, display: null, nombre: null }], completa: false });

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "meta" });
  });

  it("si Graph no contesta la lista: «meta»", async () => {
    h.estaEnLaWaba.mockResolvedValue(false);
    h.recorrer.mockResolvedValue(null);

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "meta" });
  });

  it("una WABA sin ningún número: «sin_numero», con la causa anotada", async () => {
    h.estaEnLaWaba.mockResolvedValue(false);
    h.recorrer.mockResolvedValue({ filas: [], completa: true });

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "sin_numero" });

    expect(datosDe("estado")).toEqual({ estado: "falla", falla: "sin_numero" });
  });

  it("varios números y ninguna pista que valga: no se elige", async () => {
    h.estaEnLaWaba.mockResolvedValue(false);
    h.recorrer.mockResolvedValue({
      filas: [
        { id: ID, display: null, nombre: null },
        { id: "100000000000888", display: null, nombre: null },
      ],
      completa: true,
    });

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "meta" });

    expect(pasosEscritos()).toEqual([]);
  });

  it("el número de la plataforma no se vincula a nadie", async () => {
    h.estaEnLaWaba.mockResolvedValue(false);
    h.recorrer.mockResolvedValue({ filas: [{ id: ID_PLATAFORMA, display: null, nombre: null }], completa: true });

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "de_la_plataforma" });

    expect(h.datos).not.toHaveBeenCalled();
  });

  it("un número que sigue en la app de WhatsApp Business (coexistencia) no se registra", async () => {
    h.datos.mockResolvedValue(datosDelNumero({ enLaApp: true }));

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "coexistencia" });

    expect(datosDe("estado")).toEqual({ estado: "falla", falla: "coexistencia" });
    expect(pasosEscritos()).toEqual(["estado"]);
  });

  it("un número que no es de Argentina se mira a mano", async () => {
    h.datos.mockResolvedValue(datosDelNumero({ display: "+1 415 555 0100" }));

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "revision" });

    expect(h.aviso).toHaveBeenCalledWith("pais", TENANT);
    expect(pasosEscritos()).toEqual([]);
  });

  it("un número de otro ambiente (el de desarrollo en producción o al revés) se mira a mano", async () => {
    h.otroAmbiente.mockReturnValue(true);

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "revision" });

    expect(h.otroAmbiente).toHaveBeenCalledWith(ID, NUMERO);
    expect(h.aviso).toHaveBeenCalledWith("de_otro_ambiente", TENANT);
  });

  it("un número que Meta muestra con un formato ilegible: «meta»", async () => {
    h.datos.mockResolvedValue(datosDelNumero({ display: "no es un número" }));

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "meta" });
  });

  it("un token que Graph dice muerto al leer el número: «revision», con la causa anotada", async () => {
    h.datos.mockResolvedValue(falla("rechazo", 190));

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "revision" });

    expect(datosDe("estado")).toEqual({ estado: "falla", falla: "token_vencido" });
    expect(h.aviso).toHaveBeenCalledWith("token_vencido", TENANT);
  });
});

describe("vincularWaba: lo que contesta la base", () => {
  it.each([
    ["cupo", "cupo", "cupo_semanal"],
    ["numero_ocupado", "numero_ocupado", "numero_ocupado"],
    ["id_ocupado", "numero_ocupado", "numero_ocupado"],
    ["no_aplica", "revision", "sin_dueno"],
  ] as const)("%s: contesta «%s» y avisa «%s»", async (guardado, resultado, motivo) => {
    guardaSegun({ vincular: guardado });

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado });

    expect(h.aviso).toHaveBeenCalledWith(motivo, TENANT);
    expect(pasosEscritos()).toEqual(["vincular"]);
    expect(h.suscribir).not.toHaveBeenCalled();
  });

  it.each([
    ["de_la_plataforma", "de_la_plataforma"],
    ["ya_conectado", "conectado"],
    ["transicion", "esperar"],
    ["datos_invalidos", "meta"],
    ["una respuesta que no es de la lista", "meta"],
  ] as const)("%s: contesta «%s» sin avisar", async (guardado, resultado) => {
    guardaSegun({ vincular: guardado === "una respuesta que no es de la lista" ? "inventada" : guardado });

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado });

    expect(h.aviso).not.toHaveBeenCalled();
    expect(h.suscribir).not.toHaveBeenCalled();
  });

  it("el número ya era de otro espacio (violación de unicidad, 23505): «numero_ocupado»", async () => {
    guardaSegun({ vincular: errorPg("23505") });

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "numero_ocupado" });

    expect(h.aviso).toHaveBeenCalledWith("numero_ocupado", TENANT);
  });

  it("la función sin aplicar (42883): «apagado»", async () => {
    guardaSegun({ vincular: errorPg("42883") });

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "apagado" });
  });

  it("otra falla de la base no tira: se anota el nombre y el código, no el mensaje, y vuelve «meta»", async () => {
    guardaSegun({ vincular: errorPg("XX000") });

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "meta" });

    expect(h.error).toHaveBeenCalledWith({ error: "Error", codigo: "XX000" }, "alta.waba_guardado_fallo");
    expect(registro()).not.toContain(TOKEN);
  });

  it("un error inesperado en cualquier punto no tira: «meta»", async () => {
    h.canjear.mockRejectedValue(new TypeError(`fallo con ${CODE}`));

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "meta" });

    expect(registro()).toContain("TypeError");
    expect(registro()).not.toContain(CODE);
  });
});

describe("vincularWaba: el número que Meta informó no es el que tipeó la persona", () => {
  beforeEach(() => {
    h.datos.mockResolvedValue(datosDelNumero({ display: "+54 9 11 0000-0000" }));
    lecturas(filaDb(), vinculada({ numeroMeta: "+5491100000000" }));
  });

  it("se vincula, pero no se sigue: la persona tiene que confirmarlo, y ve el número de Meta", async () => {
    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "numero_distinto", numeroMeta: "+5491100000000" });

    expect(pasosEscritos()).toEqual(["vincular"]);
    expect(h.suscribir).not.toHaveBeenCalled();
    expect(h.registrar).not.toHaveBeenCalled();
  });

  it("al aceptarlo se sigue desde donde quedó, sin canjear otra vez", async () => {
    await vincularWaba(QUIEN, PEDIDO);
    h.ejecutadas.length = 0;
    h.canjear.mockClear();
    lecturas(vinculada({ numeroMeta: "+5491100000000", numeroAceptado: true }));

    expect(await aceptarNumero(QUIEN)).toBe("conectado");

    expect(pasosEscritos()[0]).toBe("aceptar_numero");
    expect(h.canjear).not.toHaveBeenCalled();
    expect(h.suscribir).toHaveBeenCalled();
  });

  it("sin aceptar, seguir tampoco avanza", async () => {
    lecturas(vinculada({ numeroMeta: "+5491100000000", numeroAceptado: false }));

    expect(await continuarWaba(TENANT, almacenDelInquilino(QUIEN))).toBe("numero_distinto");

    expect(h.suscribir).not.toHaveBeenCalled();
  });

  it("sin número tipeado (en la app propia es opcional) seguir no pide aceptar ninguno", async () => {
    lecturas(vinculada({ numeroTipeado: null, numeroMeta: "+5491100000000", numeroAceptado: false }));

    expect(await continuarWaba(TENANT, almacenDelInquilino(QUIEN))).not.toBe("numero_distinto");

    expect(h.suscribir).toHaveBeenCalled();
  });

  it("el mismo número con o sin el 9 de los celulares argentinos es el mismo", async () => {
    h.datos.mockResolvedValue(datosDelNumero({ display: "+54 11 1234-5678" }));
    lecturas(filaDb(), vinculada({ numeroMeta: "+541112345678" }));

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "conectado" });
  });

  it("una persona que no tipeó número (el alta corta) sigue sin pedir confirmación", async () => {
    lecturas(filaDb({ numeroTipeado: null }), vinculada());

    expect(await vincularWaba(QUIEN, PEDIDO)).toEqual({ resultado: "conectado" });
  });
});

describe("aceptarNumero", () => {
  it("«transicion» es que ya había avanzado (otra pestaña): se sigue desde donde quedó", async () => {
    guardaSegun({ aceptar_numero: "transicion" });
    lecturas(vinculada({ numeroAceptado: true }));

    expect(await aceptarNumero(QUIEN)).toBe("conectado");
  });

  it("sin permiso para el paso, se mira a mano", async () => {
    guardaSegun({ aceptar_numero: "no_aplica" });

    expect(await aceptarNumero(QUIEN)).toBe("revision");

    expect(h.suscribir).not.toHaveBeenCalled();
  });

  it("la función sin aplicar es «apagado»", async () => {
    guardaSegun({ aceptar_numero: errorPg("42883") });

    expect(await aceptarNumero(QUIEN)).toBe("apagado");
  });
});

describe("seguir sin abrir el popup: «aceptar el número» y «reintentar»", () => {
  it("reintentar gasta un cupo de seguir del espacio y retoma", async () => {
    lecturas(vinculada({ estado: "suscripta", nombreEstado: "APPROVED" }));

    expect(await reintentarWaba(QUIEN)).toBe("conectado");

    expect(clavesTomadas()[0]).toBe(claveDeCupo("wa:es:seguir", TENANT));
    expect(h.rateLimit).toHaveBeenCalledWith(claveDeCupo("wa:es:seguir", TENANT), { limit: 20, windowMs: HORA_MS, fallaCerrada: true });
  });

  it("reintentar lee la fila una sola vez: la que decide si la vía rige es la misma con que se sigue", async () => {
    lecturas(vinculada({ estado: "suscripta", nombreEstado: "APPROVED" }));

    expect(await reintentarWaba(QUIEN)).toBe("conectado");

    expect(h.leer).toHaveBeenCalledTimes(1);
  });

  it("con la fila que quien llama ya leyó no la pide de nuevo", async () => {
    lecturas(vinculada({ estado: "suscripta", nombreEstado: "APPROVED" }));
    const leida = await almacenDelInquilino(QUIEN).leer();
    h.leer.mockClear();

    expect(await reintentarWaba(QUIEN, leida)).toBe("conectado");

    expect(h.leer).not.toHaveBeenCalled();
  });

  it("una fila leída que es nula (no hay alta) sigue siendo «apagado» y no se vuelve a leer", async () => {
    expect(await reintentarWaba(QUIEN, null)).toBe("apagado");

    expect(h.leer).not.toHaveBeenCalled();
  });

  it("veinte por hora y por espacio: el siguiente reintento espera sin tocar Graph ni la base", async () => {
    contadorRechaza("wa:es:seguir");

    expect(await reintentarWaba(QUIEN)).toBe("esperar");

    expect(h.leer).not.toHaveBeenCalled();
    expect(h.ejecutadas).toEqual([]);
    sinGraph();
  });

  it("aceptar el número tiene el mismo tope y tampoco escribe sin lugar", async () => {
    contadorRechaza("wa:es:seguir");

    expect(await aceptarNumero(QUIEN)).toBe("esperar");

    expect(h.ejecutadas).toEqual([]);
    sinGraph();
  });

  it("el cupo de seguir no se cobra dos veces en el camino de un vínculo", async () => {
    await vincularWaba(QUIEN, PEDIDO);

    expect(clavesTomadas()).not.toContain(claveDeCupo("wa:es:seguir", TENANT));
  });
});

describe("continuarWaba: retomar", () => {
  const almacen = () => almacenDelInquilino(QUIEN);

  it("una vuelta se retoma sin volver a canjear ni a revisar el token", async () => {
    lecturas(vinculada({ estado: "suscripta", nombreEstado: "APPROVED" }));

    expect(await continuarWaba(TENANT, almacen())).toBe("conectado");

    expect(h.canjear).not.toHaveBeenCalled();
    expect(h.revisar).not.toHaveBeenCalled();
    expect(h.suscribir).toHaveBeenCalledWith(TOKEN, WABA);
    // Ya estaba «suscripta» y el nombre no cambió: no se reescribe.
    expect(pasosEscritos()).toEqual(["conectar", "estado"]);
  });

  it("desde «vinculada» anota «suscripta» con el estado del nombre que Meta informó", async () => {
    lecturas(vinculada());

    await continuarWaba(TENANT, almacen());

    expect(datosDe("estado")).toEqual({ estado: "suscripta", nombre_estado: "APPROVED" });
  });

  it("un estado del nombre con forma rara no se guarda", async () => {
    h.datos.mockResolvedValue(datosDelNumero({ nombreEstado: "rm -rf /" }));
    lecturas(vinculada());

    await continuarWaba(TENANT, almacen());

    expect(datosDe("estado")).toEqual({ estado: "suscripta" });
  });

  it("sin fila: «apagado»", async () => {
    h.leer.mockReset();
    h.leer.mockResolvedValue([]);

    expect(await continuarWaba(TENANT, almacen())).toBe("apagado");
  });

  it.each([
    ["una WABA ya conectada", vinculada({ estado: "conectada", numeroEstado: "conectado" }), "conectado"],
    ["un número ya conectado por el camino viejo (sin token de esta WABA)", vinculada({ numeroEstado: "conectado", tokenCifrado: null }), "conectado"],
    ["un número suspendido con su token: el operador lo frenó y no vuelve por acá", vinculada({ numeroEstado: "suspendido" }), "conectado"],
    ["sin token", vinculada({ tokenCifrado: null }), "vencido"],
    ["con un token que no abre (otra clave u otra fila)", vinculada({ tokenCifrado: cifrar(TOKEN, "wa:otro:200000000000001") }), "vencido"],
    ["con el token de otra WABA", vinculada({ wabaDelNumero: "200000000000002" }), "vencido"],
    ["sin número", vinculada({ phoneNumberId: null }), "vencido"],
    ["cancelada", vinculada({ estado: "cancelada" }), "vencido"],
    ["revocada", vinculada({ estado: "revocada" }), "vencido"],
    ["sin WABA", filaDb(), "vencido"],
    ["con la WABA de la plataforma", vinculada({ wabaId: WABA_PLATAFORMA, wabaDelNumero: WABA_PLATAFORMA, tokenCifrado: cifrar(TOKEN, aadToken(WABA_PLATAFORMA)) }), "de_la_plataforma"],
    ["con el número de la plataforma", vinculada({ phoneNumberId: ID_PLATAFORMA }), "de_la_plataforma"],
  ])("%s: «%s»", async (_nombre, fila, esperado) => {
    lecturas(fila);

    expect(await continuarWaba(TENANT, almacen())).toBe(esperado);

    sinGraph();
  });

  it.each([
    ["en falla", "falla"],
    ["a medias", "vinculada"],
    ["sin el código", "falta_codigo"],
  ])("una WABA propia %s con su número todavía vivo y su token sigue: es la reconexión, no un espacio ya conectado", async (_nombre, estado) => {
    lecturas(vinculada({ estado, falla: estado === "falla" ? "token_vencido" : null, numeroEstado: "conectado", nombreEstado: "APPROVED" }));

    expect(await continuarWaba(TENANT, almacen())).toBe("conectado");

    expect(h.suscribir).toHaveBeenCalledWith(TOKEN, WABA);
    expect(pasosEscritos()).toContain("conectar");
  });

  it("un token que no abre se anota por el nombre del error, nunca por el sobre", async () => {
    lecturas(vinculada({ tokenCifrado: cifrar(TOKEN, "wa:otro:200000000000001") }));

    await continuarWaba(TENANT, almacen());

    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "alta.waba_descifrado_fallo");
  });

  it("sin la 0051 (columna que falta) no hay nada que seguir", async () => {
    h.leer.mockReset();
    h.leer.mockRejectedValue(errorPg("42703"));

    expect(await continuarWaba(TENANT, almacen())).toBe("apagado");
  });

  it("sin el número de la plataforma o el webhook del ambiente cargados, se mira a mano antes de Graph", async () => {
    h.webhook.mockReturnValue(null);
    lecturas(vinculada());

    expect(await continuarWaba(TENANT, almacen())).toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("sin_credencial", TENANT);
    expect(h.suscribir).not.toHaveBeenCalled();
  });

  it("nunca tira: una falla inesperada se anota por nombre y vuelve «meta»", async () => {
    h.leer.mockReset();
    h.leer.mockRejectedValue(new RangeError("no pasa"));

    expect(await continuarWaba(TENANT, almacen())).toBe("meta");

    expect(h.error).toHaveBeenCalledWith({ error: "RangeError", donde: "continuar" }, "alta.waba_fallo");
  });
});

describe("continuarWaba: cada paso", () => {
  const almacen = () => almacenDelInquilino(QUIEN);
  beforeEach(() => lecturas(vinculada({ estado: "suscripta", nombreEstado: "APPROVED" })));

  it("la suscripción rechazada: se mira a mano, con la causa anotada", async () => {
    h.suscribir.mockResolvedValue(falla("rechazo", 100));

    expect(await continuarWaba(TENANT, almacen())).toBe("revision");

    expect(datosDe("estado")).toEqual({ estado: "falla", falla: "suscripcion" });
    expect(h.aviso).toHaveBeenCalledWith("suscripcion", TENANT);
    expect(h.registrar).not.toHaveBeenCalled();
  });

  it("la suscripción con un token muerto (190): el cliente tiene que volver a conectar", async () => {
    h.suscribir.mockResolvedValue(falla("rechazo", 190));

    expect(await continuarWaba(TENANT, almacen())).toBe("revision");

    expect(datosDe("estado")).toEqual({ estado: "falla", falla: "token_vencido" });
    expect(h.aviso).toHaveBeenCalledWith("token_vencido", TENANT);
  });

  it("la WABA sin medio de pago (131042) se avisa, sin cambiar su estado", async () => {
    h.suscribir.mockResolvedValue(falla("rechazo", 131042));

    expect(await continuarWaba(TENANT, almacen())).toBe("revision");

    expect(h.aviso).toHaveBeenCalledWith("pago_pendiente", TENANT);
    expect(pasosEscritos()).toEqual([]);
  });

  it("Meta pide esperar o devuelve algo raro: tal cual, sin anotar una causa", async () => {
    h.suscribir.mockResolvedValue(falla("esperar"));
    expect(await continuarWaba(TENANT, almacen())).toBe("esperar");

    lecturas(vinculada({ estado: "suscripta", nombreEstado: "APPROVED" }));
    h.suscribir.mockResolvedValue(falla("meta"));
    expect(await continuarWaba(TENANT, almacen())).toBe("meta");

    expect(pasosEscritos()).toEqual([]);
  });

  it("un nombre que Meta rechazó (DECLINED) se anota y se mira a mano, sin registrar", async () => {
    h.datos.mockResolvedValue(datosDelNumero({ nombreEstado: "DECLINED" }));

    expect(await continuarWaba(TENANT, almacen())).toBe("revision");

    expect(datosDe("estado")).toEqual({ estado: "falla", falla: "nombre_rechazado", nombre_estado: "DECLINED" });
    expect(h.aviso).toHaveBeenCalledWith("nombre_rechazado", TENANT);
    expect(h.registrar).not.toHaveBeenCalled();
  });

  it("un número que sigue en la app (coexistencia) se detecta también al retomar", async () => {
    h.datos.mockResolvedValue(datosDelNumero({ enLaApp: true }));

    expect(await continuarWaba(TENANT, almacen())).toBe("coexistencia");

    expect(datosDe("estado")).toEqual({ estado: "falla", falla: "coexistencia" });
    expect(h.registrar).not.toHaveBeenCalled();
  });

  it("sin el código verificado, la persona tiene que pedirlo: se anota «falta_codigo» y no se registra", async () => {
    h.datos.mockResolvedValue(datosDelNumero({ verificado: false }));

    expect(await continuarWaba(TENANT, almacen())).toBe("falta_codigo");

    expect(datosDe("estado")).toEqual({ estado: "falta_codigo", nombre_estado: "APPROVED" });
    expect(h.registrar).not.toHaveBeenCalled();
    expect(h.fijarWebhook).not.toHaveBeenCalled();
  });

  it("un número ya registrado no necesita el código: la verificación vence aunque el registro siga activo", async () => {
    h.datos.mockResolvedValue(datosDelNumero({ verificado: false }));
    h.yaRegistrado.mockResolvedValue(ok(true));

    expect(await continuarWaba(TENANT, almacen())).toBe("conectado");

    expect(pasosEscritos()).not.toContain("falta_codigo");
    expect(h.registrar).not.toHaveBeenCalled();
  });

  it("el estado se anota una sola vez por vuelta, con el nombre que Meta informó", async () => {
    lecturas(vinculada({ estado: "vinculada" }));

    await continuarWaba(TENANT, almacen());

    // Hasta conectar, un solo asiento (el otro «estado» es el de la plantilla, ya conectado).
    expect(pasosEscritos().slice(0, pasosEscritos().indexOf("conectar"))).toEqual(["estado"]);
    expect(datosDe("estado")).toEqual({ estado: "suscripta", nombre_estado: "APPROVED" });
  });

  it.each([
    ["transicion", "esperar"],
    ["no_aplica", "revision"],
  ] as const)("si la base no deja anotar el estado (%s), no se registra ni se conecta: «%s»", async (guardado, esperado) => {
    lecturas(vinculada({ estado: "vinculada" }));
    guardaSegun({ estado: guardado });

    expect(await continuarWaba(TENANT, almacen())).toBe(esperado);

    expect(h.registrar).not.toHaveBeenCalled();
    expect(h.fijarWebhook).not.toHaveBeenCalled();
    expect(pasosEscritos()).not.toContain("conectar");
  });

  it("si la base no deja anotar «falta_pin», tampoco se sigue", async () => {
    h.registrar.mockResolvedValue(falla("rechazo", 133005));
    guardaSegun({ estado: "transicion" });
    lecturas(vinculada({ estado: "suscripta", nombreEstado: "APPROVED" }));

    expect(await continuarWaba(TENANT, almacen())).toBe("esperar");

    expect(pasosEscritos()).not.toContain("conectar");
  });

  it("un número que ya está registrado no se registra de nuevo: ni se toma el cupo de registros", async () => {
    h.yaRegistrado.mockResolvedValue(ok(true));

    expect(await continuarWaba(TENANT, almacen())).toBe("conectado");

    expect(h.registrar).not.toHaveBeenCalled();
    expect(clavesTomadas()).toEqual([]);
  });

  it("registra con el PIN guardado y toma el cupo de tres registros por día", async () => {
    await continuarWaba(TENANT, almacen());

    expect(h.registrar).toHaveBeenCalledWith(CRED, ID, PIN);
    expect(h.rateLimit).toHaveBeenCalledWith(claveDeCupo("wa:registrar", TENANT), { limit: 3, windowMs: DIA_MS, fallaCerrada: true });
  });

  it("sin cupo de registros: «esperar», sin llamar a Graph", async () => {
    contadorRechaza("wa:registrar");

    expect(await continuarWaba(TENANT, almacen())).toBe("esperar");

    expect(h.registrar).not.toHaveBeenCalled();
  });

  it("sin PIN guardado no se puede registrar: hay que volver a conectar", async () => {
    lecturas(vinculada({ estado: "suscripta", nombreEstado: "APPROVED", pinCifrado: null }));

    expect(await continuarWaba(TENANT, almacen())).toBe("vencido");

    expect(h.registrar).not.toHaveBeenCalled();
  });

  it("el número ya tenía verificación en dos pasos propia (133005): la persona pone su PIN", async () => {
    h.registrar.mockResolvedValue(falla("rechazo", 133005));

    expect(await continuarWaba(TENANT, almacen())).toBe("falta_pin");

    expect(datosDe("estado")).toEqual({ estado: "falta_pin" });
    expect(h.aviso).not.toHaveBeenCalled();
    expect(h.fijarWebhook).not.toHaveBeenCalled();
  });

  it("pidiendo el PIN, «Reintentar» no registra con el PIN al azar que Meta ya rechazó: sigue «falta_pin» y no gasta cupo", async () => {
    lecturas(vinculada({ estado: "falta_pin", nombreEstado: "APPROVED" }));

    expect(await continuarWaba(TENANT, almacen())).toBe("falta_pin");

    expect(h.registrar).not.toHaveBeenCalled();
    expect(clavesTomadas()).toEqual([]);
    expect(pasosEscritos()).not.toContain("conectar");
  });

  it("otro rechazo al registrar: se mira a mano, con la causa anotada", async () => {
    h.registrar.mockResolvedValue(falla("rechazo", 100));

    expect(await continuarWaba(TENANT, almacen())).toBe("revision");

    expect(datosDe("estado")).toEqual({ estado: "falla", falla: "registro" });
    expect(h.aviso).toHaveBeenCalledWith("registro", TENANT);
  });

  it("el estado del registro que Graph no contesta: «meta», sin registrar a ciegas", async () => {
    h.yaRegistrado.mockResolvedValue(falla("meta"));

    expect(await continuarWaba(TENANT, almacen())).toBe("meta");

    expect(h.registrar).not.toHaveBeenCalled();
  });

  it("sin el webhook propio puesto y leído de vuelta, no se conecta: «revision» con la causa anotada", async () => {
    h.leerWebhook.mockResolvedValue(ok(false));

    expect(await continuarWaba(TENANT, almacen())).toBe("revision");

    expect(datosDe("estado")).toEqual({ estado: "falla", falla: "webhook" });
    expect(h.aviso).toHaveBeenCalledWith("sin_webhook", TENANT);
    expect(pasosEscritos()).not.toContain("conectar");
  });

  it("si Graph no deja poner el webhook, tal cual: «esperar», sin anotar una causa", async () => {
    h.fijarWebhook.mockResolvedValue(falla("esperar"));

    expect(await continuarWaba(TENANT, almacen())).toBe("esperar");

    expect(pasosEscritos()).not.toContain("conectar");
    expect(pasosEscritos()).not.toContain("estado");
  });

  it.each([
    ["numero_ocupado", "numero_ocupado"],
    ["no_aplica", "revision"],
    ["ya_conectado", "conectado"],
    ["transicion", "esperar"],
  ] as const)("al conectar la base dice %s: «%s»", async (guardado, esperado) => {
    guardaSegun({ conectar: guardado });

    expect(await continuarWaba(TENANT, almacen())).toBe(esperado);

    expect(h.plantilla).not.toHaveBeenCalled();
  });

  it("al conectar crea la plantilla en la WABA del cliente, ya con el número andando, y anota que se envió", async () => {
    expect(await continuarWaba(TENANT, almacen())).toBe("conectado");

    await vi.waitFor(() => expect(pasosEscritos()).toEqual(["conectar", "estado"]));
    expect(h.plantilla).toHaveBeenCalledWith(TOKEN, WABA);
    const estado = datosDe("estado")!;
    expect(estado.estado).toBe("conectada");
    expect(new Date(estado.plantilla_enviada_en as string).toISOString()).toBe(estado.plantilla_enviada_en);
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("si la plantilla falla, el número queda conectado y se avisa al operador", async () => {
    h.plantilla.mockResolvedValue(falla("rechazo", 100));

    expect(await continuarWaba(TENANT, almacen())).toBe("conectado");

    await vi.waitFor(() => expect(h.aviso).toHaveBeenCalledWith("plantilla", TENANT));
    expect(pasosEscritos()).toEqual(["conectar"]);
  });

  it("si la plantilla tira, también se avisa y no se pierde el resultado", async () => {
    h.plantilla.mockRejectedValue(new TypeError("sin red"));

    expect(await continuarWaba(TENANT, almacen())).toBe("conectado");

    await vi.waitFor(() => expect(h.aviso).toHaveBeenCalledWith("plantilla", TENANT));
  });

  it("si la plantilla ya se envió (un reintento), no se crea otra", async () => {
    lecturas(vinculada({ estado: "suscripta", nombreEstado: "APPROVED", plantilla: "2026-10-01T12:00:00.000Z" }));

    expect(await continuarWaba(TENANT, almacen())).toBe("conectado");

    expect(h.plantilla).not.toHaveBeenCalled();
  });

  it("nada de lo que se devuelve o se anota lleva el token ni el PIN", async () => {
    const r = await continuarWaba(TENANT, almacen());

    expect(r).toBe("conectado");
    for (const secreto of [TOKEN, PIN]) {
      expect(registro()).not.toContain(secreto);
      expect(JSON.stringify(escrito())).not.toContain(secreto);
    }
  });
});

describe("codigoWaba", () => {
  beforeEach(() => lecturas(vinculada({ estado: "falta_codigo" })));

  it.each(["SMS", "VOICE"] as const)("%s: pide el código a Meta con los tres cupos del número, en el idioma de la persona", async (metodo) => {
    expect(await codigoWaba({ ...QUIEN, idioma: "en-US" }, { accion: metodo })).toBe("codigo_enviado");

    expect(h.pedirAMeta).toHaveBeenCalledWith(CRED, ID, metodo, "en-US");
    expect(clavesTomadas()).toEqual([claveDeCupo("wa:codigo", TENANT), claveDeCupo("wa:codigo-ip", IP), claveDeCupo("wa:codigos")]);
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("sin IP válida, el cupo por red cuenta como «sin-ip»", async () => {
    await codigoWaba({ ...QUIEN, ip: null }, { accion: "SMS" });

    expect(clavesTomadas()[1]).toBe(claveDeCupo("wa:codigo-ip", "sin-ip"));
  });

  it("sin cupo: «esperar», sin tocar la base ni Graph", async () => {
    contadorRechaza("wa:codigo:");

    expect(await codigoWaba(QUIEN, { accion: "SMS" })).toBe("esperar");

    expect(h.leer).not.toHaveBeenCalled();
    expect(h.pedirAMeta).not.toHaveBeenCalled();
  });

  it("si no hay nada que seguir (sin token), «vencido» y los tres cupos vuelven", async () => {
    lecturas(vinculada({ tokenCifrado: null }));

    expect(await codigoWaba(QUIEN, { accion: "SMS" })).toBe("vencido");

    expect(clavesLiberadas()).toHaveLength(3);
    expect(h.pedirAMeta).not.toHaveBeenCalled();
  });

  it("si Meta rechaza el pedido, se mira a mano con la causa del registro; el cupo queda gastado", async () => {
    h.pedirAMeta.mockResolvedValue(falla("rechazo", 100));

    expect(await codigoWaba(QUIEN, { accion: "SMS" })).toBe("revision");

    expect(datosDe("estado")).toEqual({ estado: "falla", falla: "registro" });
    expect(h.liberarCupo).not.toHaveBeenCalled();
  });

  it("si Meta pide esperar, «esperar»", async () => {
    h.pedirAMeta.mockResolvedValue(falla("esperar"));

    expect(await codigoWaba(QUIEN, { accion: "SMS" })).toBe("esperar");
  });

  describe("verificar", () => {
    it.each(["12345", "1234567", "12 3456", "abcdef", ""])("«%s» no tiene seis dígitos: «codigo_incorrecto», sin tomar cupo ni llamar a Graph", async (codigo) => {
      expect(await codigoWaba(QUIEN, { accion: "verificar", codigo })).toBe("codigo_incorrecto");

      expect(h.rateLimit).not.toHaveBeenCalled();
      expect(h.verificarEnMeta).not.toHaveBeenCalled();
    });

    it("un código bueno se entrega a Meta (cinco por hora y por espacio) y se sigue hasta conectar", async () => {
      lecturas(vinculada({ estado: "falta_codigo" }));

      expect(await codigoWaba(QUIEN, { accion: "verificar", codigo: "123456" })).toBe("conectado");

      expect(h.verificarEnMeta).toHaveBeenCalledWith(CRED, ID, "123456");
      expect(h.rateLimit).toHaveBeenCalledWith(claveDeCupo("wa:verificar", TENANT), { limit: 5, windowMs: HORA_MS, fallaCerrada: true });
      expect(registro()).not.toContain("123456");
    });

    it("Meta rechaza el código y el número no figura verificado: «codigo_incorrecto»", async () => {
      h.verificarEnMeta.mockResolvedValue(falla("rechazo", 100));
      h.yaVerificado.mockResolvedValue(ok(false));

      expect(await codigoWaba(QUIEN, { accion: "verificar", codigo: "123456" })).toBe("codigo_incorrecto");

      expect(h.suscribir).not.toHaveBeenCalled();
      expect(pasosEscritos()).toEqual([]);
    });

    it("Meta rechaza un código que ya había aceptado (un intento que se cortó): si figura verificado, se sigue", async () => {
      h.verificarEnMeta.mockResolvedValue(falla("rechazo", 100));
      h.yaVerificado.mockResolvedValue(ok(true));

      expect(await codigoWaba(QUIEN, { accion: "verificar", codigo: "123456" })).toBe("conectado");
    });

    it("Meta pide esperar al verificar: «esperar», sin mirar si ya estaba verificado", async () => {
      h.verificarEnMeta.mockResolvedValue(falla("esperar"));

      expect(await codigoWaba(QUIEN, { accion: "verificar", codigo: "123456" })).toBe("esperar");

      expect(h.yaVerificado).not.toHaveBeenCalled();
    });
  });
});

describe("pinWaba", () => {
  const PIN_NUEVO = "135790";
  beforeEach(() => lecturas(vinculada({ estado: "falta_pin" })));

  it.each(["12345", "1234567", "abcdef", "12 3456", ""])("«%s» no tiene seis dígitos: «pin_incorrecto», sin tocar nada", async (pin) => {
    expect(await pinWaba(QUIEN, pin)).toBe("pin_incorrecto");

    expect(h.leer).not.toHaveBeenCalled();
    expect(h.registrar).not.toHaveBeenCalled();
  });

  it("un PIN bueno se prueba contra el registro, se guarda cifrado como el PIN de ahí en más y se sigue", async () => {
    // La base ya dejó el número en «suscripta» cuando `continuarWaba` vuelve a leer.
    lecturas(vinculada({ estado: "falta_pin" }), vinculada({ estado: "suscripta", nombreEstado: "APPROVED" }));

    expect(await pinWaba(QUIEN, PIN_NUEVO)).toBe("conectado");

    expect(h.registrar).toHaveBeenCalledWith(CRED, ID, PIN_NUEVO);
    const estado = datosDe("estado")!;
    expect(estado.estado).toBe("suscripta");
    expect(descifrar(estado.pin_cifrado as string, undefined, aadPin())).toBe(PIN_NUEVO);
    expect(() => descifrar(estado.pin_cifrado as string, undefined, aadToken())).toThrow();
    expect(clavesTomadas()).toContain(claveDeCupo("wa:registrar", TENANT));
  });

  it("el PIN nunca aparece en un resultado, en una escritura ni en el registro", async () => {
    const r = await pinWaba(QUIEN, PIN_NUEVO);

    expect(JSON.stringify(r)).not.toContain(PIN_NUEVO);
    expect(JSON.stringify(escrito())).not.toContain(PIN_NUEVO);
    expect(registro()).not.toContain(PIN_NUEVO);
  });

  it("un PIN que Meta no acepta (133005): «pin_incorrecto» y no se guarda", async () => {
    h.registrar.mockResolvedValue(falla("rechazo", 133005));

    expect(await pinWaba(QUIEN, PIN_NUEVO)).toBe("pin_incorrecto");

    expect(pasosEscritos()).toEqual([]);
    expect(registro()).not.toContain(PIN_NUEVO);
  });

  it.each([133008, 133009])("demasiados intentos de PIN (%i): «esperar», sin dejar la WABA en falla ni avisar", async (codigo) => {
    h.registrar.mockResolvedValue(falla("rechazo", codigo));

    expect(await pinWaba(QUIEN, PIN_NUEVO)).toBe("esperar");

    expect(pasosEscritos()).toEqual([]);
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("otro rechazo: se mira a mano, con la causa anotada", async () => {
    h.registrar.mockResolvedValue(falla("rechazo", 100));

    expect(await pinWaba(QUIEN, PIN_NUEVO)).toBe("revision");

    expect(datosDe("estado")).toEqual({ estado: "falla", falla: "registro" });
    expect(h.aviso).toHaveBeenCalledWith("registro", TENANT);
  });

  it("si no está pidiendo PIN (otra pestaña ya lo resolvió): «esperar», sin gastar un registro", async () => {
    lecturas(vinculada({ estado: "suscripta", nombreEstado: "APPROVED" }));

    expect(await pinWaba(QUIEN, PIN_NUEVO)).toBe("esperar");

    expect(h.registrar).not.toHaveBeenCalled();
    expect(h.rateLimit).not.toHaveBeenCalled();
  });

  it("sin cupo de registros: «esperar»", async () => {
    contadorRechaza("wa:registrar");

    expect(await pinWaba(QUIEN, PIN_NUEVO)).toBe("esperar");

    expect(h.registrar).not.toHaveBeenCalled();
  });

  it("sin token: «vencido»", async () => {
    lecturas(vinculada({ estado: "falta_pin", tokenCifrado: null }));

    expect(await pinWaba(QUIEN, PIN_NUEVO)).toBe("vencido");
  });
});

describe("cancelarWaba", () => {
  it("anota el paso en que se cerró el popup, sólo de la lista", async () => {
    expect(await cancelarWaba(QUIEN, "PERMISSIONS")).toBe("cancelado");

    expect(escrito()).toEqual([{ paso: "cancelar", datos: { paso: "permissions" } }]);
  });

  it.each([["paso inventado"], [undefined], [null], [{ paso: "permissions" }], ["x'; drop table whatsapp_wabas; --"]])("%j es «otro»", async (paso) => {
    await cancelarWaba(QUIEN, paso);

    expect(datosDe("cancelar")).toEqual({ paso: "otro" });
  });

  it("del código de error sólo se anota un entero; un texto del navegador no entra al registro", async () => {
    await cancelarWaba(QUIEN, "permissions", 4);
    await cancelarWaba(QUIEN, "permissions", "mensaje que escribió el navegador" as unknown as number);
    await cancelarWaba(QUIEN, "permissions", 1.5);

    const anotados = h.info.mock.calls.filter(([, mensaje]) => mensaje === "alta.waba_cancelada").map(([datos]) => (datos as { codigo: unknown }).codigo);
    expect(anotados).toEqual([4, null, null]);
    expect(registro()).not.toContain("mensaje que escribió");
  });

  it("si la base no deja anotarlo igual contesta «cancelado»: no hay nada que la persona pueda hacer", async () => {
    guardaSegun({ cancelar: "transicion" });
    expect(await cancelarWaba(QUIEN, "permissions")).toBe("cancelado");

    guardaSegun({ cancelar: errorPg("XX000") });
    expect(await cancelarWaba(QUIEN, "permissions")).toBe("cancelado");
  });

  it("no toca Graph ni toma cupo", async () => {
    await cancelarWaba(QUIEN, "permissions");

    sinGraph();
    expect(h.rateLimit).not.toHaveBeenCalled();
  });
});

describe("desconectarWaba", () => {
  beforeEach(() => {
    lecturas(vinculada({ estado: "conectada", numeroEstado: "conectado" }));
    // Un número conectado está registrado en Meta.
    h.yaRegistrado.mockResolvedValue(ok(true));
  });

  it("la base suelta el token y, después de contestar, se da de baja el número y se saca la app con el token que se leyó antes de borrarlo", async () => {
    expect(await desconectarWaba(QUIEN)).toBe("desconectado");

    await vi.waitFor(() => expect(h.desuscribir).toHaveBeenCalledWith(TOKEN, WABA));
    expect(h.baja).toHaveBeenCalledWith(TOKEN, ID);
    expect(pasosEscritos()).toEqual(["desconectar"]);
    expect(h.espejar).toHaveBeenCalledTimes(1);
    expect(h.aviso).not.toHaveBeenCalled();
    expect(registro()).not.toContain(TOKEN);
  });

  it("un número que la base tiene como «pedido» pero Meta ya tiene registrado también se da de baja", async () => {
    lecturas(vinculada({ estado: "suscripta", nombreEstado: "APPROVED", numeroEstado: "pedido" }));

    await desconectarWaba(QUIEN);

    await vi.waitFor(() => expect(h.desuscribir).toHaveBeenCalledWith(TOKEN, WABA));
    expect(h.yaRegistrado).toHaveBeenCalledWith(CRED, ID);
    expect(h.baja).toHaveBeenCalledWith(TOKEN, ID);
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("un número que nunca se registró no se da de baja: sólo se saca la app, y no es una WABA huérfana", async () => {
    lecturas(vinculada({ estado: "suscripta", nombreEstado: "APPROVED", numeroEstado: "pedido" }));
    h.yaRegistrado.mockResolvedValue(ok(false));
    h.baja.mockResolvedValue(falla("rechazo", 133010));

    await desconectarWaba(QUIEN);

    await vi.waitFor(() => expect(h.desuscribir).toHaveBeenCalledWith(TOKEN, WABA));
    expect(h.baja).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("si Meta no dice si el número está registrado, se intenta la baja igual y la falla se avisa", async () => {
    lecturas(vinculada({ estado: "suscripta", nombreEstado: "APPROVED", numeroEstado: "pedido" }));
    h.yaRegistrado.mockResolvedValue(falla("meta"));

    await desconectarWaba(QUIEN);

    await vi.waitFor(() => expect(h.baja).toHaveBeenCalledWith(TOKEN, ID));
    await vi.waitFor(() => expect(h.aviso).toHaveBeenCalledWith("waba_huerfana", TENANT));
  });

  it("una WABA sin número (no hay nada que dar de baja) sólo saca la app", async () => {
    lecturas(vinculada({ estado: "vinculada", phoneNumberId: null, numeroEstado: null }));

    await desconectarWaba(QUIEN);

    await vi.waitFor(() => expect(h.desuscribir).toHaveBeenCalledWith(TOKEN, WABA));
    expect(h.yaRegistrado).not.toHaveBeenCalled();
    expect(h.baja).not.toHaveBeenCalled();
  });

  it("si Meta no deja soltarla, hay una WABA vinculada que la base ya no tiene: se avisa al operador", async () => {
    h.baja.mockResolvedValue(falla("meta"));

    expect(await desconectarWaba(QUIEN)).toBe("desconectado");

    await vi.waitFor(() => expect(h.aviso).toHaveBeenCalledWith("waba_huerfana", TENANT));
  });

  it("si el token ya estaba muerto (190: el cliente sacó la app él mismo) no es una WABA huérfana", async () => {
    h.baja.mockResolvedValue(falla("rechazo", 190));
    h.desuscribir.mockResolvedValue(falla("rechazo", 190));

    expect(await desconectarWaba(QUIEN)).toBe("desconectado");

    await vi.waitFor(() => expect(h.desuscribir).toHaveBeenCalled());
    await vi.waitFor(() => expect(h.warn).toHaveBeenCalledWith(expect.anything(), "alta.waba_desvinculacion_incompleta"));
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("si una de las llamadas a Meta tira, también se avisa", async () => {
    h.baja.mockRejectedValue(new TypeError("sin red"));

    expect(await desconectarWaba(QUIEN)).toBe("desconectado");

    await vi.waitFor(() => expect(h.aviso).toHaveBeenCalledWith("waba_huerfana", TENANT));
  });

  it("repetirlo con todo ya desconectado vuelve «desconectado»", async () => {
    lecturas(filaDb({ numeroEstado: null }));
    guardaSegun({ desconectar: "transicion" });

    expect(await desconectarWaba(QUIEN)).toBe("desconectado");

    expect(h.desuscribir).not.toHaveBeenCalled();
  });

  it("la WABA revocada también", async () => {
    lecturas(vinculada({ estado: "revocada", tokenCifrado: null, numeroEstado: null }));
    guardaSegun({ desconectar: "transicion" });

    expect(await desconectarWaba(QUIEN)).toBe("desconectado");
  });

  it.each([
    ["transicion", "meta"],
    ["no_aplica", "meta"],
    ["de_la_plataforma", "meta"],
  ] as const)("la base dice %s con una conexión viva: «%s», sin tocar Meta", async (guardado, esperado) => {
    guardaSegun({ desconectar: guardado });

    expect(await desconectarWaba(QUIEN)).toBe(esperado);

    expect(h.baja).not.toHaveBeenCalled();
    expect(h.desuscribir).not.toHaveBeenCalled();
  });

  it("sin fila: «meta»", async () => {
    h.leer.mockReset();
    h.leer.mockResolvedValue([]);

    expect(await desconectarWaba(QUIEN)).toBe("meta");

    expect(h.ejecutadas).toHaveLength(0);
  });
});

describe("el almacén", () => {
  it("lee con una sola consulta, desde el espacio, y escribe con el espacio, el usuario, la IP y lo de la plataforma", async () => {
    lecturas(vinculada());

    const fila = await almacenDelInquilino(QUIEN).leer();
    await almacenDelInquilino(QUIEN).guardar("aceptar_numero", {});

    expect(h.leer).toHaveBeenCalledTimes(1);
    expect(h.enControl).toHaveBeenCalledWith({ tenantId: TENANT });
    expect(fila).toMatchObject({ estado: "vinculada", wabaId: WABA, phoneNumberId: ID, token: TOKEN, pin: PIN, numeroAceptado: false, plantillaEnviadaEn: null });
    expect(valoresDe(h.ejecutadas[0])).toEqual([TENANT, USUARIO, "aceptar_numero", "{}", WABA_PLATAFORMA, ID_PLATAFORMA, APP_DE_LA_PLATAFORMA, IP]);
  });

  it("una fecha de plantilla enviada se lee como fecha", async () => {
    lecturas(vinculada({ plantilla: "2026-10-01T12:00:00.000Z" }));

    const fila = await almacenDelInquilino(QUIEN).leer();

    expect(fila?.plantillaEnviadaEn).toEqual(new Date("2026-10-01T12:00:00.000Z"));
  });

  it("espeja la base del cliente sólo cuando el paso cambió el número y salió bien", async () => {
    const almacen = almacenDelInquilino(QUIEN);

    await almacen.guardar("estado", { estado: "suscripta" });
    await almacen.guardar("cancelar", { paso: "otro" });
    expect(h.espejar).not.toHaveBeenCalled();

    for (const paso of ["vincular", "conectar", "desconectar"]) await almacen.guardar(paso, {});
    expect(h.espejar).toHaveBeenCalledTimes(3);

    guardaSegun({ vincular: "cupo" });
    await almacen.guardar("vincular", {});
    expect(h.espejar).toHaveBeenCalledTimes(3);
  });
});

describe("con la app propia del cliente: qué es un rechazo de Graph", () => {
  const APP_ID = "500000000000001";
  const SECRETO = "fake-app-secret-del-cliente";
  const PRUEBA = pruebaDelSecreto(TOKEN, SECRETO);
  const CRED_APP = { ...CRED, prueba: PRUEBA };
  const almacen = () => almacenDelInquilino(QUIEN);
  /** Una fila de la app propia con el webhook ya verificado y el nombre aprobado, lista para seguir. */
  const deApp = (extra: Record<string, unknown> = {}) =>
    vinculada({
      estado: "suscripta",
      nombreEstado: "APPROVED",
      origenDeWaba: "app_propia",
      appId: APP_ID,
      secretoCifrado: cerrarSecreto(SECRETO, TENANT, APP_ID),
      ruta: "ruta-de-prueba-0001",
      webhookVerificadoEn: "2026-10-01T12:00:00.000Z",
      ...extra,
    });
  const secretoRotado = () => h.leerApp.mockResolvedValue(falla("rechazo", 190));

  beforeEach(() => {
    Object.assign(process.env, APP_PRENDIDA);
    lecturas(deApp());
  });

  it("la prueba firmada con el secreto sale en cada llamada", async () => {
    await continuarWaba(TENANT, almacen());

    expect(h.suscribir).toHaveBeenCalledWith(TOKEN, WABA, PRUEBA);
  });

  describe("el perfil del número", () => {
    it("lleva el rubro que eligió el cliente, no uno fijo", async () => {
      lecturas(deApp({ categoria: "HEALTH" }));

      expect(await continuarWaba(TENANT, almacen())).toBe("conectado");

      expect(h.perfil).toHaveBeenCalledWith(CRED_APP, ID, expect.objectContaining({ vertical: "HEALTH" }));
    });

    it("sin rubro elegido sale el inicial", async () => {
      expect(await continuarWaba(TENANT, almacen())).toBe("conectado");

      expect(h.perfil).toHaveBeenCalledWith(CRED_APP, ID, expect.objectContaining({ vertical: CATEGORIA_INICIAL }));
    });

    it("un rubro que no es de la lista de Meta se descarta y sale el inicial", async () => {
      lecturas(deApp({ categoria: "health" }));

      await continuarWaba(TENANT, almacen());

      expect(h.perfil).toHaveBeenCalledWith(CRED_APP, ID, expect.objectContaining({ vertical: CATEGORIA_INICIAL }));
    });
  });

  describe("el 100, que también es el de un appsecret_proof inválido", () => {
    it("con el secreto rotado: la app ya no lo acepta, se anota secreto_invalido y se pide cargarlo de nuevo (E7)", async () => {
      h.suscribir.mockResolvedValue(falla("rechazo", 100));
      secretoRotado();

      expect(await continuarWaba(TENANT, almacen())).toBe("app_invalida");

      expect(datosDe("estado")).toEqual({ estado: "falla", falla: "secreto_invalido" });
      expect(h.aviso).toHaveBeenCalledWith("secreto_invalido", TENANT);
      expect(h.leerApp).toHaveBeenCalledWith({ appId: APP_ID, secreto: SECRETO }, expect.any(String));
    });

    it("con la app sana el 100 es de la WABA: waba_invalida, sin anotar nada", async () => {
      h.suscribir.mockResolvedValue(falla("rechazo", 100));

      expect(await continuarWaba(TENANT, almacen())).toBe("waba_invalida");

      expect(pasosEscritos()).toEqual([]);
      expect(h.aviso).not.toHaveBeenCalled();
    });

    it("si Meta no contesta la pregunta de la app no se adivina: queda waba_invalida y no se anota el secreto", async () => {
      h.suscribir.mockResolvedValue(falla("rechazo", 100));
      h.leerApp.mockResolvedValue(falla("meta"));

      expect(await continuarWaba(TENANT, almacen())).toBe("waba_invalida");

      expect(pasosEscritos()).toEqual([]);
    });

    it("al leer el número (antes caía en «meta» y se mandaba a mano): secreto_invalido", async () => {
      h.datos.mockResolvedValue(falla("rechazo", 100));
      secretoRotado();

      expect(await continuarWaba(TENANT, almacen())).toBe("app_invalida");

      expect(datosDe("estado")).toEqual({ estado: "falla", falla: "secreto_invalido" });
    });

    it("al registrar el número: secreto_invalido", async () => {
      h.registrar.mockResolvedValue(falla("rechazo", 100));
      secretoRotado();

      expect(await continuarWaba(TENANT, almacen())).toBe("app_invalida");

      expect(h.registrar).toHaveBeenCalledWith(CRED_APP, ID, PIN);
      expect(datosDe("estado")).toEqual({ estado: "falla", falla: "secreto_invalido" });
    });

    it("con el PIN de la persona: secreto_invalido", async () => {
      lecturas(deApp({ estado: "falta_pin" }));
      h.registrar.mockResolvedValue(falla("rechazo", 100));
      secretoRotado();

      expect(await pinWaba(QUIEN, "135790")).toBe("app_invalida");

      expect(datosDe("estado")).toEqual({ estado: "falla", falla: "secreto_invalido" });
    });

    it("pidiendo el código por SMS: secreto_invalido", async () => {
      h.pedirAMeta.mockResolvedValue(falla("rechazo", 100));
      secretoRotado();

      expect(await codigoWaba(QUIEN, { accion: "SMS" })).toBe("app_invalida");

      expect(datosDe("estado")).toEqual({ estado: "falla", falla: "secreto_invalido" });
    });

    it("con Embedded Signup no hay secreto que mirar: el 100 sigue siendo de la WABA y no se llama a la app", async () => {
      lecturas(vinculada({ estado: "suscripta", nombreEstado: "APPROVED" }));
      h.suscribir.mockResolvedValue(falla("rechazo", 100));

      expect(await continuarWaba(TENANT, almacen())).toBe("revision");

      expect(h.leerApp).not.toHaveBeenCalled();
      expect(datosDe("estado")).toEqual({ estado: "falla", falla: "suscripcion" });
    });
  });

  describe("la autenticación (190 y 102)", () => {
    it("sin subcódigo se confirma con la app: si la app entra, el vencido es el token", async () => {
      h.suscribir.mockResolvedValue(falla("rechazo", 190));

      expect(await continuarWaba(TENANT, almacen())).toBe("token_vencido");

      expect(datosDe("estado")).toEqual({ estado: "falla", falla: "token_vencido" });
      expect(h.aviso).toHaveBeenCalledWith("token_vencido", TENANT);
    });

    it("si la app tampoco entra, el que falla es el secreto", async () => {
      h.suscribir.mockResolvedValue(falla("rechazo", 190));
      secretoRotado();

      expect(await continuarWaba(TENANT, almacen())).toBe("app_invalida");

      expect(datosDe("estado")).toEqual({ estado: "falla", falla: "secreto_invalido" });
    });

    it("con el subcódigo de token vencido (463) no hace falta preguntarle a la app", async () => {
      h.suscribir.mockResolvedValue({ ...falla("rechazo", 190), subcodigo: 463 });

      expect(await continuarWaba(TENANT, almacen())).toBe("token_vencido");

      expect(h.leerApp).not.toHaveBeenCalled();
    });
  });

  describe("el 131031", () => {
    it("fuera del registro sólo dice «bloqueada» si la salud de la WABA lo confirma", async () => {
      h.datos.mockResolvedValue(falla("rechazo", 131031));
      h.leerSalud.mockResolvedValue(ok({ puedeEnviar: "BLOCKED" }));

      expect(await continuarWaba(TENANT, almacen())).toBe("waba_bloqueada");

      expect(datosDe("estado")).toEqual({ estado: "falla", falla: "waba_bloqueada" });
      expect(h.aviso).toHaveBeenCalledWith("waba_bloqueada", TENANT);
    });

    it("con la WABA sana no se la da por bloqueada: se mira a mano como cualquier rechazo", async () => {
      h.datos.mockResolvedValue(falla("rechazo", 131031));

      expect(await continuarWaba(TENANT, almacen())).toBe("revision");

      expect(datosDe("estado")).toEqual({ estado: "falla", falla: "registro" });
      expect(h.aviso).not.toHaveBeenCalledWith("waba_bloqueada", TENANT);
    });

    it("en el registro es el PIN, no la WABA: se pide el PIN y no se consulta la salud", async () => {
      h.registrar.mockResolvedValue(falla("rechazo", 131031));

      expect(await continuarWaba(TENANT, almacen())).toBe("falta_pin");

      expect(datosDe("estado")).toEqual({ estado: "falta_pin" });
      expect(h.leerSalud).not.toHaveBeenCalled();
    });
  });
});
