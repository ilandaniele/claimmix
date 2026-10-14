/**
 * Lo que /conectar-whatsapp hace en el navegador con el SDK y el popup de Meta
 * (`meta-sdk.ts`): a qué `message` se le hace caso, cómo se junta el código con el
 * evento en el orden en que lleguen, y cómo se carga el SDK sin romper la página si
 * no carga.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  abrirRegistro,
  ESPERA_DEL_EVENTO_MS,
  leerEventoDeMeta,
  ORIGENES_DE_META,
  type SdkDeFacebook,
} from "@/app/conectar-whatsapp/meta-sdk";

const WWW = "https://www.facebook.com";
const WABA = "123456789012345";
const NUMERO = "234567890123456";
const NEGOCIO = "345678901234567";

const fin = (evento = "FINISH") => ({
  type: "WA_EMBEDDED_SIGNUP",
  event: evento,
  data: { waba_id: WABA, phone_number_id: NUMERO, business_id: NEGOCIO },
});
const cancelo = (paso: unknown = "phone_number_setup", codigo?: unknown) => ({
  type: "WA_EMBEDDED_SIGNUP",
  event: "CANCEL",
  data: { current_step: paso, ...(codigo === undefined ? {} : { error_code: codigo }) },
});

describe("leerEventoDeMeta", () => {
  describe("el origen", () => {
    it.each(ORIGENES_DE_META)("acepta %s", (origen) => {
      expect(leerEventoDeMeta(origen, fin())).not.toBeNull();
    });

    it.each([
      "https://evil-facebook.com",
      "https://www.facebook.com.evil.example.com",
      "https://facebook.com",
      "http://www.facebook.com",
      "https://www.facebook.com:8443",
      "https://notfacebook.com",
      "https://example.com",
      "null",
      "",
    ])("rechaza %j", (origen) => {
      expect(leerEventoDeMeta(origen, fin())).toBeNull();
    });
  });

  describe("la forma del mensaje", () => {
    it("lee el JSON que manda el popup como texto", () => {
      expect(leerEventoDeMeta(WWW, JSON.stringify(fin()))).toEqual({
        tipo: "fin",
        evento: "FINISH",
        wabaId: WABA,
        phoneNumberId: NUMERO,
      });
    });

    it("lee el objeto ya armado", () => {
      expect(leerEventoDeMeta(WWW, fin())).toMatchObject({ tipo: "fin", wabaId: WABA });
    });

    it.each(["{no es json", "", "null", "42", "[]", '"WA_EMBEDDED_SIGNUP"'])("un texto que no sirve (%j) no rompe y se ignora", (texto) => {
      expect(() => leerEventoDeMeta(WWW, texto)).not.toThrow();
      expect(leerEventoDeMeta(WWW, texto)).toBeNull();
    });

    it.each([null, undefined, 7, true, () => 1])("un dato que no es texto ni objeto (%s) se ignora", (dato) => {
      expect(leerEventoDeMeta(WWW, dato)).toBeNull();
    });

    it("otro tipo de mensaje se ignora", () => {
      expect(leerEventoDeMeta(WWW, { ...fin(), type: "OTRA_COSA" })).toBeNull();
      expect(leerEventoDeMeta(WWW, { event: "FINISH", data: {} })).toBeNull();
    });

    it.each([undefined, 7, "", "finish", "FINISH CON ESPACIOS", "FINISH;DROP", "A".repeat(61)])("un evento con forma rara (%j) se ignora", (evento) => {
      expect(leerEventoDeMeta(WWW, { ...fin(), event: evento })).toBeNull();
    });

    it("un evento que no es de fin ni de cancelación se ignora", () => {
      expect(leerEventoDeMeta(WWW, { type: "WA_EMBEDDED_SIGNUP", event: "PROGRESO", data: {} })).toBeNull();
    });
  });

  describe("fin", () => {
    it.each(["FINISH", "FINISH_ONLY_WABA", "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"])("%s lleva los ids", (evento) => {
      expect(leerEventoDeMeta(WWW, fin(evento))).toEqual({ tipo: "fin", evento, wabaId: WABA, phoneNumberId: NUMERO });
    });

    it("sin datos, un fin sin ids", () => {
      expect(leerEventoDeMeta(WWW, { type: "WA_EMBEDDED_SIGNUP", event: "FINISH" })).toEqual({
        tipo: "fin",
        evento: "FINISH",
        wabaId: undefined,
        phoneNumberId: undefined,
      });
    });

    it.each([42, "12", "abc", "1234567890123456789012", "12 3456", "<b>1234567</b>", null, {}])("un id con forma rara (%j) se descarta", (id) => {
      const evento = leerEventoDeMeta(WWW, { type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { waba_id: id, phone_number_id: id, business_id: id } });

      expect(evento).toMatchObject({ tipo: "fin", wabaId: undefined, phoneNumberId: undefined });
    });

    it("con datos que no son un objeto, un fin sin ids", () => {
      expect(leerEventoDeMeta(WWW, { type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: "hola" })).toMatchObject({ wabaId: undefined });
    });
  });

  describe("cancelación", () => {
    it.each(["CANCEL", "ERROR"])("%s lleva el paso", (evento) => {
      expect(leerEventoDeMeta(WWW, { type: "WA_EMBEDDED_SIGNUP", event: evento, data: { current_step: "phone_number_verification" } })).toEqual({
        tipo: "cancelo",
        paso: "phone_number_verification",
        codigo: undefined,
      });
    });

    it("un paso que no es de la lista es «otro»", () => {
      expect(leerEventoDeMeta(WWW, cancelo("<script>alert(1)</script>"))).toMatchObject({ paso: "otro" });
      expect(leerEventoDeMeta(WWW, { type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: {} })).toMatchObject({ paso: "otro" });
      expect(leerEventoDeMeta(WWW, cancelo(42))).toMatchObject({ paso: "otro" });
    });

    it("el paso en mayúsculas se reduce a la lista", () => {
      expect(leerEventoDeMeta(WWW, cancelo("PERMISSIONS"))).toMatchObject({ paso: "permissions" });
    });

    it.each([
      [100, 100],
      ["200", 200],
      ["12x", undefined],
      ["1234567890", undefined],
      [-5, -5],
      [1.5, undefined],
      [Number.MAX_SAFE_INTEGER + 2, undefined],
      [{}, undefined],
      [null, undefined],
    ])("el código de error %j sale como %j", (entrada, esperado) => {
      expect(leerEventoDeMeta(WWW, cancelo("otro", entrada))).toMatchObject({ codigo: esperado });
    });
  });
});

describe("abrirRegistro", () => {
  let alTerminar: ((respuesta: { authResponse?: { code?: string; userID?: string } | null }) => void) | null;
  let opciones: Record<string, unknown> | null;
  let fb: SdkDeFacebook;

  const mandar = (origen: string, datos: unknown) => window.dispatchEvent(new MessageEvent("message", { origin: origen, data: datos }));
  const responder = (code?: string | null) => alTerminar?.(code === undefined ? {} : { authResponse: code === null ? null : { code } });

  beforeEach(() => {
    vi.useFakeTimers();
    alTerminar = null;
    opciones = null;
    fb = {
      init: vi.fn(),
      login: vi.fn((cb, op) => {
        alTerminar = cb;
        opciones = op;
      }),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const abrir = (extra: { setup?: object; esperaMs?: number } = {}) => abrirRegistro({ fb, configId: "fake-config-id", setup: extra.setup, esperaMs: extra.esperaMs });

  it("llama a FB.login en el momento, sin esperar nada (el navegador sólo abre el popup dentro del clic)", () => {
    void abrir();

    expect(fb.login).toHaveBeenCalledOnce();
  });

  it("pide el código con el config_id y el setup, sin version ni featureType", () => {
    void abrir({ setup: { business: { name: "Aseguradora Sur" } } });

    expect(opciones).toEqual({
      config_id: "fake-config-id",
      response_type: "code",
      override_default_response_type: true,
      extras: { setup: { business: { name: "Aseguradora Sur" } } },
    });
    expect(JSON.stringify(opciones)).not.toContain("featureType");
  });

  it("sin setup manda uno vacío", () => {
    void abrir();

    expect(opciones).toMatchObject({ extras: { setup: {} } });
  });

  it("evento y después código: sigue en cuanto llega el código", async () => {
    const salida = abrir();
    mandar(WWW, fin());
    responder("fake-code");

    await expect(salida).resolves.toEqual({
      tipo: "codigo",
      code: "fake-code",
      evento: "FINISH",
      wabaId: WABA,
      phoneNumberId: NUMERO,
    });
  });

  it("código y después evento: sigue en cuanto llega el evento", async () => {
    const salida = abrir();
    responder("fake-code");
    mandar(WWW, JSON.stringify(fin("FINISH_ONLY_WABA")));

    await expect(salida).resolves.toMatchObject({ tipo: "codigo", code: "fake-code", evento: "FINISH_ONLY_WABA", wabaId: WABA });
  });

  it("código sin evento: espera un rato corto y sigue con el código solo", async () => {
    const salida = abrir();
    responder("fake-code");
    let listo = false;
    void salida.then(() => (listo = true));

    await vi.advanceTimersByTimeAsync(ESPERA_DEL_EVENTO_MS - 1);
    expect(listo).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(salida).resolves.toEqual({
      tipo: "codigo",
      code: "fake-code",
      evento: undefined,
      wabaId: undefined,
      phoneNumberId: undefined,
    });
  });

  it("el userID del authResponse viaja como pista del usuario de Facebook; si no son dígitos se descarta", async () => {
    const conId = abrir();
    mandar(WWW, fin());
    alTerminar?.({ authResponse: { code: "fake-code", userID: "1234567890" } });
    await expect(conId).resolves.toMatchObject({ tipo: "codigo", code: "fake-code", userId: "1234567890" });

    const raro = abrir();
    mandar(WWW, fin());
    alTerminar?.({ authResponse: { code: "fake-code", userID: "no-es-un-id" } });
    const salida = await raro;
    expect(salida).toMatchObject({ tipo: "codigo", code: "fake-code" });
    expect(salida.tipo === "codigo" ? salida.userId : "no-es-codigo").toBeUndefined();
  });

  it("la espera es de 3 segundos: bastante menos que los 30 que vive el código", () => {
    expect(ESPERA_DEL_EVENTO_MS).toBe(3000);
  });

  it("respeta la espera que se le pida", async () => {
    const salida = abrir({ esperaMs: 50 });
    responder("fake-code");

    await vi.advanceTimersByTimeAsync(50);

    await expect(salida).resolves.toMatchObject({ tipo: "codigo", code: "fake-code" });
  });

  it("una cancelación llega primero: el popup no dio código", async () => {
    const salida = abrir();
    mandar(WWW, cancelo("phone_number_setup", 100));
    responder(null);

    await expect(salida).resolves.toEqual({ tipo: "cancelo", paso: "phone_number_setup", codigo: 100 });
  });

  it("la cancelación llega aunque el callback venga antes", async () => {
    const salida = abrir();
    responder(undefined);
    mandar(WWW, cancelo("permissions"));

    await expect(salida).resolves.toMatchObject({ tipo: "cancelo", paso: "permissions" });
  });

  it("la cancelación gana aunque ya hubiera código", async () => {
    const salida = abrir();
    responder("fake-code");
    mandar(WWW, cancelo("permissions"));

    await expect(salida).resolves.toMatchObject({ tipo: "cancelo", paso: "permissions" });
  });

  it("se cerró el popup sin código ni evento: espera un rato y es una cancelación en «otro»", async () => {
    const salida = abrir();
    responder(null);

    await vi.advanceTimersByTimeAsync(ESPERA_DEL_EVENTO_MS);

    await expect(salida).resolves.toEqual({ tipo: "cancelo", paso: "otro" });
  });

  it("un callback sin authResponse es lo mismo que un cierre", async () => {
    const salida = abrir({ esperaMs: 10 });
    responder(undefined);

    await vi.advanceTimersByTimeAsync(10);

    await expect(salida).resolves.toEqual({ tipo: "cancelo", paso: "otro" });
  });

  it("un código que no es texto no cuenta", async () => {
    const salida = abrir({ esperaMs: 10 });
    alTerminar?.({ authResponse: { code: 123 as unknown as string } });

    await vi.advanceTimersByTimeAsync(10);

    await expect(salida).resolves.toEqual({ tipo: "cancelo", paso: "otro" });
  });

  describe("el oyente", () => {
    it("ignora un message de un origen que no es de Meta", async () => {
      const salida = abrir({ esperaMs: 10 });
      mandar("https://evil-facebook.com", fin());
      responder("fake-code");

      await vi.advanceTimersByTimeAsync(10);

      await expect(salida).resolves.toMatchObject({ tipo: "codigo", evento: undefined, wabaId: undefined });
    });

    it("ignora una cancelación falsa de otro origen", async () => {
      const salida = abrir({ esperaMs: 10 });
      mandar("https://evil-facebook.com", cancelo());
      responder("fake-code");
      mandar(WWW, fin());

      await expect(salida).resolves.toMatchObject({ tipo: "codigo", code: "fake-code", wabaId: WABA });
    });

    it("ignora un message que no es JSON", async () => {
      const salida = abrir({ esperaMs: 10 });
      expect(() => mandar(WWW, "{roto")).not.toThrow();
      responder("fake-code");
      mandar(WWW, fin());

      await expect(salida).resolves.toMatchObject({ tipo: "codigo", wabaId: WABA });
    });

    it("se va cuando termina: un message tardío no hace nada", async () => {
      const quitar = vi.spyOn(window, "removeEventListener");
      const salida = abrir();
      responder("fake-code");
      mandar(WWW, fin());
      await salida;

      expect(quitar).toHaveBeenCalledWith("message", expect.any(Function));
      expect(() => mandar(WWW, cancelo())).not.toThrow();
    });

    it("se va también cuando termina por el plazo", async () => {
      const quitar = vi.spyOn(window, "removeEventListener");
      const salida = abrir({ esperaMs: 5 });
      responder("fake-code");
      await vi.advanceTimersByTimeAsync(5);
      await salida;

      expect(quitar).toHaveBeenCalledWith("message", expect.any(Function));
    });

    it("dos popups seguidos no se pisan", async () => {
      const primero = abrir({ esperaMs: 5 });
      responder("fake-code-1");
      mandar(WWW, fin());
      await expect(primero).resolves.toMatchObject({ code: "fake-code-1" });

      const segundo = abrir({ esperaMs: 5 });
      responder("fake-code-2");
      mandar(WWW, { ...fin(), data: { waba_id: "999999999999999" } });
      await expect(segundo).resolves.toMatchObject({ code: "fake-code-2", wabaId: "999999999999999" });
    });
  });
});

describe("cargarSdk", () => {
  const scripts = () => Array.from(document.head.querySelectorAll<HTMLScriptElement>('script[src*="connect.facebook.net"]'));
  const pedido = { appId: "fake-app-id", version: "v23.0", idioma: "es_LA" as const };
  const fbFalso = (): SdkDeFacebook => ({ init: vi.fn(), login: vi.fn() });
  /** El módulo guarda la promesa de la carga: cada test arranca con uno nuevo. */
  const cargador = async () => (await import("@/app/conectar-whatsapp/meta-sdk")).cargarSdk;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    scripts().forEach((s) => s.remove());
    delete window.FB;
    delete window.fbAsyncInit;
  });

  it("inyecta el script del SDK en el idioma pedido, async y sin credenciales", async () => {
    const cargar = await cargador();
    void cargar({ ...pedido, idioma: "en_US" });

    expect(scripts()).toHaveLength(1);
    const [script] = scripts();
    expect(script.src).toBe("https://connect.facebook.net/en_US/sdk.js");
    expect(script.async).toBe(true);
    expect(script.crossOrigin).toBe("anonymous");
  });

  it("al cargar inicia el SDK sin xfbml ni eventos de la app, y resuelve con él", async () => {
    const cargar = await cargador();
    const promesa = cargar(pedido);
    const fb = fbFalso();
    window.FB = fb;
    window.fbAsyncInit?.();

    await expect(promesa).resolves.toBe(fb);
    expect(fb.init).toHaveBeenCalledWith({ appId: "fake-app-id", version: "v23.0", xfbml: false, autoLogAppEvents: false });
  });

  it("pedirlo dos veces es una sola carga", async () => {
    const cargar = await cargador();
    const a = cargar(pedido);
    const b = cargar(pedido);

    expect(b).toBe(a);
    expect(scripts()).toHaveLength(1);
  });

  it("un bloqueador que corta el script: rechaza, saca el script y deja reintentar de cero", async () => {
    const cargar = await cargador();
    const promesa = cargar(pedido);
    const rechazo = expect(promesa).rejects.toThrow("sdk_bloqueado");
    scripts()[0].onerror?.(new Event("error"));
    await rechazo;

    expect(scripts()).toHaveLength(0);
    expect(window.fbAsyncInit).toBeUndefined();

    const otra = cargar(pedido);
    expect(otra).not.toBe(promesa);
    expect(scripts()).toHaveLength(1);
    const fb = fbFalso();
    window.FB = fb;
    window.fbAsyncInit?.();
    await expect(otra).resolves.toBe(fb);
  });

  it("si en diez segundos no cargó, rechaza por tiempo", async () => {
    const cargar = await cargador();
    const rechazo = expect(cargar(pedido)).rejects.toThrow("sdk_timeout");

    await vi.advanceTimersByTimeAsync(10_000);
    await rechazo;

    expect(scripts()).toHaveLength(0);
  });

  it("no rechaza antes de tiempo", async () => {
    const cargar = await cargador();
    let rechazada = false;
    cargar(pedido).catch(() => (rechazada = true));

    await vi.advanceTimersByTimeAsync(9_999);

    expect(rechazada).toBe(false);
  });

  it("si el script carga pero no deja FB, rechaza", async () => {
    const cargar = await cargador();
    const rechazo = expect(cargar(pedido)).rejects.toThrow("sdk_vacio");
    delete window.FB;
    window.fbAsyncInit?.();

    await rechazo;
    expect(scripts()).toHaveLength(0);
  });

  it("cargado a tiempo, el plazo ya no corre", async () => {
    const cargar = await cargador();
    const promesa = cargar(pedido);
    window.FB = fbFalso();
    window.fbAsyncInit?.();
    await promesa;

    await vi.advanceTimersByTimeAsync(20_000);

    expect(scripts()).toHaveLength(1);
  });
});
