/**
 * El asistente de la app propia (`@/server/alta/app-propia`): el orden de los pasos, qué se le
 * contesta a la persona en cada salida, qué se guarda y, sobre todo, qué NO llega nunca a un
 * resultado ni a un registro (el secreto de la app, el token, el PIN y la prueba de la firma).
 *
 * Graph, la base (el almacén), el envío de correo y los avisos están simulados. Son de verdad
 * las banderas (`activaPara`, `appPropia`), el cifrado, la marca del webhook (`derivar`) y las
 * piezas puras de `waba-propia` (`paraSeguir`, `resultadoDe`, `esDeApp`, `yaConectada`), para
 * probar que el secreto cerrado abre con su AAD y con ningún otro. Qué URL y qué cuerpo salen a
 * Graph está en los tests de `app-del-cliente`, y el SQL de la 0051 lo prueba `pnpm tenancy`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const almacen = { leer: vi.fn(), guardar: vi.fn() };
  const almacenSistema = { leer: vi.fn(), guardar: vi.fn() };
  return {
    almacen,
    almacenSistema,
    almacenDelInquilino: vi.fn(),
    almacenDelDueno: vi.fn(),
    continuar: vi.fn(),
    cupo: vi.fn(),
    reintentar: vi.fn(),
    registrarNombre: vi.fn(),
    nombreRehabilitado: vi.fn(),
    recordatorioEnviado: vi.fn(),
    altas: vi.fn(),
    correo: vi.fn(),
    remitente: vi.fn(),
    leerApp: vi.fn(),
    leerDatos: vi.fn(),
    fijarDatos: vi.fn(),
    suscribirWebhook: vi.fn(),
    revisarToken: vi.fn(),
    leerSalud: vi.fn(),
    pedirNombre: vi.fn(),
    leerEstadoNombre: vi.fn(),
    datosNumero: vi.fn(),
    estaEnLaWaba: vi.fn(),
    recorrer: vi.fn(),
    otroAmbiente: vi.fn(),
    idPlataforma: vi.fn(),
    wabaPlataforma: vi.fn(),
    aviso: vi.fn(),
    after: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // Igual que Next: la tarea corre después; acá corre en el momento y se cuenta.
  after: (tarea: () => unknown) => {
    h.after();
    void tarea();
  },
}));
vi.mock("@/data/scope", () => ({ enControl: vi.fn() }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: h.debug, info: h.info, warn: h.warn, error: h.error },
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(), liberarCupo: vi.fn() }));
vi.mock("@/server/bases/espejar-sin-fallar", () => ({ espejarSinFallar: vi.fn() }));
vi.mock("@/server/alta/aviso-operador", () => ({ avisarNumeroEnRevision: h.aviso }));
vi.mock("@/server/alta/panel-operador", () => ({
  almacenDelDueno: h.almacenDelDueno,
  nombreRehabilitado: h.nombreRehabilitado,
  recordatorioEnviado: h.recordatorioEnviado,
}));
vi.mock("@/server/alta/wabas-del-cliente", () => ({ leerAltasAMedias: h.altas }));
vi.mock("@/server/alta/waba-propia", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/alta/waba-propia")>()),
  almacenDelInquilino: h.almacenDelInquilino,
  continuarWaba: h.continuar,
  cupoDeSeguir: h.cupo,
  reintentarWaba: h.reintentar,
  registrarConNombreAprobado: h.registrarNombre,
}));
vi.mock("@/server/ambiente/de-otro-ambiente", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/ambiente/de-otro-ambiente")>()),
  esNumeroDeOtroAmbiente: h.otroAmbiente,
}));
vi.mock("@/server/whatsapp/numeros", () => ({
  credencialDelEntorno: vi.fn(),
  idDeLaPlataforma: h.idPlataforma,
  wabaDeLaPlataforma: h.wabaPlataforma,
  webhookDelEntorno: vi.fn(),
}));
vi.mock("@/server/whatsapp/app-del-cliente", async (importOriginal) => ({
  // `pruebaDelSecreto`, los formatos y `pareceToken` son los de verdad: qué se acepta es parte de lo que se prueba.
  ...(await importOriginal<typeof import("@/server/whatsapp/app-del-cliente")>()),
  leerApp: h.leerApp,
  leerDatosDeLaApp: h.leerDatos,
  fijarDatosDeLaApp: h.fijarDatos,
  suscribirWebhookDeApp: h.suscribirWebhook,
  revisarTokenDeApp: h.revisarToken,
  leerSalud: h.leerSalud,
  pedirNombreNuevo: h.pedirNombre,
  leerEstadoDelNombre: h.leerEstadoNombre,
}));
vi.mock("@/server/whatsapp/embedded-signup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/whatsapp/embedded-signup")>()),
  datosDelNumero: h.datosNumero,
}));
vi.mock("@/server/whatsapp/verificar-en-meta", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/whatsapp/verificar-en-meta")>()),
  estaEnLaWaba: h.estaEnLaWaba,
  recorrerLaWabaOFalla: h.recorrer,
}));
vi.mock("@/server/notify/remitente-sistema", () => ({
  enviarCorreoDelSistema: h.correo,
  remitenteDelSistema: h.remitente,
}));

import { getT } from "@/lib/i18n";
import { derivar } from "@/server/alta/sellado";
import type { QuienPide } from "@/server/alta/pasos-del-numero";
import {
  cancelarDeApp,
  credencialesDeApp,
  estadoDeApp,
  iniciarApp,
  nombreAprobado,
  nombreDeApp,
  pasoDelAsistente,
  recordarAltasAMedias,
  reintentarDeApp,
  tokenDeApp,
  urlDelWebhookDeApp,
  veredictoDelNombre,
  webhookDeApp,
  type EstadoDeApp,
  type PasoDelAsistente,
} from "@/server/alta/app-propia";
import type { FilaDeWaba } from "@/server/alta/waba-propia";
import { urlDelWebhookDeApp as urlDeLaBandera } from "@/server/alta/waba-propia-activa";
import { VERSION_DEL_ANEXO, type ResultadoDeApp } from "@/server/alta/waba-resultados";
import { CAMPOS_DEL_WEBHOOK, pruebaDelSecreto } from "@/server/whatsapp/app-del-cliente";
import { aadDelPin, aadDelSecreto, aadDelToken, abrirSobre } from "@/server/whatsapp/sobres-del-cliente";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USUARIO = "22222222-2222-4222-8222-222222222222";
const OTRO_TENANT = "33333333-3333-4333-8333-333333333333";
const IP = "203.0.113.7";
const QUIEN: QuienPide = { tenantId: TENANT, userId: USUARIO, ip: IP, idioma: "es-AR" };

const APP_ID = "500000000000001";
const OTRA_APP = "500000000000002";
const APP_DE_LA_PLATAFORMA = "100000000000009";
const SECRETO = "fake-client-app-secret";
const SECRETO_NUEVO = "fake-client-app-secret-new";
const SECRETO_DE_LA_PLATAFORMA = "fake-platform-app-secret";
const TOKEN = "fake-system-user-token";
const TOKEN_VIEJO = "fake-old-system-user-token";
const WABA = "200000000000001";
const OTRA_WABA = "200000000000002";
const WABA_PLATAFORMA = "300000000000001";
const ID = "100000000000777";
const ID_2 = "100000000000778";
const ID_PLATAFORMA = "100000000000001";
const PIN_VIEJO = "654321";
const NUMERO = "+5491112345678";
const DISPLAY = "+54 9 11 1234-5678";
const OTRO_NUMERO = "+5491100000000";
const OTRO_DISPLAY = "+54 9 11 0000-0000";
const RUTA = "fake-ruta-0123456789abc";
const SLUG = "abcdefghij012345";
const SITIO = "https://claimmix.example.com";
const URL_WEBHOOK = `${SITIO}/api/webhooks/whatsapp/app/${RUTA}`;
const CUIT = "30712345671";
const CORREO = "dueno@example.com";
const AHORA = new Date("2026-10-13T12:00:00Z");
const PRUEBA = pruebaDelSecreto(TOKEN, SECRETO);
const PRUEBA_VIEJA = pruebaDelSecreto(TOKEN_VIEJO, SECRETO);
const CRED_DE_FILA = { accessToken: TOKEN_VIEJO, wabaId: WABA, prueba: PRUEBA_VIEJA };

const ENTORNO: Record<string, string> = {
  ALTA_APP_PROPIA: "1",
  ALTA_WABA_PROPIA: "",
  NEXT_PUBLIC_SITE_URL: SITIO,
  META_APP_ID: APP_DE_LA_PLATAFORMA,
  META_ES_CONFIG_ID: "fake-config-id",
  WHATSAPP_APP_SECRET: SECRETO_DE_LA_PLATAFORMA,
  WHATSAPP_APP_SECRETS_KEY: "test-app-secrets-key",
  BETTER_AUTH_SECRET: "test-better-auth-secret-key",
  GMAIL_TOKEN_ENCRYPTION_KEY: "test-waba-encryption-key",
};

/** La fila de una alta de la app propia que recién empieza (P1): sin app, con lo que `iniciarApp` dejó. */
const fila = (extra: Partial<FilaDeWaba> = {}): FilaDeWaba => ({
  estado: "armando",
  falla: null,
  wabaId: null,
  businessId: null,
  phoneNumberId: null,
  numeroTipeado: NUMERO,
  numeroMeta: null,
  numeroAceptado: false,
  token: null,
  pin: null,
  nombreEstado: null,
  plantillaEnviadaEn: null,
  numeroEstado: null,
  emailDeContacto: CORREO,
  origen: "app_propia",
  appId: null,
  secreto: null,
  ruta: RUTA,
  webhookAppVerificadoEn: null,
  datosAppEn: null,
  primerMensajeEn: null,
  primeraRespuestaEn: null,
  slugLegal: SLUG,
  razonSocial: "Aseguradora Sur S.A.",
  cuit: CUIT,
  acuerdoVersion: VERSION_DEL_ANEXO,
  recordatorioEn: null,
  puedeEnviar: null,
  ...extra,
});

/** Con la app cargada y el webhook verificado: lista para pedir el token (P2). */
const conApp = (extra: Partial<FilaDeWaba> = {}) =>
  fila({ appId: APP_ID, secreto: SECRETO, webhookAppVerificadoEn: AHORA, ...extra });

/** Con el número conectado y el token guardado (E6, el nombre visible, «Reintentar»). */
const conectada = (extra: Partial<FilaDeWaba> = {}) =>
  conApp({
    estado: "conectada",
    wabaId: WABA,
    phoneNumberId: ID,
    numeroEstado: "conectado",
    numeroMeta: NUMERO,
    token: TOKEN_VIEJO,
    pin: PIN_VIEJO,
    ...extra,
  });

const nombreRechazado = (extra: Partial<FilaDeWaba> = {}) => conectada({ estado: "falla", falla: "nombre_rechazado", ...extra });

const CREDENCIALES = { appId: APP_ID, secreto: SECRETO };
const PEDIDO_DE_TOKEN = { token: TOKEN, wabaId: WABA };
const DATOS_DE_INICIO = { acuerdo: VERSION_DEL_ANEXO, razonSocial: "Aseguradora Sur S.A.", cuit: "30-71234567-1" };

const ok = <T>(valor: T) => ({ ok: true as const, valor });
const falla = (motivo: "esperar" | "meta" | "rechazo", codigo: number | null = null) => ({ ok: false as const, falla: motivo, codigo });
const datosDelNumero = (extra: Record<string, unknown> = {}) =>
  ok({ display: DISPLAY, nombre: "Aseguradora Sur", verificado: false, nombreEstado: null, enLaApp: false, ...extra });

/** Todo lo que se anotó, en un solo texto: para comprobar lo que NO tiene que estar. */
const registros = () => JSON.stringify([h.debug, h.info, h.warn, h.error].map((f) => f.mock.calls));

