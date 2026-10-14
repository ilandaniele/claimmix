/**
 * La revisión nocturna de las WABAs propias (`@/server/alta/waba-salud`): un token que
 * Graph ya no acepta deja la WABA en falla, una plantilla que falta se vuelve a pedir,
 * una WABA a medias hace días avisa como huérfana, y nada de eso puede tirar la tarea
 * que lo lleva. Con la app propia del cliente además se mira la salud del número, el
 * secreto y el nombre rechazado, y al final salen los recordatorios.
 *
 * La base, Graph y el aviso al operador están simulados.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  leer: vi.fn(),
  revisarToken: vi.fn(),
  crearPlantilla: vi.fn(),
  wabaEnFalla: vi.fn(),
  wabaRevocada: vi.fn(),
  restriccionLevantada: vi.fn(),
  plantillaCreada: vi.fn(),
  saludDeApp: vi.fn(),
  aviso: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  revisarTokenDeApp: vi.fn(),
  leerApp: vi.fn(),
  leerSalud: vi.fn(),
  leerEstadoDelNombre: vi.fn(),
  nombreAprobado: vi.fn(),
  veredicto: vi.fn(),
  recordar: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/alta/wabas-del-cliente", () => ({ leerWabasDelCliente: h.leer }));
vi.mock("@/server/whatsapp/embedded-signup", () => ({
  revisarToken: h.revisarToken,
  crearPlantillaReabrir: h.crearPlantilla,
}));
vi.mock("@/server/alta/panel-operador", () => ({
  wabaEnFalla: h.wabaEnFalla,
  wabaRevocada: h.wabaRevocada,
  restriccionLevantada: h.restriccionLevantada,
  plantillaCreada: h.plantillaCreada,
  saludDeApp: h.saludDeApp,
}));
vi.mock("@/server/whatsapp/app-del-cliente", () => ({
  revisarTokenDeApp: h.revisarTokenDeApp,
  leerApp: h.leerApp,
  leerSalud: h.leerSalud,
  leerEstadoDelNombre: h.leerEstadoDelNombre,
  // La prueba firmada se arma de verdad en su propio test: acá basta con que dependa del token y del secreto.
  pruebaDelSecreto: (token: string, secreto: string) => `fake-proof-${token}-${secreto}`,
}));
vi.mock("@/server/alta/app-propia", () => ({
  nombreAprobado: h.nombreAprobado,
  veredictoDelNombre: h.veredicto,
  recordarAltasAMedias: h.recordar,
}));
vi.mock("@/server/alta/aviso-operador", () => ({ avisarNumeroEnRevision: h.aviso }));
vi.mock("@/lib/observability/logger", () => ({ logger: { warn: h.warn, error: h.error, info: vi.fn() } }));

import { revisarWabas } from "@/server/alta/waba-salud";

const TENANT = "10000000-0000-4000-8000-000000000001";
const OTRO = "20000000-0000-4000-8000-000000000002";
const TOKEN = "test-waba-token";

const waba = (cambios: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  wabaId: "555000111222",
  estado: "conectada",
  actualizadoEn: 1_790_000_000_000,
  plantillaEnviada: true,
  origen: "embedded_signup",
  token: TOKEN,
  falla: null,
  appId: null,
  secreto: null,
  phoneNumberId: null,
  ...cambios,
});

const APP_ID = "123456789012345";
const SECRETO = "fake-app-secret-0123";
const NUMERO = "109876543210";
const PRUEBA = `fake-proof-${TOKEN}-${SECRETO}`;

const deApp = (cambios: Record<string, unknown> = {}) =>
  waba({ origen: "app_propia", appId: APP_ID, secreto: SECRETO, phoneNumberId: NUMERO, ...cambios });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  h.leer.mockResolvedValue([waba()]);
  h.revisarToken.mockResolvedValue({ ok: true, valor: { wabaIds: ["555000111222"], fbUserId: "1" } });
  h.crearPlantilla.mockResolvedValue({ ok: true, valor: true });
  h.wabaEnFalla.mockResolvedValue(undefined);
  h.wabaRevocada.mockResolvedValue(undefined);
  h.restriccionLevantada.mockResolvedValue(true);
  h.plantillaCreada.mockResolvedValue(undefined);
  h.aviso.mockResolvedValue(undefined);
  h.saludDeApp.mockResolvedValue(undefined);
  h.revisarTokenDeApp.mockResolvedValue({ ok: true, usuarioId: "1", wabaIds: ["555000111222"] });
  h.leerApp.mockResolvedValue({ ok: false, falla: "meta" });
  h.leerSalud.mockResolvedValue({ ok: true, valor: { puedeEnviar: "AVAILABLE", motivos: [] } });
  h.leerEstadoDelNombre.mockResolvedValue({ ok: true, valor: { nombre: "Estudio", estado: "APPROVED", estadoNuevo: null } });
  h.nombreAprobado.mockResolvedValue(undefined);
  h.veredicto.mockReturnValue("pendiente");
  h.recordar.mockResolvedValue(0);
});

describe("WABA conectada", () => {
  it("con el token vivo y la plantilla enviada no hace nada más", async () => {
    await revisarWabas();

    expect(h.revisarToken).toHaveBeenCalledWith(TOKEN);
    expect(h.wabaEnFalla).not.toHaveBeenCalled();
    expect(h.wabaRevocada).not.toHaveBeenCalled();
    expect(h.crearPlantilla).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("si Graph dice 190 la deja en falla `token_vencido` y avisa", async () => {
    h.revisarToken.mockResolvedValue({ ok: false, falla: "rechazo", codigo: 190 });

    await revisarWabas();

    expect(h.wabaEnFalla).toHaveBeenCalledWith(TENANT, "token_vencido");
    expect(h.aviso).toHaveBeenCalledWith("token_vencido", TENANT);
    expect(h.crearPlantilla).not.toHaveBeenCalled();
  });

  it("con el token vivo pero sin esta WABA entre las autorizadas (se sacó la app o el permiso) la da de baja y avisa", async () => {
    h.revisarToken.mockResolvedValue({ ok: true, valor: { wabaIds: ["999000111222"], fbUserId: "1" } });
    h.leer.mockResolvedValue([waba({ plantillaEnviada: false })]);

    await revisarWabas();

    expect(h.wabaRevocada).toHaveBeenCalledWith("555000111222");
    expect(h.aviso).toHaveBeenCalledWith("revocada", TENANT);
    expect(h.wabaEnFalla).not.toHaveBeenCalled();
    expect(h.crearPlantilla).not.toHaveBeenCalled();
  });

  it("un error de Graph que no es el 190 no la toca (Meta caído no es token muerto)", async () => {
    h.revisarToken.mockResolvedValue({ ok: false, falla: "meta", codigo: null });

    await revisarWabas();

    expect(h.wabaEnFalla).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, falla: "meta" }), "whatsapp.salud_token_dudoso");
  });

  it("sin token para abrir lo anota y no llama a Graph", async () => {
    h.leer.mockResolvedValue([waba({ token: null })]);

    await revisarWabas();

    expect(h.revisarToken).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT }, "whatsapp.salud_sin_token");
  });

  it("si le falta la plantilla la pide de nuevo y anota la fecha", async () => {
    h.leer.mockResolvedValue([waba({ plantillaEnviada: false })]);

    await revisarWabas();

    expect(h.crearPlantilla).toHaveBeenCalledWith(TOKEN, "555000111222");
    expect(h.plantillaCreada).toHaveBeenCalledWith(TENANT);
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("si la plantilla sigue sin poder crearse avisa `plantilla` y no anota la fecha", async () => {
    h.leer.mockResolvedValue([waba({ plantillaEnviada: false })]);
    h.crearPlantilla.mockResolvedValue({ ok: false, falla: "rechazo", codigo: 100 });

    await revisarWabas();

    expect(h.plantillaCreada).not.toHaveBeenCalled();
    expect(h.aviso).toHaveBeenCalledWith("plantilla", TENANT);
  });
});

describe("WABA conectada de la app propia", () => {
  beforeEach(() => {
    h.leer.mockResolvedValue([deApp()]);
  });

  it("revisa el token con la app del cliente, no con el de la plataforma", async () => {
    await revisarWabas();

    expect(h.revisarTokenDeApp).toHaveBeenCalledWith(TOKEN, { appId: APP_ID, secreto: SECRETO });
    expect(h.revisarToken).not.toHaveBeenCalled();
  });

  it("con todo en orden guarda la salud del número para el panel y no avisa", async () => {
    await revisarWabas();

    expect(h.leerSalud).toHaveBeenCalledWith({ accessToken: TOKEN, wabaId: "555000111222", prueba: PRUEBA }, NUMERO);
    expect(h.saludDeApp).toHaveBeenCalledWith(TENANT, "AVAILABLE");
    expect(h.wabaEnFalla).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("LIMITED se guarda y no es una falla: Meta deja enviar con tope", async () => {
    h.leerSalud.mockResolvedValue({ ok: true, valor: { puedeEnviar: "LIMITED", motivos: ["141001"] } });

    await revisarWabas();

    expect(h.saludDeApp).toHaveBeenCalledWith(TENANT, "LIMITED");
    expect(h.wabaEnFalla).not.toHaveBeenCalled();
  });

  it("BLOCKED se guarda, deja la falla `waba_bloqueada` y avisa", async () => {
    h.leerSalud.mockResolvedValue({ ok: true, valor: { puedeEnviar: "BLOCKED", motivos: [] } });
    h.leer.mockResolvedValue([deApp({ plantillaEnviada: false })]);

    await revisarWabas();

    expect(h.saludDeApp).toHaveBeenCalledWith(TENANT, "BLOCKED");
    expect(h.wabaEnFalla).toHaveBeenCalledWith(TENANT, "waba_bloqueada");
    expect(h.aviso).toHaveBeenCalledWith("waba_bloqueada", TENANT);
    expect(h.crearPlantilla).not.toHaveBeenCalled();
  });

  it("si Graph no contesta la salud lo anota, no toca el estado y sigue con la plantilla", async () => {
    h.leerSalud.mockResolvedValue({ ok: false, falla: "meta" });
    h.leer.mockResolvedValue([deApp({ plantillaEnviada: false })]);

    await revisarWabas();

    expect(h.saludDeApp).not.toHaveBeenCalled();
    expect(h.wabaEnFalla).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT, falla: "meta" }, "whatsapp.salud_dudosa");
    expect(h.plantillaCreada).toHaveBeenCalledWith(TENANT);
  });

  it("la plantilla que falta se pide firmada con la prueba del secreto", async () => {
    h.leer.mockResolvedValue([deApp({ plantillaEnviada: false })]);

    await revisarWabas();

    expect(h.crearPlantilla).toHaveBeenCalledWith(TOKEN, "555000111222", PRUEBA);
    expect(h.plantillaCreada).toHaveBeenCalledWith(TENANT);
  });

  it("si la plantilla no se pudo crear avisa `plantilla` y no anota la fecha", async () => {
    h.leer.mockResolvedValue([deApp({ plantillaEnviada: false })]);
    h.crearPlantilla.mockResolvedValue({ ok: false, falla: "rechazo", codigo: 100 });

    await revisarWabas();

    expect(h.plantillaCreada).not.toHaveBeenCalled();
    expect(h.aviso).toHaveBeenCalledWith("plantilla", TENANT);
  });

  it.each(["token_vencido", "falta_permiso"])("un token que dice `%s` es un token vencido: el cliente genera uno nuevo (M9)", async (motivo) => {
    h.revisarTokenDeApp.mockResolvedValue({ ok: false, motivo });

    await revisarWabas();

    expect(h.wabaEnFalla).toHaveBeenCalledWith(TENANT, "token_vencido");
    expect(h.aviso).toHaveBeenCalledWith("token_vencido", TENANT);
    expect(h.leerSalud).not.toHaveBeenCalled();
    expect(h.leerApp).not.toHaveBeenCalled();
  });

  it("si el token ya no llega a esta WABA (se la sacó del usuario del sistema) pide uno nuevo", async () => {
    h.revisarTokenDeApp.mockResolvedValue({ ok: true, usuarioId: "1", wabaIds: ["999000111222"] });

    await revisarWabas();

    expect(h.wabaEnFalla).toHaveBeenCalledWith(TENANT, "token_vencido");
    expect(h.wabaRevocada).not.toHaveBeenCalled();
    expect(h.leerSalud).not.toHaveBeenCalled();
  });

  it("si Meta no dijo a qué WABAs llega el token (`wabaIds` nulo) no se saca ninguna conclusión", async () => {
    h.revisarTokenDeApp.mockResolvedValue({ ok: true, usuarioId: "1", wabaIds: null });

    await revisarWabas();

    expect(h.wabaEnFalla).not.toHaveBeenCalled();
    expect(h.leerSalud).toHaveBeenCalledTimes(1);
  });

  describe("`app_invalida` (el secreto)", () => {
    beforeEach(() => {
      h.revisarTokenDeApp.mockResolvedValue({ ok: false, motivo: "app_invalida" });
    });

    it("sólo es `secreto_invalido` si una segunda llamada también lo rechaza", async () => {
      h.leerApp.mockResolvedValue({ ok: false, falla: "rechazo" });

      await revisarWabas();

      expect(h.leerApp).toHaveBeenCalledWith({ appId: APP_ID, secreto: SECRETO }, "");
      expect(h.wabaEnFalla).toHaveBeenCalledWith(TENANT, "secreto_invalido");
      expect(h.aviso).toHaveBeenCalledWith("secreto_invalido", TENANT);
    });

    it("si la segunda llamada falla por otra razón (Meta caído) no la declara: lo anota", async () => {
      h.leerApp.mockResolvedValue({ ok: false, falla: "meta" });

      await revisarWabas();

      expect(h.wabaEnFalla).not.toHaveBeenCalled();
      expect(h.aviso).not.toHaveBeenCalled();
      expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT }, "whatsapp.salud_app_dudosa");
    });

    it("si la segunda llamada anda, el primer rechazo fue un tropiezo", async () => {
      h.leerApp.mockResolvedValue({ ok: true, valor: { webhookVerificado: true } });

      await revisarWabas();

      expect(h.wabaEnFalla).not.toHaveBeenCalled();
      expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT }, "whatsapp.salud_app_dudosa");
    });
  });

  it.each(["token_de_otra_app", "token_temporal", "permisos_de_mas", "meta"])(
    "`%s` no es algo que la revisión nocturna arregle: lo anota y no cambia el estado",
    async (motivo) => {
      h.revisarTokenDeApp.mockResolvedValue({ ok: false, motivo });

      await revisarWabas();

      expect(h.wabaEnFalla).not.toHaveBeenCalled();
      expect(h.aviso).not.toHaveBeenCalled();
      expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT, motivo }, "whatsapp.salud_token_dudoso");
    }
  );

  it.each([
    ["el App ID", { appId: null }],
    ["el App Secret (el sobre no abre)", { secreto: null }],
    ["el token", { token: null }],
    ["el número", { phoneNumberId: null }],
  ])("sin %s lo anota y no llama a Graph", async (_cual, cambios) => {
    h.leer.mockResolvedValue([deApp(cambios)]);

    await revisarWabas();

    expect(h.revisarTokenDeApp).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT }, "whatsapp.salud_sin_token");
  });
});

describe("WABA en falla por nombre rechazado (R31)", () => {
  beforeEach(() => {
    h.leer.mockResolvedValue([deApp({ estado: "falla", falla: "nombre_rechazado" })]);
  });

  it("le pregunta a Meta por el nombre, con la prueba del secreto, y si ya está aprobado registra el número", async () => {
    h.veredicto.mockReturnValue("aprobado");
    h.leerEstadoDelNombre.mockResolvedValue({ ok: true, valor: { nombre: "Estudio", estado: "APPROVED", estadoNuevo: "NONE" } });

    await revisarWabas();

    expect(h.leerEstadoDelNombre).toHaveBeenCalledWith({ accessToken: TOKEN, wabaId: "555000111222", prueba: PRUEBA }, NUMERO);
    expect(h.veredicto).toHaveBeenCalledWith("APPROVED", "NONE");
    expect(h.nombreAprobado).toHaveBeenCalledWith(TENANT, "555000111222");
  });

  it.each(["pendiente", "rechazado", "desconocido"])("con el nombre `%s` sólo mira: no registra ni avisa", async (veredicto) => {
    h.veredicto.mockReturnValue(veredicto);

    await revisarWabas();

    expect(h.nombreAprobado).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
    expect(h.wabaEnFalla).not.toHaveBeenCalled();
  });

  it("si Graph no contesta lo anota y no registra nada", async () => {
    h.leerEstadoDelNombre.mockResolvedValue({ ok: false, falla: "meta" });

    await revisarWabas();

    expect(h.nombreAprobado).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT, falla: "meta" }, "whatsapp.salud_nombre_dudoso");
  });

  it("no toca el token ni la salud: el cliente todavía no tiene una conexión que revisar", async () => {
    await revisarWabas();

    expect(h.revisarTokenDeApp).not.toHaveBeenCalled();
    expect(h.leerSalud).not.toHaveBeenCalled();
  });

  it("sin el secreto, el token o el número lo anota y no llama a Graph", async () => {
    h.leer.mockResolvedValue([deApp({ estado: "falla", falla: "nombre_rechazado", secreto: null })]);

    await revisarWabas();

    expect(h.leerEstadoDelNombre).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT }, "whatsapp.salud_sin_token");
  });
});

describe("WABA en falla por una restricción o un bloqueo de Meta", () => {
  beforeEach(() => {
    h.leer.mockResolvedValue([deApp({ estado: "falla", falla: "waba_restringida", plantillaEnviada: false })]);
  });

  it("si Meta ya la deja enviar (AVAILABLE) levanta la falla y guarda la salud", async () => {
    await revisarWabas();

    expect(h.leerSalud).toHaveBeenCalledWith({ accessToken: TOKEN, wabaId: "555000111222", prueba: PRUEBA }, NUMERO);
    expect(h.saludDeApp).toHaveBeenCalledWith(TENANT, "AVAILABLE");
    expect(h.restriccionLevantada).toHaveBeenCalledWith(TENANT);
  });

  it("también levanta el bloqueo: `waba_bloqueada` no es un callejón sin salida", async () => {
    h.leer.mockResolvedValue([deApp({ estado: "falla", falla: "waba_bloqueada" })]);

    await revisarWabas();

    expect(h.restriccionLevantada).toHaveBeenCalledWith(TENANT);
  });

  it.each(["LIMITED", "BLOCKED"])("con la salud `%s` la restricción sigue en pie: guarda la salud y no la levanta", async (puedeEnviar) => {
    h.leerSalud.mockResolvedValue({ ok: true, valor: { puedeEnviar, motivos: [] } });

    await revisarWabas();

    expect(h.saludDeApp).toHaveBeenCalledWith(TENANT, puedeEnviar);
    expect(h.restriccionLevantada).not.toHaveBeenCalled();
    expect(h.wabaEnFalla).not.toHaveBeenCalled();
  });

  it("si Graph no contesta la salud lo anota y la deja como está", async () => {
    h.leerSalud.mockResolvedValue({ ok: false, falla: "meta" });

    await revisarWabas();

    expect(h.restriccionLevantada).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT, falla: "meta" }, "whatsapp.salud_dudosa");
  });

  it("si el token murió bajo la restricción lo anota como `token_vencido` (el problema de verdad) y no mira la salud", async () => {
    h.revisarTokenDeApp.mockResolvedValue({ ok: false, motivo: "token_vencido" });

    await revisarWabas();

    expect(h.wabaEnFalla).toHaveBeenCalledWith(TENANT, "token_vencido");
    expect(h.leerSalud).not.toHaveBeenCalled();
    expect(h.restriccionLevantada).not.toHaveBeenCalled();
  });

  it("si el token ya no llega a la WABA también es `token_vencido`", async () => {
    h.revisarTokenDeApp.mockResolvedValue({ ok: true, usuarioId: "1", wabaIds: ["999"] });

    await revisarWabas();

    expect(h.wabaEnFalla).toHaveBeenCalledWith(TENANT, "token_vencido");
    expect(h.leerSalud).not.toHaveBeenCalled();
  });

  it("sin el secreto, el token o el número lo anota y no llama a Graph", async () => {
    h.leer.mockResolvedValue([deApp({ estado: "falla", falla: "waba_restringida", token: null })]);

    await revisarWabas();

    expect(h.revisarTokenDeApp).not.toHaveBeenCalled();
    expect(h.leerSalud).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT }, "whatsapp.salud_sin_token");
  });

  it("no crea la plantilla ni avisa: una restricción levantada vuelve a la revisión de las conectadas", async () => {
    await revisarWabas();

    expect(h.crearPlantilla).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
  });
});

describe("WABA a medias", () => {
  it.each(["vinculada", "suscripta", "falta_codigo", "falta_pin"])("%s hace días avisa como huérfana y no llama a Graph", async (estado) => {
    h.leer.mockResolvedValue([waba({ estado })]);

    await revisarWabas();

    expect(h.aviso).toHaveBeenCalledWith("waba_huerfana", TENANT);
    expect(h.revisarToken).not.toHaveBeenCalled();
  });
});

describe("la consulta", () => {
  it("pide como mucho 50 y en orden al azar, para que las de siempre no tapen al resto", async () => {
    await revisarWabas();

    const [, limite, orden] = h.leer.mock.calls[0] as [unknown, number, { queryChunks: unknown[] }];
    expect(limite).toBe(50);
    expect(JSON.stringify(orden.queryChunks)).toContain("random()");
  });

  it("el filtro mira las conectadas y las a medias hace más de 48 horas", async () => {
    await revisarWabas();

    const [donde] = h.leer.mock.calls[0] as [{ queryChunks: unknown[] }];
    const texto = JSON.stringify(donde.queryChunks);
    expect(texto).toContain("conectada");
    expect(texto).toContain("falta_pin");
    expect(texto).toContain("hours");
  });

  it("y de la app propia sólo las caídas por el nombre, una restricción o un bloqueo: las demás las arregla el cliente", async () => {
    await revisarWabas();

    const [donde] = h.leer.mock.calls[0] as [{ queryChunks: unknown[] }];
    const texto = JSON.stringify(donde.queryChunks);
    expect(texto).toContain("app_propia");
    expect(texto).toContain("nombre_rechazado");
    expect(texto).toContain("waba_restringida");
    expect(texto).toContain("waba_bloqueada");
    expect(texto).not.toContain("token_vencido");
    expect(texto).not.toContain("secreto_invalido");
  });
});

describe("los recordatorios del alta a medias", () => {
  it("salen al final de la vuelta, con el mismo plazo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T04:00:00Z"));

    await revisarWabas();

    expect(h.recordar).toHaveBeenCalledTimes(1);
    expect(h.recordar).toHaveBeenCalledWith(Date.parse("2026-10-09T04:00:00Z") + 20_000);
  });

  it("también cuando no hay ninguna WABA que revisar", async () => {
    h.leer.mockResolvedValue([]);

    await revisarWabas();

    expect(h.recordar).toHaveBeenCalledTimes(1);
  });

  it("sin la 0051 (42P01) no salen: no hay altas ni tabla donde marcarlas", async () => {
    h.leer.mockRejectedValue(Object.assign(new Error("relation does not exist"), { code: "42P01" }));

    await revisarWabas();

    expect(h.recordar).not.toHaveBeenCalled();
  });

  it("si la consulta falla por otra razón igual salen: el recordatorio no depende de la revisión", async () => {
    h.leer.mockRejectedValue(Object.assign(new Error("timeout"), { code: "57014" }));

    await revisarWabas();

    expect(h.recordar).toHaveBeenCalledTimes(1);
  });
});

describe("no tira nunca", () => {
  it("si falla la consulta lo anota y termina", async () => {
    h.leer.mockRejectedValue(new Error("42P01"));

    await expect(revisarWabas()).resolves.toBeUndefined();

    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "whatsapp.salud_consulta_fallo");
  });

  it("sin la 0051 (falta la tabla, 42P01) no hay nada que revisar: termina sin dejar un error en cada corrida", async () => {
    h.leer.mockRejectedValue(Object.assign(new Error("relation does not exist"), { code: "42P01" }));

    await expect(revisarWabas()).resolves.toBeUndefined();

    expect(h.error).not.toHaveBeenCalled();
    expect(h.revisarToken).not.toHaveBeenCalled();
  });

  it("un código de Postgres que no es la falta de la tabla sí se anota", async () => {
    h.leer.mockRejectedValue(Object.assign(new Error("timeout"), { code: "57014" }));

    await revisarWabas();

    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "whatsapp.salud_consulta_fallo");
  });

  it("si falla una WABA, la siguiente igual se revisa", async () => {
    h.leer.mockResolvedValue([waba(), waba({ tenantId: OTRO, wabaId: "666" })]);
    h.revisarToken.mockRejectedValueOnce(new Error("red"));
    h.revisarToken.mockResolvedValueOnce({ ok: false, falla: "rechazo", codigo: 190 });

    await revisarWabas();

    expect(h.error).toHaveBeenCalledWith({ error: "Error", tenantId: TENANT }, "whatsapp.salud_fallo");
    expect(h.wabaEnFalla).toHaveBeenCalledWith(OTRO, "token_vencido");
  });

  it("si se acaba el presupuesto corta y deja el resto para la próxima vuelta", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T04:00:00Z"));
    h.leer.mockResolvedValue([waba(), waba({ tenantId: OTRO, wabaId: "666" })]);
    h.revisarToken.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2026-10-09T04:01:00Z"));
      return { ok: true, valor: { wabaIds: ["555000111222"], fbUserId: null } };
    });

    await revisarWabas();

    expect(h.revisarToken).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith({ revisadas: 1, total: 2 }, "whatsapp.salud_sin_tiempo");
  });

  it("los últimos 5 segundos del presupuesto se guardan para los recordatorios", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T04:00:00Z"));
    h.leer.mockResolvedValue([waba(), waba({ tenantId: OTRO, wabaId: "666" })]);
    h.revisarToken.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2026-10-09T04:00:16Z"));
      return { ok: true, valor: { wabaIds: ["555000111222"], fbUserId: null } };
    });

    await revisarWabas();

    expect(h.revisarToken).toHaveBeenCalledTimes(1);
    expect(h.recordar).toHaveBeenCalledTimes(1);
  });

  it("si la revisión de una app propia tira, la siguiente igual se revisa", async () => {
    h.leer.mockResolvedValue([deApp(), deApp({ tenantId: OTRO, wabaId: "666" })]);
    h.revisarTokenDeApp.mockRejectedValueOnce(new Error("red"));
    h.revisarTokenDeApp.mockResolvedValueOnce({ ok: true, usuarioId: "1", wabaIds: ["666"] });

    await revisarWabas();

    expect(h.error).toHaveBeenCalledWith({ error: "Error", tenantId: TENANT }, "whatsapp.salud_fallo");
    expect(h.leerSalud).toHaveBeenCalledTimes(1);
  });
});