beforeEach(() => {
  vi.resetAllMocks();
  for (const [nombre, valor] of Object.entries(ENTORNO)) vi.stubEnv(nombre, valor);
  h.almacenDelInquilino.mockReturnValue(h.almacen);
  h.almacenDelDueno.mockReturnValue(h.almacenSistema);
  h.almacen.leer.mockResolvedValue(fila());
  h.almacen.guardar.mockResolvedValue("ok");
  h.almacenSistema.leer.mockResolvedValue(conectada());
  h.almacenSistema.guardar.mockResolvedValue("ok");
  h.cupo.mockResolvedValue(true);
  h.continuar.mockResolvedValue("listo");
  h.reintentar.mockResolvedValue("listo");
  h.registrarNombre.mockResolvedValue("registrado");
  h.nombreRehabilitado.mockResolvedValue(true);
  h.recordatorioEnviado.mockResolvedValue(undefined);
  h.altas.mockResolvedValue([]);
  h.correo.mockResolvedValue({ enviado: true });
  h.remitente.mockReturnValue({ correo: "sistema@example.com", refreshToken: "fake-refresh-token" });
  h.leerApp.mockResolvedValue(ok("ninguno"));
  h.leerDatos.mockResolvedValue(ok({ terminos: null, privacidad: null, contacto: null }));
  h.fijarDatos.mockResolvedValue(ok(true));
  h.suscribirWebhook.mockResolvedValue(ok(true));
  h.revisarToken.mockResolvedValue({ ok: true, usuarioId: "900", wabaIds: [WABA] });
  h.recorrer.mockResolvedValue(ok({ filas: [{ id: ID, display: DISPLAY, nombre: null }], completa: true }));
  h.datosNumero.mockResolvedValue(datosDelNumero());
  h.estaEnLaWaba.mockResolvedValue(true);
  h.otroAmbiente.mockReturnValue(false);
  h.idPlataforma.mockReturnValue(ID_PLATAFORMA);
  h.wabaPlataforma.mockReturnValue(WABA_PLATAFORMA);
  h.pedirNombre.mockResolvedValue(ok(true));
  h.leerEstadoNombre.mockResolvedValue(ok({ nombre: "Aseguradora Sur", estado: "DECLINED", estadoNuevo: null }));
  h.leerSalud.mockResolvedValue(ok({ puedeEnviar: "AVAILABLE", motivos: [] }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/* ── En qué ventana está ──────────────────────────────────────────────────── */

describe("pasoDelAsistente", () => {
  const otroNumero = { numeroMeta: OTRO_NUMERO };

  it.each<[string, FilaDeWaba | null, PasoDelAsistente]>([
    ["sin fila", null, "P0"],
    ["una alta del popup de Meta", fila({ origen: "embedded_signup", estado: "conectada" }), "P0"],
    ["una alta del camino viejo", fila({ origen: null, estado: "armando" }), "P0"],
    ["una alta cancelada", fila({ estado: "cancelada" }), "P0"],
    ["una alta revocada", fila({ estado: "revocada" }), "P0"],
    ["armando, sin app cargada", fila(), "P1"],
    ["armando, app cargada y webhook sin verificar", fila({ appId: APP_ID, secreto: SECRETO }), "P1B"],
    ["armando, app cargada y webhook verificado", conApp(), "P2"],
    ["suscripta, webhook sin verificar", conApp({ estado: "suscripta", webhookAppVerificadoEn: null }), "E14"],
    ["suscripta, webhook verificado", conApp({ estado: "suscripta" }), "seguir"],
    ["vinculada con otro número que el tipeado, sin aceptar", conApp({ estado: "vinculada", ...otroNumero }), "E5"],
    ["vinculada con otro número, ya aceptado", conApp({ estado: "vinculada", numeroAceptado: true, ...otroNumero }), "seguir"],
    ["vinculada con el mismo número", conApp({ estado: "vinculada", numeroMeta: NUMERO }), "seguir"],
    ["vinculada con un número de Meta y ninguno tipeado (es opcional): no hay con qué comparar", conApp({ estado: "vinculada", numeroTipeado: null, ...otroNumero }), "seguir"],
    ["vinculada con el mismo número escrito sin el 9", conApp({ estado: "vinculada", numeroMeta: "+541112345678" }), "seguir"],
    ["falta el código", conApp({ estado: "falta_codigo" }), "E3"],
    ["falta el PIN", conApp({ estado: "falta_pin" }), "E4"],
    ["conectada, sin respuesta del cliente", conectada(), "P4"],
    ["conectada, con respuesta del cliente", conectada({ primeraRespuestaEn: AHORA }), "G"],
    ["caída por pago pendiente, sin respuesta", conectada({ estado: "falla", falla: "pago_pendiente" }), "P4"],
    ["caída por pago pendiente, con respuesta", conectada({ estado: "falla", falla: "pago_pendiente", primeraRespuestaEn: AHORA }), "G"],
    ["caída por token vencido", conectada({ estado: "falla", falla: "token_vencido" }), "G"],
    ["caída por nombre rechazado", nombreRechazado(), "G"],
    ["un estado que esta pantalla no conoce", conectada({ estado: "pausada" }), "G"],
  ])("%s", (_nombre, entrada, esperado) => {
    expect(pasoDelAsistente(entrada)).toBe(esperado);
  });
});

describe("estadoDeApp", () => {
  it("sin fila es el principio, con una sola lectura y ninguna llamada a Meta", async () => {
    h.almacen.leer.mockResolvedValue(null);
    expect(await estadoDeApp(QUIEN)).toEqual<EstadoDeApp>({
      paso: "P0",
      estado: null,
      falla: null,
      appId: null,
      webhookVerificado: false,
      datosApp: false,
      numero: null,
      nombreEstado: null,
      plantilla: false,
      primerMensaje: false,
      primeraRespuesta: false,
      puedeEnviar: null,
    });
    expect(h.almacen.leer).toHaveBeenCalledTimes(1);
  });

  it("describe la fila con una sola lectura, sin hablar con Graph y sin llevar ningún secreto", async () => {
    h.almacen.leer.mockResolvedValue(
      conectada({
        nombreEstado: "APPROVED",
        plantillaEnviadaEn: AHORA,
        primerMensajeEn: AHORA,
        datosAppEn: AHORA,
        puedeEnviar: "AVAILABLE",
      })
    );
    const estado = await estadoDeApp(QUIEN);
    expect(estado).toEqual<EstadoDeApp>({
      paso: "P4",
      estado: "conectada",
      falla: null,
      appId: APP_ID,
      webhookVerificado: true,
      datosApp: true,
      numero: NUMERO,
      nombreEstado: "APPROVED",
      plantilla: true,
      primerMensaje: true,
      primeraRespuesta: false,
      puedeEnviar: "AVAILABLE",
    });
    expect(h.almacen.leer).toHaveBeenCalledTimes(1);
    expect(h.almacen.guardar).not.toHaveBeenCalled();
    for (const graph of [h.leerApp, h.leerSalud, h.datosNumero, h.recorrer, h.estaEnLaWaba, h.leerEstadoNombre, h.revisarToken]) {
      expect(graph).not.toHaveBeenCalled();
    }
    const texto = JSON.stringify(estado);
    for (const secreto of [SECRETO, TOKEN_VIEJO, PIN_VIEJO, RUTA, SLUG, CUIT, CORREO]) expect(texto).not.toContain(secreto);
  });

  it("el número es el que Meta informó y, si todavía no, el que la persona tipeó", async () => {
    h.almacen.leer.mockResolvedValue(fila());
    expect((await estadoDeApp(QUIEN)).numero).toBe(NUMERO);
    h.almacen.leer.mockResolvedValue(conApp({ estado: "vinculada", numeroMeta: OTRO_NUMERO }));
    expect((await estadoDeApp(QUIEN)).numero).toBe(OTRO_NUMERO);
  });

  it("una fila que no es de la app propia no muestra su app ni su webhook, pero sí el estado del número", async () => {
    h.almacen.leer.mockResolvedValue(
      fila({ origen: "embedded_signup", estado: "conectada", appId: APP_ID, webhookAppVerificadoEn: AHORA, datosAppEn: AHORA, nombreEstado: "APPROVED" })
    );
    expect(await estadoDeApp(QUIEN)).toMatchObject({
      paso: "P0",
      estado: "conectada",
      appId: null,
      webhookVerificado: false,
      datosApp: false,
      nombreEstado: "APPROVED",
    });
  });

  it("no mira las banderas: lo que ya está en la base se sigue viendo con la vía apagada", async () => {
    vi.stubEnv("ALTA_APP_PROPIA", "");
    h.almacen.leer.mockResolvedValue(conectada());
    expect(await estadoDeApp(QUIEN)).toMatchObject({ paso: "P4", estado: "conectada", appId: APP_ID });
  });

  it("si la lectura falla no tira: vuelve al principio y anota sólo el nombre del error", async () => {
    h.almacen.leer.mockRejectedValue(new Error(`falló con ${SECRETO}`));
    expect(await estadoDeApp(QUIEN)).toMatchObject({ paso: "P0", estado: null, appId: null });
    expect(h.error).toHaveBeenCalledWith({ error: "Error", donde: "app_estado" }, "alta.waba_fallo");
    expect(registros()).not.toContain(SECRETO);
  });
});

/* ── P0: el acuerdo y los datos del cliente ───────────────────────────────── */

describe("iniciarApp", () => {
  const sinGraph = () => {
    for (const graph of [h.leerApp, h.leerDatos, h.fijarDatos, h.suscribirWebhook, h.revisarToken]) expect(graph).not.toHaveBeenCalled();
  };

  it("guarda el acuerdo, la razón social y el CUIT sin separadores, con una ruta y un slug nuevos", async () => {
    expect(await iniciarApp(QUIEN, DATOS_DE_INICIO)).toEqual({ resultado: "listo" });
    expect(h.almacenDelInquilino).toHaveBeenCalledWith(QUIEN);
    expect(h.almacen.guardar).toHaveBeenCalledTimes(1);
    expect(h.almacen.guardar).toHaveBeenCalledWith("app_iniciar", {
      ruta: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      slug: expect.stringMatching(/^[a-z0-9]{16}$/),
      razon_social: "Aseguradora Sur S.A.",
      cuit: CUIT,
      acuerdo: VERSION_DEL_ANEXO,
    });
    sinGraph();
  });

  it("cada arranque genera otra ruta y otro slug: son aleatorios, no derivan del espacio", async () => {
    await iniciarApp(QUIEN, DATOS_DE_INICIO);
    await iniciarApp(QUIEN, DATOS_DE_INICIO);
    const [[, primero], [, segundo]] = h.almacen.guardar.mock.calls;
    expect(primero.ruta).not.toBe(segundo.ruta);
    expect(primero.slug).not.toBe(segundo.slug);
    expect(JSON.stringify([primero, segundo])).not.toContain(TENANT);
  });

  it("el número, si lo dio, se guarda normalizado; en blanco es como no darlo", async () => {
    await iniciarApp(QUIEN, { ...DATOS_DE_INICIO, numero: DISPLAY });
    expect(h.almacen.guardar).toHaveBeenLastCalledWith("app_iniciar", expect.objectContaining({ numero: NUMERO }));
    await iniciarApp(QUIEN, { ...DATOS_DE_INICIO, numero: "   " });
    expect(h.almacen.guardar.mock.calls[1][1]).not.toHaveProperty("numero");
    await iniciarApp(QUIEN, DATOS_DE_INICIO);
    expect(h.almacen.guardar.mock.calls[2][1]).not.toHaveProperty("numero");
  });

  it("la razón social se recorta, y 120 caracteres es el máximo", async () => {
    await iniciarApp(QUIEN, { ...DATOS_DE_INICIO, razonSocial: "  Sur S.A.  " });
    expect(h.almacen.guardar).toHaveBeenLastCalledWith("app_iniciar", expect.objectContaining({ razon_social: "Sur S.A." }));
    const larga = "a".repeat(120);
    expect(await iniciarApp(QUIEN, { ...DATOS_DE_INICIO, razonSocial: larga })).toEqual({ resultado: "listo" });
    expect(h.almacen.guardar).toHaveBeenLastCalledWith("app_iniciar", expect.objectContaining({ razon_social: larga }));
  });

  it.each([
    ["con guiones", "30-71234567-1"],
    ["con espacios", "30 71234567 1"],
    ["sin separadores", "30712345671"],
    ["con el dígito verificador cero (resto 0)", "20000000060"],
  ])("el CUIT %s se acepta y se guarda con sus once dígitos", async (_nombre, cuit) => {
    expect(await iniciarApp(QUIEN, { ...DATOS_DE_INICIO, cuit })).toEqual({ resultado: "listo" });
    expect(h.almacen.guardar).toHaveBeenLastCalledWith("app_iniciar", expect.objectContaining({ cuit: cuit.replace(/[\s-]/g, "") }));
  });

  it.each<[string, Partial<typeof DATOS_DE_INICIO> & { numero?: string }, ResultadoDeApp]>([
    ["otra versión del acuerdo", { acuerdo: "2025-01" }, "formato"],
    ["sin acuerdo", { acuerdo: "" }, "formato"],
    ["razón social vacía", { razonSocial: "" }, "razon_invalida"],
    ["razón social en blanco", { razonSocial: "   " }, "razon_invalida"],
    ["razón social de 121 caracteres", { razonSocial: "a".repeat(121) }, "razon_invalida"],
    ["razón social con un carácter de control", { razonSocial: "Sur\u0007 S.A." }, "razon_invalida"],
    ["razón social con un tabulador", { razonSocial: "Sur\tS.A." }, "razon_invalida"],
    ["CUIT con el dígito verificador mal", { cuit: "30-71234567-2" }, "cuit_invalido"],
    ["CUIT de diez dígitos", { cuit: "3071234567" }, "cuit_invalido"],
    ["CUIT de doce dígitos", { cuit: "307123456711" }, "cuit_invalido"],
    ["CUIT con letras", { cuit: "30-7123456a-1" }, "cuit_invalido"],
    ["CUIT vacío", { cuit: "" }, "cuit_invalido"],
    ["CUIT cuyo verificador sería diez (resto 1)", { cuit: "20000000010" }, "cuit_invalido"],
    ["número sin prefijo de país", { numero: "11 1234 5678" }, "numero_invalido"],
    ["número que no es un número", { numero: "no es un número" }, "numero_invalido"],
  ])("%s: %s sin tocar la base ni Meta", async (_nombre, cambios, esperado) => {
    expect(await iniciarApp(QUIEN, { ...DATOS_DE_INICIO, ...cambios })).toEqual({ resultado: esperado });
    expect(h.almacen.leer).not.toHaveBeenCalled();
    expect(h.almacen.guardar).not.toHaveBeenCalled();
    sinGraph();
  });

  it("el primer dato malo manda: el acuerdo antes que la razón social, ésta antes que el CUIT y el CUIT antes que el número", async () => {
    const todoMalo = { acuerdo: "x", razonSocial: "", cuit: "1", numero: "1" };
    expect(await iniciarApp(QUIEN, todoMalo)).toEqual({ resultado: "formato" });
    expect(await iniciarApp(QUIEN, { ...todoMalo, acuerdo: VERSION_DEL_ANEXO })).toEqual({ resultado: "razon_invalida" });
    expect(await iniciarApp(QUIEN, { ...todoMalo, acuerdo: VERSION_DEL_ANEXO, razonSocial: "Sur" })).toEqual({ resultado: "cuit_invalido" });
    expect(await iniciarApp(QUIEN, { ...todoMalo, acuerdo: VERSION_DEL_ANEXO, razonSocial: "Sur", cuit: CUIT })).toEqual({ resultado: "numero_invalido" });
  });

  it("repetirla con el alta en `armando` la retoma: la base decide qué se conserva", async () => {
    h.almacen.leer.mockResolvedValue(conApp());
    expect(await iniciarApp(QUIEN, DATOS_DE_INICIO)).toEqual({ resultado: "listo" });
    expect(h.almacen.guardar).toHaveBeenCalledWith("app_iniciar", expect.any(Object));
  });

  it.each(["cancelada", "revocada"])("una alta %s no cuenta como viva: se puede empezar de nuevo", async (estado) => {
    h.almacen.leer.mockResolvedValue(fila({ estado }));
    expect(await iniciarApp(QUIEN, DATOS_DE_INICIO)).toEqual({ resultado: "listo" });
  });

  it("un espacio sin alta previa (sin fila viva) empieza con la bandera de la app propia", async () => {
    h.almacen.leer.mockResolvedValue(fila({ estado: null, origen: null }));
    expect(await iniciarApp(QUIEN, DATOS_DE_INICIO)).toEqual({ resultado: "listo" });
    vi.stubEnv("ALTA_APP_PROPIA", "");
    expect(await iniciarApp(QUIEN, DATOS_DE_INICIO)).toEqual({ resultado: "apagado" });
    expect(h.almacen.guardar).toHaveBeenCalledTimes(1);
  });

  it("sin fila (no es un espacio de la alta automática) está apagada", async () => {
    h.almacen.leer.mockResolvedValue(null);
    expect(await iniciarApp(QUIEN, DATOS_DE_INICIO)).toEqual({ resultado: "apagado" });
    expect(h.almacen.guardar).not.toHaveBeenCalled();
  });

  it.each([
    ["sin la bandera", { ALTA_APP_PROPIA: "" }],
    ["sin la dirección del sitio", { NEXT_PUBLIC_SITE_URL: "" }],
    ["sin el App ID de la plataforma", { META_APP_ID: "" }],
    ["sin el secreto de la plataforma", { WHATSAPP_APP_SECRET: "" }],
    ["sin la clave de los secretos de los clientes", { WHATSAPP_APP_SECRETS_KEY: "" }],
  ])("%s está apagada, aunque el espacio ya tenga su alta en curso", async (_nombre, entorno) => {
    for (const [nombre, valor] of Object.entries(entorno)) vi.stubEnv(nombre, valor);
    for (const existente of [fila(), fila({ estado: null, origen: null })]) {
      h.almacen.leer.mockResolvedValue(existente);
      expect(await iniciarApp(QUIEN, DATOS_DE_INICIO)).toEqual({ resultado: "apagado" });
    }
    expect(h.almacen.guardar).not.toHaveBeenCalled();
  });

  it("no pisa un alta del popup de Meta: en curso es `transicion` y ya andando es `ya_conectado`", async () => {
    h.almacen.leer.mockResolvedValue(fila({ origen: "embedded_signup", estado: "vinculada" }));
    expect(await iniciarApp(QUIEN, DATOS_DE_INICIO)).toEqual({ resultado: "transicion" });
    h.almacen.leer.mockResolvedValue(fila({ origen: "embedded_signup", estado: "conectada", numeroEstado: "conectado" }));
    expect(await iniciarApp(QUIEN, DATOS_DE_INICIO)).toEqual({ resultado: "ya_conectado" });
    expect(h.almacen.guardar).not.toHaveBeenCalled();
  });

  it("no pisa un alta del popup de Meta aunque la bandera de la app propia esté apagada", async () => {
    vi.stubEnv("ALTA_APP_PROPIA", "");
    h.almacen.leer.mockResolvedValue(fila({ origen: "embedded_signup", estado: "vinculada" }));
    expect(await iniciarApp(QUIEN, DATOS_DE_INICIO)).toEqual({ resultado: "transicion" });
  });

  it("un espacio que ya tiene su WhatsApp conectado (por el camino viejo o por esta vía) no arranca otra alta", async () => {
    h.almacen.leer.mockResolvedValue(fila({ estado: null, origen: null, numeroEstado: "conectado" }));
    expect(await iniciarApp(QUIEN, DATOS_DE_INICIO)).toEqual({ resultado: "ya_conectado" });
    h.almacen.leer.mockResolvedValue(conectada());
    expect(await iniciarApp(QUIEN, DATOS_DE_INICIO)).toEqual({ resultado: "ya_conectado" });
    expect(h.almacen.guardar).not.toHaveBeenCalled();
  });

  it.each<[string, ResultadoDeApp]>([
    ["transicion", "transicion"],
    ["ya_conectado", "ya_conectado"],
    ["apagado", "apagado"],
    ["sin_migracion", "apagado"],
    ["app_ocupada", "app_ocupada"],
    ["otra_app", "otra_app"],
    ["webhook_pendiente", "webhook_pendiente"],
    ["de_la_plataforma", "de_la_plataforma"],
    ["numero_ocupado", "numero_ocupado"],
    ["cupo", "cupo"],
    ["no_aplica", "revision"],
    ["datos_invalidos", "meta"],
    ["error", "meta"],
  ])("si la base contesta «%s» se le dice a la persona «%s»", async (guardado, esperado) => {
    h.almacen.guardar.mockResolvedValue(guardado);
    expect(await iniciarApp(QUIEN, DATOS_DE_INICIO)).toEqual({ resultado: esperado });
  });
});

/* ── P1: la app del cliente ───────────────────────────────────────────────── */

describe("credencialesDeApp", () => {
  const ESPERAR = falla("esperar", 4);
  const sinEscribirEnLaApp = () => {
    expect(h.leerDatos).not.toHaveBeenCalled();
    expect(h.fijarDatos).not.toHaveBeenCalled();
    expect(h.suscribirWebhook).not.toHaveBeenCalled();
  };

  it("camino feliz: comprueba la app con Meta, guarda el secreto cerrado, completa los datos legales y deja el webhook", async () => {
    expect(await credencialesDeApp(QUIEN, CREDENCIALES)).toEqual({ resultado: "listo" });

    expect(h.leerApp).toHaveBeenCalledWith({ appId: APP_ID, secreto: SECRETO }, URL_WEBHOOK);
    expect(h.leerDatos).toHaveBeenCalledWith({ appId: APP_ID, secreto: SECRETO });
    expect(h.fijarDatos).toHaveBeenCalledWith(
      { appId: APP_ID, secreto: SECRETO },
      { terminos: `${SITIO}/legal/${SLUG}/terminos`, privacidad: `${SITIO}/legal/${SLUG}/privacidad`, contacto: CORREO }
    );
    expect(h.almacen.guardar).toHaveBeenCalledTimes(1);
    expect(h.almacen.guardar).toHaveBeenCalledWith("app_credenciales", {
      app_id: APP_ID,
      app_secreto_cifrado: expect.any(String),
      ruta: RUTA,
      datos_app: true,
    });
    expect(h.suscribirWebhook).toHaveBeenCalledWith(
      { appId: APP_ID, secreto: SECRETO },
      URL_WEBHOOK,
      derivar("wa-verify-app", RUTA),
      CAMPOS_DEL_WEBHOOK
    );
    // El webhook se deja después de guardar: si guardar no sale no se toca la app del cliente.
    expect(h.almacen.guardar.mock.invocationCallOrder[0]).toBeLessThan(h.suscribirWebhook.mock.invocationCallOrder[0]);
  });

  it("el secreto se guarda cerrado: abre con el AAD de su espacio y de su app, y con ningún otro", async () => {
    await credencialesDeApp(QUIEN, CREDENCIALES);
    const sobre = h.almacen.guardar.mock.calls[0][1].app_secreto_cifrado as string;
    expect(sobre).not.toContain(SECRETO);
    expect(abrirSobre(sobre, aadDelSecreto(TENANT, APP_ID))).toBe(SECRETO);
    expect(abrirSobre(sobre, aadDelSecreto(OTRO_TENANT, APP_ID))).toBeNull();
    expect(abrirSobre(sobre, aadDelSecreto(TENANT, OTRA_APP))).toBeNull();
  });

  it("recorta los bordes del ID y del secreto", async () => {
    expect(await credencialesDeApp(QUIEN, { appId: ` ${APP_ID} `, secreto: ` ${SECRETO}\n` })).toEqual({ resultado: "listo" });
    expect(h.leerApp).toHaveBeenCalledWith({ appId: APP_ID, secreto: SECRETO }, URL_WEBHOOK);
  });

  it.each<[string, { appId: string; secreto: string }, ResultadoDeApp]>([
    ["un ID de app con letras", { appId: "abc", secreto: SECRETO }, "formato_app"],
    ["un ID de app vacío", { appId: "", secreto: SECRETO }, "formato_app"],
    ["un ID de app con espacios adentro", { appId: "5000 0000 0000 01", secreto: SECRETO }, "formato_app"],
    ["un secreto vacío", { appId: APP_ID, secreto: "" }, "formato_secreto"],
    ["un secreto con un espacio adentro", { appId: APP_ID, secreto: "fake secret" }, "formato_secreto"],
    ["un secreto con un salto de línea adentro", { appId: APP_ID, secreto: "fake\nsecret" }, "formato_secreto"],
    ["un secreto de más de 128 caracteres", { appId: APP_ID, secreto: "a".repeat(129) }, "formato_secreto"],
    ["un secreto que empieza como un token (EAA)", { appId: APP_ID, secreto: "EAAfake-token-not-a-secret" }, "parece_token"],
    ["un secreto con una barra vertical (app|secreto)", { appId: APP_ID, secreto: "500000000000001|fake" }, "parece_token"],
    ["el ID de app de la plataforma", { appId: APP_DE_LA_PLATAFORMA, secreto: SECRETO }, "app_de_la_plataforma"],
    ["el secreto de la plataforma", { appId: APP_ID, secreto: SECRETO_DE_LA_PLATAFORMA }, "app_de_la_plataforma"],
    ["la app y el secreto de la plataforma", { appId: APP_DE_LA_PLATAFORMA, secreto: SECRETO_DE_LA_PLATAFORMA }, "app_de_la_plataforma"],
  ])("%s: se corta antes de leer la base y de hablar con Meta", async (_nombre, datos, esperado) => {
    expect(await credencialesDeApp(QUIEN, datos)).toEqual({ resultado: esperado });
    expect(h.almacen.leer).not.toHaveBeenCalled();
    expect(h.almacen.guardar).not.toHaveBeenCalled();
    expect(h.leerApp).not.toHaveBeenCalled();
    sinEscribirEnLaApp();
  });

  it("revisa el formato del ID antes que el del secreto", async () => {
    expect(await credencialesDeApp(QUIEN, { appId: "x", secreto: "" })).toEqual({ resultado: "formato_app" });
  });

  it("revisa si es de la plataforma aunque el secreto de la plataforma venga recortado o la app no coincida", async () => {
    expect(await credencialesDeApp(QUIEN, { appId: ` ${APP_DE_LA_PLATAFORMA}`, secreto: SECRETO })).toEqual({ resultado: "app_de_la_plataforma" });
  });

  it.each([
    ["sin fila", null, "apagado"],
    ["una alta que no es de la app propia, con esa vía apagada", fila({ origen: "embedded_signup", estado: "vinculada" }), "apagado"],
    ["una alta cancelada", fila({ estado: "cancelada" }), "transicion"],
    ["una alta sin ruta", fila({ ruta: null }), "transicion"],
  ] as const)("%s", async (_nombre, existente, esperado) => {
    h.almacen.leer.mockResolvedValue(existente);
    expect(await credencialesDeApp(QUIEN, CREDENCIALES)).toEqual({ resultado: esperado });
    expect(h.leerApp).not.toHaveBeenCalled();
    expect(h.almacen.guardar).not.toHaveBeenCalled();
  });

  it("una alta del popup en curso, con el popup prendido, no es de esta vía: `transicion`", async () => {
    vi.stubEnv("ALTA_WABA_PROPIA", "1");
    h.almacen.leer.mockResolvedValue(fila({ origen: "embedded_signup", estado: "vinculada" }));
    expect(await credencialesDeApp(QUIEN, CREDENCIALES)).toEqual({ resultado: "transicion" });
    expect(h.almacen.guardar).not.toHaveBeenCalled();
  });

  it("con la vía apagada no hace nada, ni siquiera comprobar la app", async () => {
    vi.stubEnv("ALTA_APP_PROPIA", "");
    expect(await credencialesDeApp(QUIEN, CREDENCIALES)).toEqual({ resultado: "apagado" });
    expect(h.leerApp).not.toHaveBeenCalled();
    expect(h.almacen.guardar).not.toHaveBeenCalled();
  });

  describe("la ruta del webhook", () => {
    it("repetir la misma app en `armando` conserva la ruta", async () => {
      h.almacen.leer.mockResolvedValue(fila({ appId: APP_ID, secreto: SECRETO }));
      await credencialesDeApp(QUIEN, CREDENCIALES);
      expect(h.almacen.guardar).toHaveBeenCalledWith("app_credenciales", expect.objectContaining({ ruta: RUTA }));
      expect(h.leerApp).toHaveBeenCalledWith(expect.anything(), URL_WEBHOOK);
    });

    it("cambiar de app en `armando` rota la ruta: lo que quede apuntando a la anterior ya no llega", async () => {
      h.almacen.leer.mockResolvedValue(fila({ appId: OTRA_APP, secreto: SECRETO, webhookAppVerificadoEn: AHORA }));
      await credencialesDeApp(QUIEN, CREDENCIALES);
      const { ruta } = h.almacen.guardar.mock.calls[0][1];
      expect(ruta).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(ruta).not.toBe(RUTA);
      expect(h.leerApp).toHaveBeenCalledWith(expect.anything(), `${SITIO}/api/webhooks/whatsapp/app/${ruta}`);
      expect(h.suscribirWebhook).toHaveBeenCalledWith(
        expect.anything(),
        `${SITIO}/api/webhooks/whatsapp/app/${ruta}`,
        derivar("wa-verify-app", ruta),
        CAMPOS_DEL_WEBHOOK
      );
    });

    it("la primera app que se carga usa la ruta que dejó `iniciarApp`", async () => {
      await credencialesDeApp(QUIEN, CREDENCIALES);
      expect(h.almacen.guardar).toHaveBeenCalledWith("app_credenciales", expect.objectContaining({ ruta: RUTA }));
    });
  });

  describe("con el alta más avanzada (cambiar sólo el secreto)", () => {
    it.each([
      ["conectada", conectada()],
      ["caída por token vencido", conectada({ estado: "falla", falla: "token_vencido" })],
      ["vinculada", conApp({ estado: "vinculada" })],
    ])("%s: el mismo ID de app cambia el secreto y nada más", async (_nombre, existente) => {
      h.almacen.leer.mockResolvedValue(existente);
      expect(await credencialesDeApp(QUIEN, { appId: APP_ID, secreto: SECRETO_NUEVO })).toEqual({ resultado: "listo" });
      expect(h.leerApp).toHaveBeenCalledWith({ appId: APP_ID, secreto: SECRETO_NUEVO }, URL_WEBHOOK);
      // No hay `datos_app` en lo que se guarda, y ni la ruta ni la app del cliente se tocan.
      expect(h.almacen.guardar).toHaveBeenCalledWith("app_credenciales", {
        app_id: APP_ID,
        app_secreto_cifrado: expect.any(String),
        ruta: RUTA,
      });
      sinEscribirEnLaApp();
    });

    it("el secreto cayó armando el alta (número pedido): se guarda y el alta sigue con `continuarWaba`", async () => {
      h.almacen.leer.mockResolvedValue(conectada({ estado: "falla", falla: "secreto_invalido", numeroEstado: "pedido", pin: null }));
      h.continuar.mockResolvedValue("falta_codigo");
      expect(await credencialesDeApp(QUIEN, { appId: APP_ID, secreto: SECRETO_NUEVO })).toEqual({ resultado: "falta_codigo" });
      expect(h.almacen.guardar).toHaveBeenCalledWith("app_credenciales", expect.objectContaining({ app_id: APP_ID }));
      expect(h.continuar).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["conectada", conectada()],
      ["caída por secreto con el número conectado", conectada({ estado: "falla", falla: "secreto_invalido" })],
      ["caída por token vencido con el número pedido", conectada({ estado: "falla", falla: "token_vencido", numeroEstado: "pedido" })],
    ])("%s: no se sigue el camino, sólo se cambia el secreto", async (_nombre, existente) => {
      h.almacen.leer.mockResolvedValue(existente);
      expect(await credencialesDeApp(QUIEN, { appId: APP_ID, secreto: SECRETO_NUEVO })).toEqual({ resultado: "listo" });
      expect(h.continuar).not.toHaveBeenCalled();
    });

    it("otro ID de app es `otra_app`: no se cambia de app con el número ya vinculado, ni se habla con Meta", async () => {
      h.almacen.leer.mockResolvedValue(conectada());
      expect(await credencialesDeApp(QUIEN, { appId: OTRA_APP, secreto: SECRETO_NUEVO })).toEqual({ resultado: "otra_app" });
      expect(h.leerApp).not.toHaveBeenCalled();
      expect(h.almacen.guardar).not.toHaveBeenCalled();
    });

    it("el secreto nuevo se guarda cerrado con su AAD", async () => {
      h.almacen.leer.mockResolvedValue(conectada());
      await credencialesDeApp(QUIEN, { appId: APP_ID, secreto: SECRETO_NUEVO });
      const sobre = h.almacen.guardar.mock.calls[0][1].app_secreto_cifrado as string;
      expect(abrirSobre(sobre, aadDelSecreto(TENANT, APP_ID))).toBe(SECRETO_NUEVO);
    });
  });

  describe("el sitio y la comprobación de la app", () => {
    it.each(["http://claimmix.example.com", "claimmix.example.com", "ftp://claimmix.example.com"])(
      "con el sitio «%s» (no es https) no hay dirección para el webhook: `meta`, sin llamar a Meta",
      async (sitio) => {
        vi.stubEnv("NEXT_PUBLIC_SITE_URL", sitio);
        expect(await credencialesDeApp(QUIEN, CREDENCIALES)).toEqual({ resultado: "meta" });
        expect(h.warn).toHaveBeenCalledWith({}, "alta.app_sin_sitio_https");
        expect(h.leerApp).not.toHaveBeenCalled();
        expect(h.almacen.guardar).not.toHaveBeenCalled();
      }
    );

    it.each<[string, ReturnType<typeof falla>, ResultadoDeApp]>([
      ["un 4xx es el secreto mal puesto", falla("rechazo", 190), "app_invalida"],
      ["un rechazo sin código también", falla("rechazo"), "app_invalida"],
      ["pedir esperar se pasa tal cual", falla("esperar", 4), "esperar"],
      ["una respuesta rara de Meta", falla("meta"), "meta"],
    ])("%s", async (_nombre, respuesta, esperado) => {
      h.leerApp.mockResolvedValue(respuesta);
      expect(await credencialesDeApp(QUIEN, CREDENCIALES)).toEqual({ resultado: esperado });
      expect(h.almacen.guardar).not.toHaveBeenCalled();
      sinEscribirEnLaApp();
    });
  });

  describe("el callback que la app ya tiene", () => {
    it("ajeno: no se escribe nada en la app del cliente (R2) y los datos legales quedan sin completar", async () => {
      h.leerApp.mockResolvedValue(ok("ajeno"));
      expect(await credencialesDeApp(QUIEN, CREDENCIALES)).toEqual({ resultado: "listo" });
      sinEscribirEnLaApp();
      expect(h.almacen.guardar).toHaveBeenCalledWith("app_credenciales", expect.objectContaining({ datos_app: false }));
    });

    it("ninguno: se completan los datos legales y se deja el webhook", async () => {
      h.leerApp.mockResolvedValue(ok("ninguno"));
      await credencialesDeApp(QUIEN, CREDENCIALES);
      expect(h.fijarDatos).toHaveBeenCalledTimes(1);
      expect(h.suscribirWebhook).toHaveBeenCalledTimes(1);
    });

    it.each(["nuestro", "desconocido"])("%s: se completan los datos legales pero no se toca el webhook", async (valor) => {
      h.leerApp.mockResolvedValue(ok(valor));
      await credencialesDeApp(QUIEN, CREDENCIALES);
      expect(h.fijarDatos).toHaveBeenCalledTimes(1);
      expect(h.suscribirWebhook).not.toHaveBeenCalled();
    });

    it("si la base no deja guardar no se escribe nada en la app, y se traduce lo que dijo", async () => {
      h.almacen.guardar.mockResolvedValue("app_ocupada");
      expect(await credencialesDeApp(QUIEN, CREDENCIALES)).toEqual({ resultado: "app_ocupada" });
      expect(h.suscribirWebhook).not.toHaveBeenCalled();
    });

    it.each<[string, ResultadoDeApp]>([
      ["de_la_plataforma", "app_de_la_plataforma"],
      ["app_ocupada", "app_ocupada"],
      ["otra_app", "otra_app"],
      ["transicion", "transicion"],
      ["apagado", "apagado"],
      ["webhook_pendiente", "webhook_pendiente"],
      ["ya_conectado", "ya_conectado"],
      ["error", "meta"],
    ])("si la base contesta «%s» se le dice a la persona «%s»", async (guardado, esperado) => {
      h.almacen.guardar.mockResolvedValue(guardado);
      expect(await credencialesDeApp(QUIEN, CREDENCIALES)).toEqual({ resultado: esperado });
    });
  });

  describe("los datos legales de la app (R15)", () => {
    const datosLegales = (valor: { terminos?: string | null; privacidad?: string | null; contacto?: string | null }) =>
      h.leerDatos.mockResolvedValue(ok({ terminos: null, privacidad: null, contacto: null, ...valor }));
    const guardadoCon = (datos: boolean) =>
      expect(h.almacen.guardar).toHaveBeenCalledWith("app_credenciales", expect.objectContaining({ datos_app: datos }));

    it("con los tres ya cargados no escribe nada y cuentan como completos", async () => {
      datosLegales({ terminos: "https://t.example.com", privacidad: "https://p.example.com", contacto: "otro@example.com" });
      await credencialesDeApp(QUIEN, CREDENCIALES);
      expect(h.fijarDatos).not.toHaveBeenCalled();
      guardadoCon(true);
    });

    it("sólo completa los que Meta tiene vacíos y no pisa los del cliente", async () => {
      datosLegales({ terminos: "https://t.example.com" });
      await credencialesDeApp(QUIEN, CREDENCIALES);
      expect(h.fijarDatos).toHaveBeenCalledWith(expect.anything(), { privacidad: `${SITIO}/legal/${SLUG}/privacidad`, contacto: CORREO });
      guardadoCon(true);
    });

    it("sin correo de contacto en el espacio no se inventa uno, y los datos quedan incompletos", async () => {
      h.almacen.leer.mockResolvedValue(fila({ emailDeContacto: null }));
      await credencialesDeApp(QUIEN, CREDENCIALES);
      expect(h.fijarDatos).toHaveBeenCalledWith(expect.anything(), {
        terminos: `${SITIO}/legal/${SLUG}/terminos`,
        privacidad: `${SITIO}/legal/${SLUG}/privacidad`,
      });
      guardadoCon(false);
    });

    it("sin slug de las páginas legales sólo se completa el contacto, y los datos quedan incompletos", async () => {
      h.almacen.leer.mockResolvedValue(fila({ slugLegal: null }));
      await credencialesDeApp(QUIEN, CREDENCIALES);
      expect(h.fijarDatos).toHaveBeenCalledWith(expect.anything(), { contacto: CORREO });
      guardadoCon(false);
    });

    it("sin slug ni correo no hay nada que escribir: no se llama a Meta y quedan incompletos", async () => {
      h.almacen.leer.mockResolvedValue(fila({ slugLegal: null, emailDeContacto: null }));
      await credencialesDeApp(QUIEN, CREDENCIALES);
      expect(h.fijarDatos).not.toHaveBeenCalled();
      guardadoCon(false);
    });

    it("si el sitio no es https no hay páginas legales que dar (pero tampoco hay webhook: ya corta antes)", async () => {
      vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://claimmix.example.com");
      expect(await credencialesDeApp(QUIEN, CREDENCIALES)).toEqual({ resultado: "meta" });
      expect(h.fijarDatos).not.toHaveBeenCalled();
    });

    const sinDecirDatos = () => expect(h.almacen.guardar.mock.calls.at(-1)?.[1]).not.toHaveProperty("datos_app");

    it("si no se pueden leer no se escribe nada (R15) y el alta sigue; no se dice nada de los datos, así un éxito anterior no se pisa", async () => {
      h.leerDatos.mockResolvedValue(falla("rechazo", 10));
      expect(await credencialesDeApp(QUIEN, CREDENCIALES)).toEqual({ resultado: "listo" });
      expect(h.fijarDatos).not.toHaveBeenCalled();
      sinDecirDatos();
    });

    it.each(["esperar", "meta"] as const)("si Meta no contesta la lectura (%s) tampoco se dice nada de los datos", async (motivo) => {
      h.leerDatos.mockResolvedValue(falla(motivo));
      expect(await credencialesDeApp(QUIEN, CREDENCIALES)).toEqual({ resultado: "listo" });
      sinDecirDatos();
    });

    it("si no se pueden escribir se anota el motivo y el alta sigue, con los datos sin completar", async () => {
      h.fijarDatos.mockResolvedValue(falla("rechazo", 100));
      expect(await credencialesDeApp(QUIEN, CREDENCIALES)).toEqual({ resultado: "listo" });
      expect(h.warn).toHaveBeenCalledWith({ falla: "rechazo", codigo: 100 }, "alta.app_datos_no_se_cargaron");
      guardadoCon(false);
    });

    it("si algo tira en el medio no frena el alta: anota sólo el nombre del error", async () => {
      h.leerDatos.mockRejectedValue(new Error(`falló con ${SECRETO}`));
      expect(await credencialesDeApp(QUIEN, CREDENCIALES)).toEqual({ resultado: "listo" });
      expect(h.warn).toHaveBeenCalledWith({ error: "Error" }, "alta.app_datos_fallo");
      expect(registros()).not.toContain(SECRETO);
      sinDecirDatos();
    });
  });

  describe("dejar el webhook por API (hasta tres intentos)", () => {
    it("pide esperar dos veces: espera 1 s y luego 3 s, y a la tercera lo deja", async () => {
      vi.useFakeTimers();
      h.suscribirWebhook.mockResolvedValueOnce(ESPERAR).mockResolvedValueOnce(ESPERAR).mockResolvedValueOnce(ok(true));
      const hecho = credencialesDeApp(QUIEN, CREDENCIALES);

      await vi.advanceTimersByTimeAsync(0);
      expect(h.suscribirWebhook).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(h.suscribirWebhook).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.suscribirWebhook).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2999);
      expect(h.suscribirWebhook).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.suscribirWebhook).toHaveBeenCalledTimes(3);

      await expect(hecho).resolves.toEqual({ resultado: "listo" });
      expect(h.warn).not.toHaveBeenCalledWith(expect.anything(), "alta.app_webhook_no_se_dejo");
    });

    it("si Meta pide esperar las tres veces se anota y el alta sigue: el cliente lo pega a mano en P1B", async () => {
      vi.useFakeTimers();
      h.suscribirWebhook.mockResolvedValue(ESPERAR);
      const hecho = credencialesDeApp(QUIEN, CREDENCIALES);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(hecho).resolves.toEqual({ resultado: "listo" });
      expect(h.suscribirWebhook).toHaveBeenCalledTimes(3);
      expect(h.warn).toHaveBeenCalledWith({ falla: "esperar", codigo: 4 }, "alta.app_webhook_no_se_dejo");
    });

    it.each([
      ["un rechazo", falla("rechazo", 100)],
      ["una respuesta rara", falla("meta")],
    ])("%s no se reintenta: un solo intento, se anota y el alta sigue", async (_nombre, respuesta) => {
      h.suscribirWebhook.mockResolvedValue(respuesta);
      expect(await credencialesDeApp(QUIEN, CREDENCIALES)).toEqual({ resultado: "listo" });
      expect(h.suscribirWebhook).toHaveBeenCalledTimes(1);
      expect(h.warn).toHaveBeenCalledWith({ falla: respuesta.falla, codigo: respuesta.codigo }, "alta.app_webhook_no_se_dejo");
    });
  });

  it("lo inesperado no tira: vuelve `meta` y se anota sólo el nombre del error, sin el secreto", async () => {
    h.almacen.leer.mockRejectedValue(new Error(`falló con ${SECRETO}`));
    expect(await credencialesDeApp(QUIEN, CREDENCIALES)).toEqual({ resultado: "meta" });
    expect(h.error).toHaveBeenCalledWith({ error: "Error", donde: "app_credenciales" }, "alta.waba_fallo");
    expect(registros()).not.toContain(SECRETO);
  });

  it("si cerrar el secreto falla (falta la clave) no se guarda nada y vuelve `meta`", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRETS_KEY", "");
    expect(await credencialesDeApp(QUIEN, CREDENCIALES)).toEqual({ resultado: "apagado" });
    expect(h.almacen.guardar).not.toHaveBeenCalled();
  });
});

/* ── P1B: el webhook ──────────────────────────────────────────────────────── */

describe("webhookDeApp", () => {
  beforeEach(() => {
    h.almacen.leer.mockResolvedValue(fila({ appId: APP_ID, secreto: SECRETO }));
    h.leerApp.mockResolvedValue(ok("nuestro"));
  });

  it.each(["nuestro", "ninguno"])("con el callback «%s» devuelve la dirección y la marca, sin aviso", async (valor) => {
    h.leerApp.mockResolvedValue(ok(valor));
    expect(await webhookDeApp(QUIEN)).toEqual({
      resultado: "listo",
      webhook: { url: URL_WEBHOOK, verifyToken: derivar("wa-verify-app", RUTA), aviso: null },
    });
    expect(h.leerApp).toHaveBeenCalledWith({ appId: APP_ID, secreto: SECRETO }, URL_WEBHOOK);
  });

  it("la marca es siempre la misma para la misma ruta y distinta para otra, y no es la ruta", async () => {
    const primera = (await webhookDeApp(QUIEN)).webhook?.verifyToken;
    const segunda = (await webhookDeApp(QUIEN)).webhook?.verifyToken;
    expect(primera).toBe(segunda);
    h.almacen.leer.mockResolvedValue(fila({ appId: APP_ID, secreto: SECRETO, ruta: "fake-otra-ruta-0123456789" }));
    const otra = (await webhookDeApp(QUIEN)).webhook?.verifyToken;
    expect(otra).not.toBe(primera);
    expect(primera).not.toContain(RUTA);
    expect(primera).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
  });

  it("el callback «ajeno» da el aviso y se anota sólo el espacio; la dirección ajena nunca sale", async () => {
    h.leerApp.mockResolvedValue(ok("ajeno"));
    const respuesta = await webhookDeApp(QUIEN);
    expect(respuesta).toEqual({
      resultado: "listo",
      webhook: { url: URL_WEBHOOK, verifyToken: derivar("wa-verify-app", RUTA), aviso: "ajeno" },
    });
    expect(Object.keys(respuesta.webhook ?? {}).sort()).toEqual(["aviso", "url", "verifyToken"]);
    expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT }, "alta.app_ajena");
  });

  it.each([
    ["un callback desconocido", ok("desconocido")],
    ["Meta pidió esperar", falla("esperar", 4)],
    ["una respuesta rara de Meta", falla("meta")],
  ])("%s: no corta, avisa que hay que mirarlo", async (_nombre, respuesta) => {
    h.leerApp.mockResolvedValue(respuesta);
    expect(await webhookDeApp(QUIEN)).toEqual({
      resultado: "listo",
      webhook: { url: URL_WEBHOOK, verifyToken: derivar("wa-verify-app", RUTA), aviso: "revisar" },
    });
  });

  it("un 4xx de la app es el secreto mal puesto: `app_invalida` y no se devuelve ninguna dirección", async () => {
    h.leerApp.mockResolvedValue(falla("rechazo", 190));
    expect(await webhookDeApp(QUIEN)).toEqual({ resultado: "app_invalida" });
  });

  it("sirve también con el alta más avanzada", async () => {
    h.almacen.leer.mockResolvedValue(conectada());
    expect(await webhookDeApp(QUIEN)).toMatchObject({ resultado: "listo", webhook: { url: URL_WEBHOOK } });
  });

  it.each([
    ["sin fila", null, "apagado"],
    ["una alta cancelada", fila({ estado: "cancelada", appId: APP_ID, secreto: SECRETO }), "transicion"],
    ["una alta sin app cargada", fila(), "transicion"],
    ["una alta con la app pero sin su secreto abierto", fila({ appId: APP_ID, secreto: null }), "transicion"],
    ["una alta sin ruta", fila({ appId: APP_ID, secreto: SECRETO, ruta: null }), "transicion"],
  ] as const)("%s", async (_nombre, existente, esperado) => {
    h.almacen.leer.mockResolvedValue(existente);
    expect(await webhookDeApp(QUIEN)).toEqual({ resultado: esperado });
    expect(h.leerApp).not.toHaveBeenCalled();
  });

  it("una alta del popup de Meta no tiene webhook de app: `transicion`", async () => {
    vi.stubEnv("ALTA_WABA_PROPIA", "1");
    h.almacen.leer.mockResolvedValue(fila({ origen: "embedded_signup", estado: "vinculada", appId: APP_ID, secreto: SECRETO }));
    expect(await webhookDeApp(QUIEN)).toEqual({ resultado: "transicion" });
  });

  it("con la vía apagada no se llama a Meta", async () => {
    vi.stubEnv("ALTA_APP_PROPIA", "");
    expect(await webhookDeApp(QUIEN)).toEqual({ resultado: "apagado" });
    expect(h.leerApp).not.toHaveBeenCalled();
  });

  it("con un sitio que no es https no hay dirección: `meta`, sin llamar a Meta", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "http://claimmix.example.com");
    expect(await webhookDeApp(QUIEN)).toEqual({ resultado: "meta" });
    expect(h.warn).toHaveBeenCalledWith({}, "alta.app_sin_sitio_https");
    expect(h.leerApp).not.toHaveBeenCalled();
  });

  it("sin la clave con que se arma la marca no hay webhook: `meta`, se anota y no se llama a Meta", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    expect(await webhookDeApp(QUIEN)).toEqual({ resultado: "meta" });
    expect(h.error).toHaveBeenCalledWith({}, "alta.app_sin_marca_de_webhook");
    expect(h.leerApp).not.toHaveBeenCalled();
  });

  it("no escribe nada en la base", async () => {
    await webhookDeApp(QUIEN);
    expect(h.almacen.guardar).not.toHaveBeenCalled();
  });
});

/* ── P2: el token ─────────────────────────────────────────────────────────── */

describe("tokenDeApp", () => {
  beforeEach(() => {
    h.almacen.leer.mockResolvedValue(conApp());
  });

  const sinGuardar = () => {
    expect(h.almacen.guardar).not.toHaveBeenCalled();
    expect(h.continuar).not.toHaveBeenCalled();
  };

  describe("con el alta en curso (se saca la WABA y el número del token)", () => {
    it("camino feliz: revisa el token, recorre la WABA, lee el número, lo guarda todo cerrado y sigue", async () => {
      expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "listo" });

      expect(h.revisarToken).toHaveBeenCalledWith(TOKEN, { appId: APP_ID, secreto: SECRETO });
      expect(h.recorrer).toHaveBeenCalledWith(WABA, "id,display_phone_number", TOKEN, undefined, PRUEBA);
      expect(h.datosNumero).toHaveBeenCalledWith(TOKEN, ID, PRUEBA);
      expect(h.otroAmbiente).toHaveBeenCalledWith(ID, NUMERO);
      expect(h.almacen.guardar).toHaveBeenCalledTimes(1);
      expect(h.almacen.guardar).toHaveBeenCalledWith("vincular", {
        waba_id: WABA,
        phone_number_id: ID,
        numero_meta: NUMERO,
        token_cifrado: expect.any(String),
        pin_cifrado: expect.any(String),
      });
      expect(h.continuar).toHaveBeenCalledWith(TENANT, h.almacen);
      expect(h.almacen.guardar.mock.invocationCallOrder[0]).toBeLessThan(h.continuar.mock.invocationCallOrder[0]);
    });

    it("el token y el PIN se guardan cerrados con su AAD, y el PIN es de seis dígitos", async () => {
      await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN);
      const { token_cifrado: token, pin_cifrado: pin } = h.almacen.guardar.mock.calls[0][1];
      expect(token).not.toContain(TOKEN);
      // El token y el PIN no llevan sobre versionado: abren con `descifrar` y su AAD, y con ningún otro.
      const { descifrar } = await import("@/lib/security/cifrado");
      expect(descifrar(token, "Invalid encrypted payload", aadDelToken(TENANT, WABA))).toBe(TOKEN);
      expect(() => descifrar(token, "Invalid encrypted payload", aadDelToken(OTRO_TENANT, WABA))).toThrow();
      expect(() => descifrar(token, "Invalid encrypted payload", aadDelToken(TENANT, OTRA_WABA))).toThrow();
      const claro = descifrar(pin, "Invalid encrypted payload", aadDelPin(TENANT, WABA));
      expect(claro).toMatch(/^\d{6}$/);
      expect(() => descifrar(pin, "Invalid encrypted payload", aadDelPin(OTRO_TENANT, WABA))).toThrow();
    });

    it("el rubro que eligió el cliente viaja a vincular, y sin rubro no viaja la clave", async () => {
      await tokenDeApp(QUIEN, { ...PEDIDO_DE_TOKEN, categoria: "HEALTH" });
      expect(h.almacen.guardar).toHaveBeenCalledWith("vincular", expect.objectContaining({ categoria_perfil: "HEALTH" }));

      h.almacen.guardar.mockClear();
      await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN);
      expect(h.almacen.guardar.mock.calls[0][1]).not.toHaveProperty("categoria_perfil");
    });

    it("recorta los bordes del token", async () => {
      expect(await tokenDeApp(QUIEN, { token: ` ${TOKEN}\n`, wabaId: ` ${WABA} ` })).toEqual({ resultado: "listo" });
      expect(h.revisarToken).toHaveBeenCalledWith(TOKEN, expect.anything());
      expect(h.recorrer).toHaveBeenCalledWith(WABA, expect.anything(), TOKEN, undefined, PRUEBA);
    });

    it("lo que dice el cliente de la WABA y del número no se usa sin que Meta lo confirme", async () => {
      h.revisarToken.mockResolvedValue({ ok: true, usuarioId: "900", wabaIds: [OTRA_WABA] });
      expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "waba_invalida" });
      expect(h.recorrer).not.toHaveBeenCalled();
      sinGuardar();
    });

    it.each<[string, { token: string; wabaId: string }, ResultadoDeApp]>([
      ["un token vacío", { token: "", wabaId: WABA }, "token_formato"],
      ["un token con un espacio adentro", { token: "fake token", wabaId: WABA }, "token_formato"],
      ["un token con una barra vertical", { token: "fake|token", wabaId: WABA }, "token_formato"],
      ["un token de más de 2048 caracteres", { token: "a".repeat(2049), wabaId: WABA }, "token_formato"],
      ["un WABA ID con letras", { token: TOKEN, wabaId: "abc" }, "waba_formato"],
      ["un WABA ID vacío", { token: TOKEN, wabaId: "" }, "waba_formato"],
    ])("%s: se corta antes de hablar con Meta", async (_nombre, pedido, esperado) => {
      expect(await tokenDeApp(QUIEN, pedido)).toEqual({ resultado: esperado });
      expect(h.revisarToken).not.toHaveBeenCalled();
      sinGuardar();
    });

    it.each([
      ["sin fila", null, "apagado"],
      ["una alta cancelada", fila({ estado: "cancelada", appId: APP_ID, secreto: SECRETO }), "transicion"],
      ["sin app cargada", fila(), "transicion"],
      ["con la app pero sin su secreto abierto", fila({ appId: APP_ID, secreto: null }), "transicion"],
      ["vinculada: ya tiene su número", conApp({ estado: "vinculada", numeroMeta: NUMERO }), "transicion"],
      ["vinculada con otro número que la persona ya aceptó", conApp({ estado: "vinculada", numeroMeta: OTRO_NUMERO, numeroAceptado: true }), "transicion"],
      ["suscripta", conApp({ estado: "suscripta" }), "transicion"],
      ["esperando el código", conApp({ estado: "falta_codigo" }), "transicion"],
      ["esperando el PIN", conApp({ estado: "falta_pin" }), "transicion"],
      ["caída por el nombre rechazado", nombreRechazado(), "transicion"],
    ] as const)("%s", async (_nombre, existente, esperado) => {
      h.almacen.leer.mockResolvedValue(existente);
      expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: esperado });
      expect(h.revisarToken).not.toHaveBeenCalled();
      sinGuardar();
    });

    it("con la vía apagada no se llama a Meta", async () => {
      vi.stubEnv("ALTA_APP_PROPIA", "");
      expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "apagado" });
      expect(h.revisarToken).not.toHaveBeenCalled();
    });

    describe("lo que el token dice de sí mismo", () => {
      it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
        ["token vencido", { motivo: "token_vencido" }, { resultado: "token_vencido" }],
        ["token de otra app", { motivo: "token_de_otra_app" }, { resultado: "token_de_otra_app" }],
        ["token temporal", { motivo: "token_temporal" }, { resultado: "token_temporal" }],
        ["la app que no es", { motivo: "app_invalida" }, { resultado: "app_invalida" }],
        ["un rechazo de Meta es el secreto mal puesto", { motivo: "rechazo", codigo: 190 }, { resultado: "app_invalida" }],
        ["Meta pidió esperar", { motivo: "esperar", codigo: 4 }, { resultado: "esperar" }],
        ["una respuesta rara de Meta", { motivo: "meta", codigo: null }, { resultado: "meta" }],
        [
          "falta un permiso",
          { motivo: "falta_permiso", permiso: "whatsapp_business_messaging" },
          { resultado: "falta_permiso", permiso: "whatsapp_business_messaging" },
        ],
        ["falta un permiso con un nombre que Meta no podría tener", { motivo: "falta_permiso", permiso: "<b>x</b>" }, { resultado: "falta_permiso" }],
        [
          "sobran permisos: sólo pasan los que tienen forma de nombre",
          { motivo: "permisos_de_mas", permisos: ["ads_management", "<script>", "business_management", "Con Espacio"] },
          { resultado: "permisos_de_mas", permisos: ["ads_management", "business_management"] },
        ],
      ])("%s", async (_nombre, revision, esperado) => {
        h.revisarToken.mockResolvedValue({ ok: false, ...revision });
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual(esperado);
        expect(h.recorrer).not.toHaveBeenCalled();
        sinGuardar();
      });

      it("de los permisos de más se devuelven veinte como mucho", async () => {
        const muchos = Array.from({ length: 30 }, (_, i) => `permiso_${String.fromCharCode(97 + (i % 26))}${"x".repeat(i % 3)}`);
        const unicos = [...new Set(muchos)].map((p) => p.replace(/[^a-z_]/g, "q")).slice(0, 30);
        h.revisarToken.mockResolvedValue({ ok: false, motivo: "permisos_de_mas", permisos: unicos });
        const { permisos } = await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN);
        expect(permisos).toHaveLength(20);
      });
    });

    describe("la WABA", () => {
      it("la de la plataforma no se asigna a nadie", async () => {
        h.revisarToken.mockResolvedValue({ ok: true, usuarioId: "900", wabaIds: [WABA_PLATAFORMA] });
        expect(await tokenDeApp(QUIEN, { token: TOKEN, wabaId: WABA_PLATAFORMA })).toEqual({ resultado: "de_la_plataforma" });
        expect(h.recorrer).not.toHaveBeenCalled();
        sinGuardar();
      });

      it.each<[string, string[] | null, ResultadoDeApp]>([
        ["Meta dice que el token llega a esta WABA", [WABA, OTRA_WABA], "listo"],
        ["Meta no dijo a qué cuentas llega el token: lo confirma el recorrido", null, "listo"],
        ["Meta dice que el token llega a otras WABAs pero no a ésta (R24)", [OTRA_WABA], "waba_invalida"],
        ["Meta dice que el token no llega a ninguna WABA", [], "waba_invalida"],
      ])("%s", async (_nombre, wabaIds, esperado) => {
        h.revisarToken.mockResolvedValue({ ok: true, usuarioId: "900", wabaIds });
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: esperado });
        if (esperado !== "listo") expect(h.recorrer).not.toHaveBeenCalled();
      });

      it("si no se pueden listar sus números, el código de Graph del propio recorrido dice por qué", async () => {
        h.recorrer.mockResolvedValue(falla("rechazo", 100));
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "waba_invalida" });
        expect(h.recorrer).toHaveBeenCalledWith(WABA, "id,display_phone_number", TOKEN, undefined, PRUEBA);
        // No se vuelve a preguntar a Meta por la salud: el recorrido ya trae el motivo.
        expect(h.leerSalud).not.toHaveBeenCalled();
        sinGuardar();
      });

      it.each<[string, ReturnType<typeof falla>, ResultadoDeApp]>([
        ["la WABA no existe (100)", falla("rechazo", 100), "waba_invalida"],
        ["la WABA no está asignada al usuario (200)", falla("rechazo", 200), "waba_no_asignada"],
        ["el token no sirve (190)", falla("rechazo", 190), "token_vencido"],
        ["pago pendiente", falla("rechazo", 131042), "pago_pendiente"],
        ["WABA restringida", falla("rechazo", 368), "waba_restringida"],
        ["un código que se espera (4)", falla("rechazo", 4), "esperar"],
        ["Meta pidió esperar", falla("esperar", 4), "esperar"],
        ["un código que no se reconoce", falla("rechazo", 999), "meta"],
        ["una respuesta rara", falla("meta"), "meta"],
        ["Graph no dijo qué pasó (4xx sin código)", falla("rechazo"), "meta"],
      ])("sin lista de números: %s", async (_nombre, recorrido, esperado) => {
        h.recorrer.mockResolvedValue(recorrido);
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: esperado });
        sinGuardar();
      });
    });

    describe("elegir el número", () => {
      const lista = (filas: { id: string | null; display: string | null }[], completa = true) =>
        h.recorrer.mockResolvedValue(ok({ filas: filas.map((f) => ({ ...f, nombre: null })), completa }));

      it("el que el cliente eligió, si está en la WABA", async () => {
        lista([
          { id: ID, display: DISPLAY },
          { id: ID_2, display: OTRO_DISPLAY },
        ]);
        h.datosNumero.mockResolvedValue(datosDelNumero({ display: OTRO_DISPLAY }));
        expect(await tokenDeApp(QUIEN, { ...PEDIDO_DE_TOKEN, phoneNumberId: ID_2 })).toEqual({ resultado: "numero_distinto", numeroMeta: OTRO_NUMERO });
        expect(h.datosNumero).toHaveBeenCalledWith(TOKEN, ID_2, PRUEBA);
      });

      it("el que el cliente tipeó, si hay varios y sólo uno coincide", async () => {
        lista([
          { id: ID_2, display: OTRO_DISPLAY },
          { id: ID, display: DISPLAY },
        ]);
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "listo" });
        expect(h.datosNumero).toHaveBeenCalledWith(TOKEN, ID, PRUEBA);
      });

      it("el único de la WABA, si la lista está completa, aunque no sea el que tipeó (después se confirma)", async () => {
        lista([{ id: ID_2, display: OTRO_DISPLAY }]);
        h.datosNumero.mockResolvedValue(datosDelNumero({ display: OTRO_DISPLAY }));
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "numero_distinto", numeroMeta: OTRO_NUMERO });
      });

      it("«Elegir otro» de E5: con otro número sin aceptar vuelve a vincular el que se pegue, sin soltar la cuenta", async () => {
        h.almacen.leer.mockResolvedValue(conApp({ estado: "vinculada", wabaId: WABA, phoneNumberId: ID_2, numeroMeta: OTRO_NUMERO }));
        lista([{ id: ID, display: DISPLAY }]);

        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "listo" });

        expect(h.almacen.guardar).toHaveBeenCalledWith("vincular", expect.objectContaining({ phone_number_id: ID, numero_meta: NUMERO }));
        expect(h.almacen.guardar).not.toHaveBeenCalledWith("desconectar", expect.anything());
      });

      it("uno de los dos que se pidió por id que no está en la WABA no cuenta: se elige por las otras reglas", async () => {
        lista([{ id: ID, display: DISPLAY }]);
        expect(await tokenDeApp(QUIEN, { ...PEDIDO_DE_TOKEN, phoneNumberId: ID_2 })).toEqual({ resultado: "listo" });
        expect(h.datosNumero).toHaveBeenCalledWith(TOKEN, ID, PRUEBA);
      });

      it("un id pedido con forma rara se ignora", async () => {
        lista([{ id: ID, display: DISPLAY }]);
        expect(await tokenDeApp(QUIEN, { ...PEDIDO_DE_TOKEN, phoneNumberId: "no es un id" })).toEqual({ resultado: "listo" });
      });

      it("varios y ninguno coincide: la persona elige entre los de la WABA (con su id y su número)", async () => {
        lista([
          { id: ID, display: OTRO_DISPLAY },
          { id: ID_2, display: "+54 9 11 5555-0000" },
        ]);
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({
          resultado: "elegir_numero",
          numeros: [
            { id: ID, display: OTRO_DISPLAY },
            { id: ID_2, display: "+54 9 11 5555-0000" },
          ],
        });
        expect(h.datosNumero).not.toHaveBeenCalled();
        sinGuardar();
      });

      it("varios coinciden con el tipeado: también elige la persona", async () => {
        lista([
          { id: ID, display: DISPLAY },
          { id: ID_2, display: "+54 9 11 1234 5678" },
        ]);
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toMatchObject({ resultado: "elegir_numero" });
      });

      it("a elegir se ofrecen veinte como mucho, y sin los que no traen id o número", async () => {
        lista([
          { id: null, display: DISPLAY },
          { id: ID_2, display: null },
          ...Array.from({ length: 25 }, (_, i) => ({ id: `1000000000009${String(i).padStart(2, "0")}`, display: `+54 9 11 6000-00${String(i).padStart(2, "0")}` })),
        ]);
        const { resultado, numeros } = await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN);
        expect(resultado).toBe("elegir_numero");
        expect(numeros).toHaveLength(20);
        expect(numeros?.some((n) => n.id === ID_2)).toBe(false);
      });

      it("con la lista incompleta sólo se elige por id o por coincidencia: si no, `meta`", async () => {
        lista([{ id: ID_2, display: OTRO_DISPLAY }], false);
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "meta" });
        lista(
          [
            { id: ID_2, display: OTRO_DISPLAY },
            { id: ID, display: DISPLAY },
          ],
          false
        );
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "listo" });
      });

      it("una WABA sin números es `sin_numero`; con la lista incompleta no se sabe: `meta`", async () => {
        lista([]);
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "sin_numero" });
        lista([], false);
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "meta" });
        sinGuardar();
      });

      it("el número de la plataforma no se asigna a nadie", async () => {
        lista([{ id: ID_PLATAFORMA, display: DISPLAY }]);
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "de_la_plataforma" });
        expect(h.datosNumero).not.toHaveBeenCalled();
        sinGuardar();
      });
    });

    describe("el número", () => {
      it.each<[string, ReturnType<typeof falla>, ResultadoDeApp]>([
        ["el token no sirve (190)", falla("rechazo", 190), "token_vencido"],
        ["sesión inválida (102)", falla("rechazo", 102), "token_vencido"],
        ["un código que se espera (4)", falla("rechazo", 4), "esperar"],
        ["Meta pidió esperar", falla("esperar", 4), "esperar"],
        ["pago pendiente", falla("rechazo", 131042), "pago_pendiente"],
        ["un código que no se reconoce", falla("rechazo", 100), "meta"],
        ["una respuesta rara", falla("meta"), "meta"],
      ])("al leerlo: %s", async (_nombre, respuesta, esperado) => {
        h.datosNumero.mockResolvedValue(respuesta);
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: esperado });
        sinGuardar();
      });

      it("un 190 se confirma con la app: si rechaza su secreto es `app_invalida` (E7) y no el token vencido", async () => {
        h.datosNumero.mockResolvedValue(falla("rechazo", 190));
        h.leerApp.mockResolvedValue(falla("rechazo", 190));
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "app_invalida" });
        expect(h.leerApp).toHaveBeenCalledWith({ appId: APP_ID, secreto: SECRETO }, URL_WEBHOOK);
        sinGuardar();
      });

      it("un 190 con la app sana es el token vencido", async () => {
        h.datosNumero.mockResolvedValue(falla("rechazo", 190));
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "token_vencido" });
        expect(h.leerApp).toHaveBeenCalledTimes(1);
      });

      it("un 190 con subcódigo 467 es el token vencido sin preguntarle a la app", async () => {
        h.datosNumero.mockResolvedValue({ ...falla("rechazo", 190), subcodigo: 467 });
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "token_vencido" });
        expect(h.leerApp).not.toHaveBeenCalled();
      });

      it("131031 se confirma con la salud: BLOCKED es `waba_bloqueada`, sin bloqueo es `meta`", async () => {
        h.datosNumero.mockResolvedValue(falla("rechazo", 131031));
        h.leerSalud.mockResolvedValue(ok({ puedeEnviar: "BLOCKED", motivos: [] }));
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "waba_bloqueada" });
        h.leerSalud.mockResolvedValue(ok({ puedeEnviar: "AVAILABLE", motivos: [] }));
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "meta" });
        sinGuardar();
      });

      it("uno que está en la app de WhatsApp Business (coexistencia) no sirve", async () => {
        h.datosNumero.mockResolvedValue(datosDelNumero({ enLaApp: true }));
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "coexistencia" });
        sinGuardar();
      });

      it("uno que Meta informa con un formato que no es un número: `meta`", async () => {
        h.datosNumero.mockResolvedValue(datosDelNumero({ display: "no es un número" }));
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "meta" });
        sinGuardar();
      });

      it("uno que es de otro ambiente se mira a mano: la persona ve «revision» y el operador recibe el aviso", async () => {
        h.otroAmbiente.mockReturnValue(true);
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "revision" });
        expect(h.aviso).toHaveBeenCalledWith("de_otro_ambiente", TENANT);
        sinGuardar();
      });

      it("uno distinto al tipeado se guarda igual y se pide confirmarlo (E5), sin seguir", async () => {
        h.datosNumero.mockResolvedValue(datosDelNumero({ display: OTRO_DISPLAY }));
        h.recorrer.mockResolvedValue(ok({ filas: [{ id: ID, display: OTRO_DISPLAY, nombre: null }], completa: true }));
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "numero_distinto", numeroMeta: OTRO_NUMERO });
        expect(h.almacen.guardar).toHaveBeenCalledWith("vincular", expect.objectContaining({ numero_meta: OTRO_NUMERO }));
        expect(h.continuar).not.toHaveBeenCalled();
      });

      it("el mismo número escrito sin el 9 de los celulares argentinos es el mismo", async () => {
        h.almacen.leer.mockResolvedValue(conApp({ numeroTipeado: "+541112345678" }));
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "listo" });
      });

      it("si el cliente no tipeó número (es opcional) no hay con qué comparar: se sigue sin abrir E5", async () => {
        h.almacen.leer.mockResolvedValue(conApp({ numeroTipeado: null }));
        h.datosNumero.mockResolvedValue(datosDelNumero({ display: OTRO_DISPLAY }));
        h.recorrer.mockResolvedValue(ok({ filas: [{ id: ID, display: OTRO_DISPLAY, nombre: null }], completa: true }));
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: "listo" });
        expect(h.continuar).toHaveBeenCalled();
      });
    });

    describe("el PIN", () => {
      const pinGuardado = async () => {
        const { descifrar } = await import("@/lib/security/cifrado");
        return descifrar(h.almacen.guardar.mock.calls.at(-1)?.[1].pin_cifrado, "Invalid encrypted payload", aadDelPin(TENANT, WABA));
      };

      it("si la misma WABA se vuelve a vincular se conserva el PIN que ya tenía (el número registrado lo exige idéntico)", async () => {
        h.almacen.leer.mockResolvedValue(conApp({ wabaId: WABA, pin: PIN_VIEJO }));
        await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN);
        expect(await pinGuardado()).toBe(PIN_VIEJO);
      });

      it("si es otra WABA se estrena uno nuevo", async () => {
        h.almacen.leer.mockResolvedValue(conApp({ wabaId: OTRA_WABA, pin: PIN_VIEJO }));
        const pines = new Set<string>();
        for (let i = 0; i < 4; i++) {
          await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN);
          pines.add(await pinGuardado());
        }
        for (const pin of pines) expect(pin).toMatch(/^\d{6}$/);
        expect([...pines].some((p) => p !== PIN_VIEJO)).toBe(true);
      });
    });

    describe("lo que contesta la base y el final del camino", () => {
      it.each<[string, ResultadoDeApp]>([
        ["numero_ocupado", "numero_ocupado"],
        ["id_ocupado", "numero_ocupado"],
        ["de_la_plataforma", "de_la_plataforma"],
        ["cupo", "cupo"],
        ["transicion", "transicion"],
        ["apagado", "apagado"],
        ["otra_app", "otra_app"],
        ["no_aplica", "revision"],
        ["error", "meta"],
      ])("si la base contesta «%s» se le dice a la persona «%s» y no se sigue", async (guardado, esperado) => {
        h.almacen.guardar.mockResolvedValue(guardado);
        expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado: esperado });
        expect(h.continuar).not.toHaveBeenCalled();
      });

      it.each<ResultadoDeApp>(["listo", "esperar", "numero_ocupado", "vencido", "falta_codigo", "meta"])(
        "lo que contesta `continuarWaba` («%s») vuelve tal cual",
        async (resultado) => {
          h.continuar.mockResolvedValue(resultado);
          expect(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)).toEqual({ resultado });
        }
      );
    });
  });

  describe("con el número ya conectado (E6): sólo cambia el token", () => {
    const CONECTADO = () => conectada();
    const PEDIDO_E6 = { token: TOKEN, wabaId: "no se usa" };

    beforeEach(() => {
      h.almacen.leer.mockResolvedValue(CONECTADO());
      h.revisarToken.mockResolvedValue({ ok: true, usuarioId: "900", wabaIds: [WABA] });
    });

    it("camino feliz: confirma que el número sigue en la WABA y guarda sólo el token, cerrado", async () => {
      expect(await tokenDeApp(QUIEN, PEDIDO_E6)).toEqual({ resultado: "listo" });
      expect(h.estaEnLaWaba).toHaveBeenCalledWith(WABA, ID, TOKEN, PRUEBA);
      expect(h.almacen.guardar).toHaveBeenCalledTimes(1);
      expect(h.almacen.guardar).toHaveBeenCalledWith("app_token", { token_cifrado: expect.any(String) });
      const { descifrar } = await import("@/lib/security/cifrado");
      const sobre = h.almacen.guardar.mock.calls[0][1].token_cifrado as string;
      expect(sobre).not.toContain(TOKEN);
      expect(descifrar(sobre, "Invalid encrypted payload", aadDelToken(TENANT, WABA))).toBe(TOKEN);
      expect(() => descifrar(sobre, "Invalid encrypted payload", aadDelToken(OTRO_TENANT, WABA))).toThrow();
    });

    it("el WABA ID del pedido no se usa: manda el de la fila, y la forma de uno cualquiera no corta", async () => {
      expect(await tokenDeApp(QUIEN, { token: TOKEN, wabaId: OTRA_WABA })).toEqual({ resultado: "listo" });
      expect(h.estaEnLaWaba).toHaveBeenCalledWith(WABA, ID, TOKEN, PRUEBA);
      expect(h.revisarToken).toHaveBeenCalledWith(TOKEN, { appId: APP_ID, secreto: SECRETO });
    });

    it("no vuelve a elegir número, no lo registra ni sigue el camino", async () => {
      await tokenDeApp(QUIEN, PEDIDO_E6);
      for (const nunca of [h.recorrer, h.datosNumero, h.continuar, h.leerSalud, h.otroAmbiente]) expect(nunca).not.toHaveBeenCalled();
    });

    it("también con el número suspendido por el operador", async () => {
      h.almacen.leer.mockResolvedValue(conectada({ numeroEstado: "suspendido" }));
      expect(await tokenDeApp(QUIEN, PEDIDO_E6)).toEqual({ resultado: "listo" });
    });

    it("también cuando cayó por el token vencido, que es justo para lo que sirve", async () => {
      h.almacen.leer.mockResolvedValue(conectada({ estado: "falla", falla: "token_vencido" }));
      expect(await tokenDeApp(QUIEN, PEDIDO_E6)).toEqual({ resultado: "listo" });
      expect(h.almacen.guardar).toHaveBeenCalledWith("app_token", expect.any(Object));
    });

    describe("el token venció armando el alta (el número sigue pedido)", () => {
      const ARMANDO = () => conectada({ estado: "falla", falla: "token_vencido", numeroEstado: "pedido", pin: null });

      it("guarda el token y sigue el camino con `continuarWaba`: no queda dando vueltas en E6", async () => {
        h.almacen.leer.mockResolvedValue(ARMANDO());
        h.continuar.mockResolvedValue("falta_codigo");
        expect(await tokenDeApp(QUIEN, PEDIDO_E6)).toEqual({ resultado: "falta_codigo" });
        expect(h.almacen.guardar).toHaveBeenCalledWith("app_token", { token_cifrado: expect.any(String) });
        expect(h.continuar).toHaveBeenCalledTimes(1);
        expect(h.almacen.guardar.mock.invocationCallOrder[0]).toBeLessThan(h.continuar.mock.invocationCallOrder[0]);
      });

      it("si la base no deja guardar el token no se sigue el camino", async () => {
        h.almacen.leer.mockResolvedValue(ARMANDO());
        h.almacen.guardar.mockResolvedValue("transicion");
        expect(await tokenDeApp(QUIEN, PEDIDO_E6)).toEqual({ resultado: "transicion" });
        expect(h.continuar).not.toHaveBeenCalled();
      });

      it("sin id de número no hay de dónde seguir: `transicion`", async () => {
        h.almacen.leer.mockResolvedValue(conectada({ estado: "falla", falla: "token_vencido", numeroEstado: "pedido", phoneNumberId: null }));
        expect(await tokenDeApp(QUIEN, PEDIDO_E6)).toEqual({ resultado: "transicion" });
        expect(h.continuar).not.toHaveBeenCalled();
        sinGuardar();
      });

      it("una conectada con el número pedido (no es una falla) sigue siendo `transicion`", async () => {
        h.almacen.leer.mockResolvedValue(conectada({ numeroEstado: "pedido" }));
        expect(await tokenDeApp(QUIEN, PEDIDO_E6)).toEqual({ resultado: "transicion" });
        expect(h.continuar).not.toHaveBeenCalled();
      });
    });

    it.each([
      ["el número no está conectado", { numeroEstado: "pedido" }],
      ["no hay fila de número", { numeroEstado: null }],
      ["el número fue dado de baja", { numeroEstado: "baja" }],
      ["no tiene el id del número", { phoneNumberId: null }],
      ["no tiene la WABA", { wabaId: null }],
    ])("%s: `transicion`", async (_nombre, cambios) => {
      h.almacen.leer.mockResolvedValue(conectada(cambios));
      expect(await tokenDeApp(QUIEN, PEDIDO_E6)).toEqual({ resultado: "transicion" });
      expect(h.revisarToken).not.toHaveBeenCalled();
      sinGuardar();
    });

    it("el formato del token se revisa igual", async () => {
      expect(await tokenDeApp(QUIEN, { token: "fake token", wabaId: WABA })).toEqual({ resultado: "token_formato" });
      sinGuardar();
    });

    it("lo que el token dice de sí mismo corta igual (token de otra app, permisos que faltan)", async () => {
      h.revisarToken.mockResolvedValue({ ok: false, motivo: "token_de_otra_app" });
      expect(await tokenDeApp(QUIEN, PEDIDO_E6)).toEqual({ resultado: "token_de_otra_app" });
      h.revisarToken.mockResolvedValue({ ok: false, motivo: "falta_permiso", permiso: "whatsapp_business_management" });
      expect(await tokenDeApp(QUIEN, PEDIDO_E6)).toEqual({ resultado: "falta_permiso", permiso: "whatsapp_business_management" });
      sinGuardar();
    });

    it("un token que no llega a la WABA de la fila es `waba_invalida`, sin tocar nada", async () => {
      h.revisarToken.mockResolvedValue({ ok: true, usuarioId: "900", wabaIds: [OTRA_WABA] });
      expect(await tokenDeApp(QUIEN, PEDIDO_E6)).toEqual({ resultado: "waba_invalida" });
      expect(h.estaEnLaWaba).not.toHaveBeenCalled();
      sinGuardar();
    });

    it("la WABA de la fila no puede ser la de la plataforma", async () => {
      h.almacen.leer.mockResolvedValue(conectada({ wabaId: WABA_PLATAFORMA }));
      expect(await tokenDeApp(QUIEN, PEDIDO_E6)).toEqual({ resultado: "de_la_plataforma" });
      sinGuardar();
    });

    it.each<[string, boolean | null, ResultadoDeApp]>([
      ["Meta no contestó", null, "meta"],
      ["el número ya no está en la WABA", false, "waba_invalida"],
    ])("al confirmar el número: %s", async (_nombre, esta, esperado) => {
      h.estaEnLaWaba.mockResolvedValue(esta);
      expect(await tokenDeApp(QUIEN, PEDIDO_E6)).toEqual({ resultado: esperado });
      sinGuardar();
    });

    it.each<[string, ResultadoDeApp]>([
      ["cupo", "cupo"],
      ["transicion", "transicion"],
      ["apagado", "apagado"],
      ["error", "meta"],
    ])("si la base contesta «%s» se le dice a la persona «%s»", async (guardado, esperado) => {
      h.almacen.guardar.mockResolvedValue(guardado);
      expect(await tokenDeApp(QUIEN, PEDIDO_E6)).toEqual({ resultado: esperado });
    });

    it("la prueba de la firma sale del token nuevo, no del viejo", async () => {
      await tokenDeApp(QUIEN, PEDIDO_E6);
      expect(h.estaEnLaWaba.mock.calls[0][3]).toBe(PRUEBA);
      expect(h.estaEnLaWaba.mock.calls[0][3]).not.toBe(PRUEBA_VIEJA);
    });
  });
});

/* ── E10: el nombre visible ───────────────────────────────────────────────── */

describe("nombreDeApp", () => {
  const NOMBRE = "Aseguradora Sur";

  beforeEach(() => {
    h.almacen.leer.mockResolvedValue(conectada());
  });

  it("pide el nombre nuevo con el token de la fila y no escribe nada: lo que pase llega por el aviso de Meta", async () => {
    expect(await nombreDeApp(QUIEN, NOMBRE)).toEqual({ resultado: "listo" });
    expect(h.pedirNombre).toHaveBeenCalledWith(CRED_DE_FILA, ID, NOMBRE);
    expect(h.almacen.guardar).not.toHaveBeenCalled();
  });

  it("también con el nombre rechazado, que es para lo que sirve", async () => {
    h.almacen.leer.mockResolvedValue(nombreRechazado());
    expect(await nombreDeApp(QUIEN, NOMBRE)).toEqual({ resultado: "listo" });
  });

  it("recorta los bordes del nombre", async () => {
    await nombreDeApp(QUIEN, `  ${NOMBRE} \n`);
    expect(h.pedirNombre).toHaveBeenCalledWith(CRED_DE_FILA, ID, NOMBRE);
  });

  it("60 caracteres es el máximo", async () => {
    const largo = "a".repeat(60);
    expect(await nombreDeApp(QUIEN, largo)).toEqual({ resultado: "listo" });
    expect(await nombreDeApp(QUIEN, `${largo}a`)).toEqual({ resultado: "nombre_invalido" });
  });

  it.each([["vacío", ""], ["en blanco", "   "], ["de 61 caracteres", "a".repeat(61)], ["con un salto de línea", "Sur\nS.A."], ["con un carácter de control", "Sur\u0007"]])(
    "un nombre %s es `nombre_invalido`, sin leer la base",
    async (_nombre, nombre) => {
      expect(await nombreDeApp(QUIEN, nombre)).toEqual({ resultado: "nombre_invalido" });
      expect(h.almacen.leer).not.toHaveBeenCalled();
      expect(h.pedirNombre).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["sin fila", null, "apagado"],
    ["una alta cancelada", fila({ estado: "cancelada" }), "transicion"],
    ["armando", conApp({ estado: "armando" }), "transicion"],
    ["vinculada", conApp({ estado: "vinculada" }), "transicion"],
    ["caída por el token vencido", conectada({ estado: "falla", falla: "token_vencido" }), "transicion"],
    ["caída por pago pendiente", conectada({ estado: "falla", falla: "pago_pendiente" }), "transicion"],
  ] as const)("%s", async (_nombre, existente, esperado) => {
    h.almacen.leer.mockResolvedValue(existente);
    expect(await nombreDeApp(QUIEN, NOMBRE)).toEqual({ resultado: esperado });
    expect(h.pedirNombre).not.toHaveBeenCalled();
  });

  it("con la vía apagada no se llama a Meta", async () => {
    vi.stubEnv("ALTA_APP_PROPIA", "");
    expect(await nombreDeApp(QUIEN, NOMBRE)).toEqual({ resultado: "apagado" });
    expect(h.pedirNombre).not.toHaveBeenCalled();
  });

  it("una alta del popup de Meta no es de esta vía: `transicion`", async () => {
    vi.stubEnv("ALTA_WABA_PROPIA", "1");
    h.almacen.leer.mockResolvedValue(conectada({ origen: "embedded_signup" }));
    expect(await nombreDeApp(QUIEN, NOMBRE)).toEqual({ resultado: "transicion" });
  });

  it.each([
    ["sin token guardado", { token: null }, "vencido"],
    ["sin el id del número", { phoneNumberId: null }, "vencido"],
    ["con la WABA de la plataforma", { wabaId: WABA_PLATAFORMA }, "de_la_plataforma"],
    ["con el número de la plataforma", { phoneNumberId: ID_PLATAFORMA }, "de_la_plataforma"],
    ["sin el secreto de la app abierto", { secreto: null }, "app_invalida"],
  ] as const)("%s: no se puede firmar el pedido", async (_nombre, cambios, esperado) => {
    h.almacen.leer.mockResolvedValue(conectada(cambios));
    expect(await nombreDeApp(QUIEN, NOMBRE)).toEqual({ resultado: esperado });
    expect(h.pedirNombre).not.toHaveBeenCalled();
  });

  it.each<[string, ReturnType<typeof falla>, ResultadoDeApp]>([
    ["Meta pidió esperar", falla("esperar", 4), "esperar"],
    ["un código que se espera (80007)", falla("rechazo", 80007), "esperar"],
    ["el token no sirve (190)", falla("rechazo", 190), "token_vencido"],
    ["pago pendiente", falla("rechazo", 131042), "pago_pendiente"],
    ["WABA restringida", falla("rechazo", 368), "waba_restringida"],
    ["un rechazo sin código: es el nombre mismo", falla("rechazo"), "nombre_invalido"],
    ["un rechazo con un código que no se reconoce: también el nombre", falla("rechazo", 100), "nombre_invalido"],
    ["una respuesta rara de Meta", falla("meta"), "meta"],
  ])("cuando Meta contesta: %s", async (_nombre, respuesta, esperado) => {
    h.pedirNombre.mockResolvedValue(respuesta);
    expect(await nombreDeApp(QUIEN, NOMBRE)).toEqual({ resultado: esperado });
    expect(h.almacen.guardar).not.toHaveBeenCalled();
  });

  describe("un rechazo que no es del nombre no se le atribuye (§3.1)", () => {
    it.each<[string, number]>([
      ["133005, el PIN que no coincide", 133005],
      ["131047, un código del mensaje", 131047],
      ["999, un código que no se conoce", 999],
    ])("%s: `meta` y no `nombre_invalido`", async (_nombre, codigo) => {
      h.pedirNombre.mockResolvedValue(falla("rechazo", codigo));
      expect(await nombreDeApp(QUIEN, NOMBRE)).toEqual({ resultado: "meta" });
    });

    it("131031 se confirma con la salud: BLOCKED es `waba_bloqueada`", async () => {
      h.pedirNombre.mockResolvedValue(falla("rechazo", 131031));
      h.leerSalud.mockResolvedValue(ok({ puedeEnviar: "BLOCKED", motivos: [] }));
      expect(await nombreDeApp(QUIEN, NOMBRE)).toEqual({ resultado: "waba_bloqueada" });
      expect(h.leerSalud).toHaveBeenCalledWith({ accessToken: TOKEN_VIEJO, wabaId: WABA, prueba: PRUEBA_VIEJA }, WABA);
    });

    it("131031 con la salud sin bloqueo no dice nada: `meta`, nunca `nombre_invalido`", async () => {
      h.pedirNombre.mockResolvedValue(falla("rechazo", 131031));
      expect(await nombreDeApp(QUIEN, NOMBRE)).toEqual({ resultado: "meta" });
    });

    it("el 100 con el secreto rotado es de la firma y no del nombre: la app lo rechaza y se abre E7", async () => {
      h.pedirNombre.mockResolvedValue(falla("rechazo", 100));
      h.leerApp.mockResolvedValue(falla("rechazo", 190));
      expect(await nombreDeApp(QUIEN, NOMBRE)).toEqual({ resultado: "app_invalida" });
      expect(h.leerApp).toHaveBeenCalledWith({ appId: APP_ID, secreto: SECRETO }, URL_WEBHOOK);
    });

    it("el 100 con la app sana sí es el nombre", async () => {
      h.pedirNombre.mockResolvedValue(falla("rechazo", 100));
      expect(await nombreDeApp(QUIEN, NOMBRE)).toEqual({ resultado: "nombre_invalido" });
      expect(h.leerApp).toHaveBeenCalledTimes(1);
    });

    it("el 100 con la app que pide esperar no cambia lo que se pidió: se vuelve a pedir otro nombre", async () => {
      h.pedirNombre.mockResolvedValue(falla("rechazo", 100));
      h.leerApp.mockResolvedValue(falla("esperar", 4));
      expect(await nombreDeApp(QUIEN, NOMBRE)).toEqual({ resultado: "nombre_invalido" });
    });
  });

  describe("la autenticación se confirma con la app (§3.1)", () => {
    it("el 190 con la app que acepta su secreto es el token vencido (E6)", async () => {
      h.pedirNombre.mockResolvedValue(falla("rechazo", 190));
      expect(await nombreDeApp(QUIEN, NOMBRE)).toEqual({ resultado: "token_vencido" });
      expect(h.leerApp).toHaveBeenCalledWith({ appId: APP_ID, secreto: SECRETO }, URL_WEBHOOK);
    });

    it("el 190 con la app que rechaza su secreto es el secreto rotado (E7)", async () => {
      h.pedirNombre.mockResolvedValue(falla("rechazo", 190));
      h.leerApp.mockResolvedValue(falla("rechazo", 190));
      expect(await nombreDeApp(QUIEN, NOMBRE)).toEqual({ resultado: "app_invalida" });
    });

    it("el 190 con subcódigo de token vencido (463) no necesita preguntarle a la app", async () => {
      h.pedirNombre.mockResolvedValue({ ...falla("rechazo", 190), subcodigo: 463 });
      expect(await nombreDeApp(QUIEN, NOMBRE)).toEqual({ resultado: "token_vencido" });
      expect(h.leerApp).not.toHaveBeenCalled();
    });

    it("si la app tampoco contesta, no se dice ni token ni secreto: se pide esperar", async () => {
      h.pedirNombre.mockResolvedValue(falla("rechazo", 190));
      h.leerApp.mockResolvedValue(falla("esperar", 4));
      expect(await nombreDeApp(QUIEN, NOMBRE)).toEqual({ resultado: "esperar" });
    });
  });
});

/* ── El nombre aprobado y «Reintentar» ────────────────────────────────────── */

describe("nombreAprobado", () => {
  it("registra el número otra vez con el almacén del sistema, no con el del cliente", async () => {
    const fila = conectada();
    h.almacenSistema.leer.mockResolvedValue(fila);
    await nombreAprobado(TENANT, WABA);
    expect(h.almacenDelDueno).toHaveBeenCalledWith(TENANT, "sistema");
    expect(h.registrarNombre).toHaveBeenCalledWith(TENANT, h.almacenSistema, fila);
    expect(h.almacenDelInquilino).not.toHaveBeenCalled();
    expect(h.nombreRehabilitado).not.toHaveBeenCalled();
  });

  it("lee la fila una sola vez y se la pasa al registro, que no la vuelve a pedir", async () => {
    await nombreAprobado(TENANT, WABA);
    expect(h.almacenSistema.leer).toHaveBeenCalledTimes(1);
  });

  it("si la fila había caído por el nombre, la devuelve a `conectada` cuando el registro salió", async () => {
    h.almacenSistema.leer.mockResolvedValue(nombreRechazado());
    await nombreAprobado(TENANT, WABA);
    expect(h.registrarNombre).toHaveBeenCalledTimes(1);
    expect(h.nombreRehabilitado).toHaveBeenCalledWith(TENANT);
    expect(h.registrarNombre.mock.invocationCallOrder[0]).toBeLessThan(h.nombreRehabilitado.mock.invocationCallOrder[0]);
  });

  it.each(["esperar", "vencido", "falta_pin", "meta", "transicion"])("si el registro contesta «%s» la fila caída no se rehabilita", async (registro) => {
    h.almacenSistema.leer.mockResolvedValue(nombreRechazado());
    h.registrarNombre.mockResolvedValue(registro);
    await nombreAprobado(TENANT, WABA);
    expect(h.nombreRehabilitado).not.toHaveBeenCalled();
  });

  it.each([
    ["no hay fila", null],
    ["la WABA de la fila es otra", conectada({ wabaId: OTRA_WABA })],
  ])("%s: no hay nada que registrar", async (_nombre, existente) => {
    h.almacenSistema.leer.mockResolvedValue(existente);
    await nombreAprobado(TENANT, WABA);
    expect(h.registrarNombre).not.toHaveBeenCalled();
    expect(h.nombreRehabilitado).not.toHaveBeenCalled();
  });

  it("nunca tira: anota sólo el nombre del error", async () => {
    h.registrarNombre.mockRejectedValue(new Error(`falló con ${PIN_VIEJO}`));
    await expect(nombreAprobado(TENANT, WABA)).resolves.toBeUndefined();
    expect(h.error).toHaveBeenCalledWith({ error: "Error", donde: "app_nombre_aprobado" }, "alta.waba_fallo");
    expect(registros()).not.toContain(PIN_VIEJO);
  });
});

describe("reintentarDeApp", () => {
  describe("fuera del nombre rechazado es el reintento de siempre", () => {
    it.each([
      ["sin fila", null],
      ["una alta del popup de Meta", conectada({ origen: "embedded_signup", estado: "falla", falla: "nombre_rechazado" })],
      ["una alta de la app propia conectada", conectada()],
      ["caída por el token vencido", conectada({ estado: "falla", falla: "token_vencido" })],
      ["caída por pago pendiente", conectada({ estado: "falla", falla: "pago_pendiente" })],
      ["armando", conApp()],
    ])("%s", async (_nombre, existente) => {
      h.almacen.leer.mockResolvedValue(existente);
      h.reintentar.mockResolvedValue("esperar");
      expect(await reintentarDeApp(QUIEN)).toBe("esperar");
      // La fila que ya se leyó viaja con el pedido: reintentar no la lee otra vez.
      expect(h.reintentar).toHaveBeenCalledWith(QUIEN, existente);
      expect(h.almacen.leer).toHaveBeenCalledTimes(1);
      expect(h.leerEstadoNombre).not.toHaveBeenCalled();
      expect(h.registrarNombre).not.toHaveBeenCalled();
    });
  });

  describe("con el nombre rechazado primero se le pregunta a Meta cómo va (R31)", () => {
    beforeEach(() => {
      h.almacen.leer.mockResolvedValue(nombreRechazado());
      h.almacenSistema.leer.mockResolvedValue(nombreRechazado());
    });

    const estadoDelNombre = (estado: string | null, estadoNuevo: string | null) =>
      h.leerEstadoNombre.mockResolvedValue(ok({ nombre: "Aseguradora Sur", estado, estadoNuevo }));

    it("lee el estado del nombre con el token de la fila y el cupo de seguir de su espacio", async () => {
      await reintentarDeApp(QUIEN);
      expect(h.cupo).toHaveBeenCalledWith(TENANT);
      expect(h.leerEstadoNombre).toHaveBeenCalledWith(CRED_DE_FILA, ID);
      expect(h.reintentar).not.toHaveBeenCalled();
    });

    it.each<[string | null, string | null, ResultadoDeApp | "registra"]>([
      ["APPROVED", null, "registra"],
      ["AVAILABLE_WITHOUT_REVIEW", null, "registra"],
      ["DECLINED", "APPROVED", "registra"],
      ["APPROVED", "NONE", "registra"],
      ["PENDING_REVIEW", null, "nombre_pendiente"],
      ["DECLINED", "PENDING_REVIEW", "nombre_pendiente"],
      ["DECLINED", null, "nombre_rechazado"],
      ["DECLINED", "NONE", "nombre_rechazado"],
      ["APPROVED", "DECLINED", "nombre_rechazado"],
      ["NON_EXISTS", null, "nombre_rechazado"],
      [null, "DECLINED", "nombre_rechazado"],
      [null, null, "meta"],
      [null, "NONE", "meta"],
    ])("estado %s y pedido nuevo %s: %s", async (estado, nuevo, esperado) => {
      estadoDelNombre(estado, nuevo);
      const resultado = await reintentarDeApp(QUIEN);
      if (esperado === "registra") {
        expect(resultado).toBe("listo");
        expect(h.registrarNombre).toHaveBeenCalledWith(TENANT, h.almacenSistema, expect.objectContaining({ falla: "nombre_rechazado" }));
        expect(h.nombreRehabilitado).toHaveBeenCalledWith(TENANT);
      } else {
        expect(resultado).toBe(esperado);
        // Nunca se registra con un nombre que Meta no aprobó.
        expect(h.registrarNombre).not.toHaveBeenCalled();
        expect(h.nombreRehabilitado).not.toHaveBeenCalled();
      }
    });

    it("aprobado pero el registro no sale: se dice por qué y la fila sigue caída", async () => {
      estadoDelNombre("APPROVED", null);
      h.registrarNombre.mockResolvedValue("esperar");
      expect(await reintentarDeApp(QUIEN)).toBe("esperar");
      expect(h.nombreRehabilitado).not.toHaveBeenCalled();
    });

    it("aprobado, registrado, pero la base no lo rehabilita: `transicion`", async () => {
      estadoDelNombre("APPROVED", null);
      h.nombreRehabilitado.mockResolvedValue(false);
      expect(await reintentarDeApp(QUIEN)).toBe("transicion");
    });

    it("aprobado: la fila se lee una sola vez, la de la persona, y el registro la recibe sin pedirla de nuevo", async () => {
      estadoDelNombre("APPROVED", null);
      await reintentarDeApp(QUIEN);
      expect(h.almacen.leer).toHaveBeenCalledTimes(1);
      expect(h.almacenSistema.leer).not.toHaveBeenCalled();
      expect(h.registrarNombre.mock.calls[0]?.[2]).toBe(await h.almacen.leer.mock.results[0]?.value);
    });

    it.each<[string, ReturnType<typeof falla>, ResultadoDeApp]>([
      ["Meta pidió esperar", falla("esperar", 4), "esperar"],
      ["el token no sirve (190)", falla("rechazo", 190), "token_vencido"],
      ["pago pendiente", falla("rechazo", 131042), "pago_pendiente"],
      ["un código que no se reconoce", falla("rechazo", 100), "meta"],
      ["una respuesta rara", falla("meta"), "meta"],
    ])("si Meta no deja leer el estado: %s", async (_nombre, respuesta, esperado) => {
      h.leerEstadoNombre.mockResolvedValue(respuesta);
      expect(await reintentarDeApp(QUIEN)).toBe(esperado);
      expect(h.registrarNombre).not.toHaveBeenCalled();
    });

    it("el 190 con la app que rechaza su secreto es E7 y no E6", async () => {
      h.almacen.leer.mockResolvedValue(nombreRechazado());
      h.leerEstadoNombre.mockResolvedValue(falla("rechazo", 190));
      h.leerApp.mockResolvedValue(falla("rechazo", 190));
      expect(await reintentarDeApp(QUIEN)).toBe("app_invalida");
    });

    it("131031 se confirma con la salud y sólo BLOCKED es `waba_bloqueada`", async () => {
      h.almacen.leer.mockResolvedValue(nombreRechazado());
      h.leerEstadoNombre.mockResolvedValue(falla("rechazo", 131031));
      h.leerSalud.mockResolvedValue(ok({ puedeEnviar: "BLOCKED", motivos: [] }));
      expect(await reintentarDeApp(QUIEN)).toBe("waba_bloqueada");
      h.leerSalud.mockResolvedValue(ok({ puedeEnviar: "AVAILABLE", motivos: [] }));
      expect(await reintentarDeApp(QUIEN)).toBe("meta");
    });

    it("sin lugar en el cupo de seguir espera, sin hablar con Meta", async () => {
      h.cupo.mockResolvedValue(false);
      expect(await reintentarDeApp(QUIEN)).toBe("esperar");
      expect(h.leerEstadoNombre).not.toHaveBeenCalled();
    });

    it("con la vía apagada no se llama a Meta ni se gasta el cupo", async () => {
      vi.stubEnv("ALTA_APP_PROPIA", "");
      expect(await reintentarDeApp(QUIEN)).toBe("apagado");
      expect(h.cupo).not.toHaveBeenCalled();
      expect(h.leerEstadoNombre).not.toHaveBeenCalled();
    });

    it.each([
      ["sin token guardado", { token: null }, "vencido"],
      ["con la WABA de la plataforma", { wabaId: WABA_PLATAFORMA }, "de_la_plataforma"],
      ["sin el secreto de la app abierto", { secreto: null }, "app_invalida"],
    ] as const)("%s: no se puede firmar el pedido", async (_nombre, cambios, esperado) => {
      h.almacen.leer.mockResolvedValue(nombreRechazado(cambios));
      expect(await reintentarDeApp(QUIEN)).toBe(esperado);
      expect(h.leerEstadoNombre).not.toHaveBeenCalled();
    });
  });

  it("si algo tira no tira: `meta`", async () => {
    h.almacen.leer.mockRejectedValue(new Error("falló"));
    expect(await reintentarDeApp(QUIEN)).toBe("meta");
    expect(h.error).toHaveBeenCalledWith({ error: "Error", donde: "app_reintentar" }, "alta.waba_fallo");
  });
});

/* ── Empezar de nuevo ─────────────────────────────────────────────────────── */

describe("cancelarDeApp", () => {
  beforeEach(() => h.almacen.leer.mockResolvedValue(fila({ appId: APP_ID })));

  it("suelta la fila que se está armando con el paso «otro» y cuenta que quedó cancelada", async () => {
    expect(await cancelarDeApp(QUIEN)).toBe("cancelado");

    expect(h.almacenDelInquilino).toHaveBeenCalledWith(QUIEN);
    expect(h.almacen.guardar).toHaveBeenCalledTimes(1);
    expect(h.almacen.guardar).toHaveBeenCalledWith("cancelar", { paso: "otro" });
  });

  it("no lee la fila: la base es la que decide desde qué estado se puede cancelar", async () => {
    await cancelarDeApp(QUIEN);

    expect(h.almacen.leer).not.toHaveBeenCalled();
  });

  it("no mira ninguna bandera: con la vía apagada la persona igual puede salir (S11)", async () => {
    vi.stubEnv("ALTA_APP_PROPIA", "");
    vi.stubEnv("ALTA_WABA_PROPIA", "");

    expect(await cancelarDeApp(QUIEN)).toBe("cancelado");

    expect(h.almacen.guardar).toHaveBeenCalledWith("cancelar", { paso: "otro" });
  });

  it("no toca Graph ni el cupo ni los avisos: sólo la base", async () => {
    await cancelarDeApp(QUIEN);

    expect(h.cupo).not.toHaveBeenCalled();
    expect(h.suscribirWebhook).not.toHaveBeenCalled();
    expect(h.fijarDatos).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it.each([
    // La fila ya pasó a otro estado: la página se vuelve a leer y muestra donde quedó.
    ["transicion", "transicion"],
    ["no_aplica", "revision"],
    ["datos_invalidos", "meta"],
    ["error", "meta"],
  ])("si la base contesta «%s» se le dice a la persona «%s»", async (guardado, esperado) => {
    h.almacen.guardar.mockResolvedValue(guardado);

    expect(await cancelarDeApp(QUIEN)).toBe(esperado);
  });

  it("si la base falla no tira y contesta «meta», sin dejar el secreto en el registro", async () => {
    h.almacen.guardar.mockRejectedValue(new Error(`falló con ${SECRETO} ${TOKEN}`));

    expect(await cancelarDeApp(QUIEN)).toBe("meta");

    expect(h.error).toHaveBeenCalledWith({ error: "Error", donde: "app_cancelar" }, "alta.waba_fallo");
    for (const secreto of [SECRETO, TOKEN]) expect(registros()).not.toContain(secreto);
  });
});

/* ── El recordatorio ──────────────────────────────────────────────────────── */

describe("recordarAltasAMedias", () => {
  const t = getT("es-AR");
  const alta = (
    extra: Partial<{ tenantId: string; appId: string | null; webhookVerificado: boolean; correo: string | null; locale: "es-AR" | "en-US" }> = {}
  ) => ({
    tenantId: TENANT,
    appId: APP_ID,
    webhookVerificado: false,
    correo: CORREO,
    locale: "es-AR" as const,
    ...extra,
  });

  it("sin remitente del sistema no manda nada ni mira la base", async () => {
    h.remitente.mockReturnValue(null);
    expect(await recordarAltasAMedias()).toBe(0);
    expect(h.altas).not.toHaveBeenCalled();
  });

  it("sin la dirección del sitio no hay enlace que dar: no manda nada", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    h.altas.mockResolvedValue([alta()]);
    expect(await recordarAltasAMedias()).toBe(0);
    expect(h.altas).not.toHaveBeenCalled();
  });

  it("busca las altas que llevan 24 horas a medias, de a 50 por vuelta", async () => {
    await recordarAltasAMedias();
    expect(h.altas).toHaveBeenCalledWith(24, 50);
  });

  it("manda un mail por alta, en español, con el paso en que quedó y el enlace; lo marca y lo anota", async () => {
    h.altas.mockResolvedValue([alta(), alta({ tenantId: OTRO_TENANT, correo: "otro@example.com" })]);
    expect(await recordarAltasAMedias()).toBe(2);
    expect(h.correo).toHaveBeenCalledTimes(2);
    const [[correo, opciones]] = h.correo.mock.calls;
    expect(opciones).toEqual({ tipo: "recordatorio" });
    expect(correo.to).toBe(CORREO);
    expect(correo.asunto).toBe(t("alta.recordatorio.asunto"));
    expect(correo.texto).toContain(t("alta.recordatorio.paso.P1B"));
    expect(correo.texto).toContain(`${SITIO}/conectar-whatsapp/app`);
    expect(correo.texto).not.toContain("{paso}");
    expect(correo.texto).not.toContain("{enlace}");
    expect(h.recordatorioEnviado.mock.calls).toEqual([[TENANT], [OTRO_TENANT]]);
    expect(h.info).toHaveBeenCalledWith({ tenantId: TENANT }, "alta.recordatorio_enviado");
  });

  it("manda cada mail en el idioma del dueño de su espacio, con el asunto, el paso y el cuerpo del mismo idioma", async () => {
    const en = getT("en-US");
    h.altas.mockResolvedValue([alta({ locale: "en-US" }), alta({ tenantId: OTRO_TENANT, locale: "es-AR" })]);
    await recordarAltasAMedias();
    const [[ingles], [espanol]] = h.correo.mock.calls;
    expect(ingles.asunto).toBe(en("alta.recordatorio.asunto"));
    expect(ingles.texto).toContain(en("alta.recordatorio.paso.P1B"));
    expect(ingles.texto).toContain("You started connecting your own WhatsApp app");
    expect(ingles.texto).not.toContain(t("alta.recordatorio.paso.P1B"));
    expect(espanol.asunto).toBe(t("alta.recordatorio.asunto"));
    expect(espanol.texto).toContain(t("alta.recordatorio.paso.P1B"));
  });

  it.each<[string, { appId: string | null; webhookVerificado: boolean }, string]>([
    ["sin app cargada", { appId: null, webhookVerificado: false }, "P1"],
    ["con la app y el webhook sin verificar", { appId: APP_ID, webhookVerificado: false }, "P1B"],
    ["con la app y el webhook verificado", { appId: APP_ID, webhookVerificado: true }, "P2"],
  ])("el paso que se nombra, %s: %s", async (_nombre, estado, paso) => {
    h.altas.mockResolvedValue([alta(estado)]);
    await recordarAltasAMedias();
    expect(h.correo.mock.calls[0][0].texto).toContain(t(`alta.recordatorio.paso.${paso as "P1"}`));
  });

  it("sin correo de contacto no hay a quién mandarle: se marca para no volver a mirarla", async () => {
    h.altas.mockResolvedValue([alta({ correo: null })]);
    expect(await recordarAltasAMedias()).toBe(0);
    expect(h.correo).not.toHaveBeenCalled();
    expect(h.recordatorioEnviado).toHaveBeenCalledWith(TENANT);
  });

  it("un destinatario inválido se marca y no cuenta como enviado", async () => {
    h.altas.mockResolvedValue([alta()]);
    h.correo.mockResolvedValue({ enviado: false, motivo: "destinatario_invalido" });
    expect(await recordarAltasAMedias()).toBe(0);
    expect(h.recordatorioEnviado).toHaveBeenCalledWith(TENANT);
    expect(h.info).not.toHaveBeenCalled();
  });

  it("si el mail no sale se marca igual, y sigue con las demás: una alta que siempre falla no tapa a las nuevas", async () => {
    h.altas.mockResolvedValue([alta(), alta({ tenantId: OTRO_TENANT })]);
    h.correo.mockResolvedValueOnce({ enviado: false, motivo: "no_salio" }).mockResolvedValueOnce({ enviado: true });
    expect(await recordarAltasAMedias()).toBe(1);
    expect(h.recordatorioEnviado.mock.calls).toEqual([[TENANT], [OTRO_TENANT]]);
  });

  it("tres mails seguidos que no salen son el remitente caído: se corta la vuelta y el resto queda sin marcar", async () => {
    const otras = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "66666666-6666-4666-8666-666666666666"];
    h.altas.mockResolvedValue([alta(), alta({ tenantId: OTRO_TENANT }), alta({ tenantId: otras[0] }), alta({ tenantId: otras[1] })]);
    h.correo.mockResolvedValue({ enviado: false, motivo: "no_salio" });
    expect(await recordarAltasAMedias()).toBe(0);
    expect(h.correo).toHaveBeenCalledTimes(3);
    expect(h.recordatorioEnviado.mock.calls).toEqual([[TENANT], [OTRO_TENANT], [otras[0]]]);
  });

  it("uno que sale corta la racha: dos y dos que no salen, con uno en el medio, no cortan", async () => {
    const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map((x) => `${x.repeat(8)}-${x.repeat(4)}-4${x.repeat(3)}-8${x.repeat(3)}-${x.repeat(12)}`);
    h.altas.mockResolvedValue([a, b, c, d, e].map((tenantId) => alta({ tenantId })));
    const nada = { enviado: false, motivo: "no_salio" } as const;
    h.correo.mockResolvedValueOnce(nada).mockResolvedValueOnce(nada).mockResolvedValueOnce({ enviado: true }).mockResolvedValueOnce(nada).mockResolvedValueOnce(nada);
    expect(await recordarAltasAMedias()).toBe(1);
    expect(h.correo).toHaveBeenCalledTimes(5);
    expect(h.recordatorioEnviado).toHaveBeenCalledTimes(5);
  });

  it.each(["sin_cupo", "sin_remitente"] as const)("un corte del remitente («%s») frena la vuelta y deja el resto para la próxima", async (motivo) => {
    h.altas.mockResolvedValue([alta(), alta({ tenantId: OTRO_TENANT }), alta({ tenantId: "44444444-4444-4444-8444-444444444444" })]);
    h.correo.mockResolvedValueOnce({ enviado: true }).mockResolvedValueOnce({ enviado: false, motivo });
    expect(await recordarAltasAMedias()).toBe(1);
    expect(h.correo).toHaveBeenCalledTimes(2);
    expect(h.recordatorioEnviado.mock.calls).toEqual([[TENANT]]);
  });

  it("el enlace y el paso se ponen tal cual, sin interpretar los `$` del texto", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://claimmix.example.com/$&");
    h.altas.mockResolvedValue([alta()]);
    await recordarAltasAMedias();
    expect(h.correo.mock.calls[0][0].texto).toContain("https://claimmix.example.com/$&/conectar-whatsapp/app");
  });

  it("nunca tira: devuelve 0 y anota sólo el nombre del error", async () => {
    h.altas.mockRejectedValue(new Error("falló"));
    expect(await recordarAltasAMedias()).toBe(0);
    expect(h.error).toHaveBeenCalledWith({ error: "Error", donde: "app_recordatorio" }, "alta.waba_fallo");
  });

  it("con un plazo (`hasta`) ya vencido no manda nada y deja todo para la próxima vuelta", async () => {
    h.altas.mockResolvedValue([alta(), alta({ tenantId: OTRO_TENANT })]);
    expect(await recordarAltasAMedias(Date.now() - 1)).toBe(0);
    expect(h.correo).not.toHaveBeenCalled();
    expect(h.recordatorioEnviado).not.toHaveBeenCalled();
  });

  it("con un plazo que se vence a mitad de la vuelta corta ahí: lo que ya salió queda marcado", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-09T04:00:00Z"));
      const hasta = Date.now() + 1_000;
      h.altas.mockResolvedValue([alta(), alta({ tenantId: OTRO_TENANT })]);
      h.correo.mockImplementationOnce(async () => {
        vi.setSystemTime(new Date("2026-10-09T04:00:05Z"));
        return { enviado: true };
      });
      expect(await recordarAltasAMedias(hasta)).toBe(1);
      expect(h.correo).toHaveBeenCalledTimes(1);
      expect(h.recordatorioEnviado.mock.calls).toEqual([[TENANT]]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("veredictoDelNombre", () => {
  it.each<[string | null, string | null, string]>([
    ["APPROVED", null, "aprobado"],
    ["AVAILABLE_WITHOUT_REVIEW", "NONE", "aprobado"],
    ["PENDING_REVIEW", null, "pendiente"],
    ["DECLINED", null, "rechazado"],
    [null, null, "desconocido"],
    // El pedido nuevo manda sobre el nombre vigente: uno aprobado con un cambio rechazado no es un nombre aprobado.
    ["APPROVED", "DECLINED", "rechazado"],
    ["DECLINED", "APPROVED", "aprobado"],
    ["APPROVED", "PENDING_REVIEW", "pendiente"],
  ])("estado %s, pedido nuevo %s: %s", (estado, nuevo, esperado) => {
    expect(veredictoDelNombre(estado, nuevo)).toBe(esperado);
  });
});

/* ── Lo que nunca sale ────────────────────────────────────────────────────── */

describe("nada de lo secreto sale", () => {
  it.each<[string, string, () => Promise<unknown>]>([
    ["iniciarApp", "app_iniciar", () => iniciarApp(QUIEN, DATOS_DE_INICIO)],
    ["credencialesDeApp", "app_credenciales", () => credencialesDeApp(QUIEN, CREDENCIALES)],
    ["webhookDeApp", "app_webhook", () => webhookDeApp(QUIEN)],
    ["tokenDeApp", "app_token", () => tokenDeApp(QUIEN, PEDIDO_DE_TOKEN)],
    ["nombreDeApp", "app_nombre", () => nombreDeApp(QUIEN, "Aseguradora Sur")],
    ["reintentarDeApp", "app_reintentar", () => reintentarDeApp(QUIEN)],
    ["estadoDeApp", "app_estado", () => estadoDeApp(QUIEN)],
  ])("%s no tira si la base falla, y no deja ni el secreto ni el token en el registro", async (_nombre, donde, llamar) => {
    h.almacen.leer.mockRejectedValue(new Error(`falló con ${SECRETO} ${TOKEN} ${PIN_VIEJO}`));
    await expect(llamar()).resolves.toBeDefined();
    expect(h.error).toHaveBeenCalledWith({ error: "Error", donde }, "alta.waba_fallo");
    for (const secreto of [SECRETO, TOKEN, PIN_VIEJO]) expect(registros()).not.toContain(secreto);
  });

  it("ningún resultado ni registro de un recorrido completo lleva el secreto, el token, el PIN ni la prueba", async () => {
    h.almacen.leer.mockResolvedValue(fila());
    const salidas: unknown[] = [];
    salidas.push(await credencialesDeApp(QUIEN, CREDENCIALES));

    h.almacen.leer.mockResolvedValue(conApp());
    salidas.push(await webhookDeApp(QUIEN));
    salidas.push(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN));
    h.datosNumero.mockResolvedValue(datosDelNumero({ display: OTRO_DISPLAY }));
    h.recorrer.mockResolvedValue(ok({ filas: [{ id: ID, display: OTRO_DISPLAY, nombre: null }], completa: true }));
    salidas.push(await tokenDeApp(QUIEN, PEDIDO_DE_TOKEN));

    h.almacen.leer.mockResolvedValue(conectada());
    salidas.push(await tokenDeApp(QUIEN, { token: TOKEN, wabaId: WABA }));
    salidas.push(await nombreDeApp(QUIEN, "Aseguradora Sur"));
    salidas.push(await estadoDeApp(QUIEN));

    h.fijarDatos.mockResolvedValue(falla("rechazo", 100));
    h.suscribirWebhook.mockResolvedValue(falla("rechazo", 100));
    h.almacen.leer.mockResolvedValue(fila());
    salidas.push(await credencialesDeApp(QUIEN, CREDENCIALES));

    const todo = JSON.stringify(salidas) + registros();
    for (const prohibido of [SECRETO, TOKEN, TOKEN_VIEJO, PIN_VIEJO, PRUEBA, PRUEBA_VIEJA, "Bearer"]) expect(todo).not.toContain(prohibido);
  });

  it("la dirección del webhook que da `webhookDeApp` es la misma que la de la bandera", () => {
    expect(urlDelWebhookDeApp(RUTA)).toBe(urlDeLaBandera(RUTA));
    expect(urlDelWebhookDeApp(RUTA)).toBe(URL_WEBHOOK);
  });
});
