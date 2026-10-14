/**
 * /api/webhooks/whatsapp/app/[ruta]: el webhook de la app de Meta de un cliente.
 *
 * Corren de verdad la firma, los parsers, los cupos en memoria y el orden de los pasos;
 * la base, Graph, el agente y el descifrado del secreto están simulados. Lo que importa
 * acá es el orden (formato, cupos, fila, tope, secreto, firma) y que una firma mala o una
 * ruta inventada nunca cuesten más de lo que prometen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "crypto";

const h = vi.hoisted(() => {
  const afterCallbacks: Array<() => unknown | Promise<unknown>> = [];
  return {
    afterCallbacks,
    mockAfter: vi.fn((cb: () => unknown | Promise<unknown>) => {
      afterCallbacks.push(cb);
    }),
    appDeLaRuta: vi.fn(),
    credenciales: vi.fn(),
    abrirSobre: vi.fn(),
    webhookVerificado: vi.fn(),
    primerMensaje: vi.fn(),
    wabaEnFalla: vi.fn(),
    aviso: vi.fn(),
    atenderEventos: vi.fn(),
    atenderLote: vi.fn(),
    leerApp: vi.fn(),
    revisarTokenDeApp: vi.fn(),
    rateLimit: vi.fn(),
    derivar: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: h.mockAfter };
});
vi.mock("@/lib/observability/logger", () => ({
  logger: { info: h.info, warn: h.warn, error: h.error, debug: vi.fn() },
}));
vi.mock("@/lib/rate-limit", () => ({
  getClientIp: (req: Request) => req.headers.get("x-forwarded-for") ?? "unknown",
  rateLimit: h.rateLimit,
  RATE_LIMIT_CONFIGS: { REVISION_SECRETO: { limit: 1, windowMs: 3_600_000, fallaCerrada: true } },
}));
vi.mock("@/server/alta/sellado", () => ({ derivar: h.derivar }));
vi.mock("@/server/alta/aviso-operador", () => ({ avisarNumeroEnRevision: h.aviso }));
vi.mock("@/server/alta/eventos-de-cuenta", () => ({ atenderEventosDeCuenta: h.atenderEventos }));
vi.mock("@/server/alta/panel-operador", () => ({
  primerMensajeDeApp: h.primerMensaje,
  wabaEnFalla: h.wabaEnFalla,
  webhookDeAppVerificado: h.webhookVerificado,
}));
vi.mock("@/server/whatsapp/app-del-cliente", () => ({ leerApp: h.leerApp, revisarTokenDeApp: h.revisarTokenDeApp }));
vi.mock("@/server/whatsapp/numeros", () => ({ appDeLaRuta: h.appDeLaRuta, credencialesWhatsApp: h.credenciales }));
vi.mock("@/server/whatsapp/sobres-del-cliente", () => ({
  aadDelSecreto: (tenantId: string, appId: string) => `${tenantId}|${appId}`,
  abrirSobre: h.abrirSobre,
}));
vi.mock("@/server/whatsapp/webhook-de-meta", () => ({ atenderLoteDeMeta: h.atenderLote }));

import { checkRateLimit, clearAllRateLimits } from "@/lib/rate-limit/memory";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { GET, POST, maxDuration } from "@/app/api/webhooks/whatsapp/app/[ruta]/route";

const TENANT = "10000000-0000-4000-8000-000000000001";
const APP_ID = "fake-app-id";
const WABA = "555000111222";
const NUMERO = "111111111111111";
const OTRO_NUMERO = "222222222222222";
const SECRETO = "fake-client-app-secret";
const MARCA = "marca-de-la-ruta";

let contador = 0;
/** Una ruta válida (22 caracteres base64url) distinta por prueba: los cupos en memoria no se limpian solos. */
const rutaNueva = () => `R${String(++contador).padStart(21, "0")}`;

const fila = (cambios: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  appId: APP_ID,
  secretoCifrado: "sobre-cifrado",
  wabaId: WABA,
  phoneNumberId: NUMERO,
  estado: "conectada",
  numeroEstado: "conectado",
  primerMensaje: false,
  sinServicio: false,
  actualizadoEn: 1_790_000_000_000,
  ...cambios,
});

const firmar = (cuerpo: string, secreto = SECRETO) => "sha256=" + createHmac("sha256", secreto).update(cuerpo).digest("hex");
const ctx = (ruta: string) => ({ params: Promise.resolve({ ruta }) });

function post(ruta: string, cuerpo: string, firma: string | null, ip = "203.0.113.7", extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": ip, ...extra };
  if (firma) headers["x-hub-signature-256"] = firma;
  return POST(
    new NextRequest(`http://localhost/api/webhooks/whatsapp/app/${ruta}`, { method: "POST", headers, body: cuerpo }),
    ctx(ruta)
  );
}

/** Firmado con el secreto de la fila, que es lo que manda Meta. */
const postBueno = (ruta: string, cuerpo: string, ip?: string) => post(ruta, cuerpo, firmar(cuerpo), ip);

const mensajes = (numero = NUMERO, id = "wamid.1") =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: WABA,
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: numero },
              contacts: [{ wa_id: "5492916426930", profile: { name: "Ilan" } }],
              messages: [{ from: "5492916426930", id: id, type: "text", text: { body: "Tuve un choque" } }],
            },
          },
        ],
      },
    ],
  });

const cuenta = (waba = WABA, campo = "account_update", valor: Record<string, unknown> = { event: "PARTNER_APP_UNINSTALLED" }) =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: waba, time: 1_790_000_000, changes: [{ field: campo, value: { ...valor, waba_info: { waba_id: waba } } }] }],
  });

const vaciarAfter = () => Promise.all(h.afterCallbacks.splice(0).map((cb) => cb()));

beforeEach(() => {
  h.afterCallbacks.length = 0;
  clearAllRateLimits();
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.com";
  process.env.WHATSAPP_APP_SECRET = "fake-platform-app-secret";
  h.derivar.mockReturnValue(MARCA);
  h.webhookVerificado.mockResolvedValue(true);
  h.appDeLaRuta.mockResolvedValue(fila());
  h.abrirSobre.mockReturnValue(SECRETO);
  h.credenciales.mockResolvedValue({ accessToken: "test-client-system-token-key" });
  h.revisarTokenDeApp.mockResolvedValue({ ok: false, motivo: "token_vencido" });
  h.leerApp.mockResolvedValue({ ok: false, falla: "rechazo" });
  h.rateLimit.mockResolvedValue({ allowed: true });
  h.primerMensaje.mockResolvedValue(undefined);
  h.wabaEnFalla.mockResolvedValue(true);
  h.aviso.mockResolvedValue(undefined);
  h.atenderEventos.mockResolvedValue(undefined);
  h.atenderLote.mockResolvedValue({ status: 200, cuerpo: { ok: true, received: 1, case_ids: ["caso-1"] } });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ── GET: el apretón de manos ─────────────────────────────────────────────────

describe("GET: verificación del webhook", () => {
  const get = (ruta: string, consulta: string) =>
    GET(new NextRequest(`http://localhost/api/webhooks/whatsapp/app/${ruta}?${consulta}`), ctx(ruta));
  const buena = (desafio = "1234") => `hub.mode=subscribe&hub.verify_token=${MARCA}&hub.challenge=${encodeURIComponent(desafio)}`;

  it("con la marca correcta repite el desafío como texto plano y marca el webhook como verificado", async () => {
    const ruta = rutaNueva();
    const res = await get(ruta, buena("Ab-12_3"));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Ab-12_3");
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(h.derivar).toHaveBeenCalledWith("wa-verify-app", ruta);
    expect(h.webhookVerificado).toHaveBeenCalledWith(ruta);
  });

  it.each(["", "corta", "x".repeat(23), "con espacio ñ1234567890123", "a/b".padEnd(22, "0")])(
    "una ruta mal formada (%j) da 404 sin tocar la derivación ni la base",
    async (ruta) => {
      const res = await get(ruta, buena());

      expect(res.status).toBe(404);
      expect(h.derivar).not.toHaveBeenCalled();
      expect(h.webhookVerificado).not.toHaveBeenCalled();
    }
  );

  it("con una marca equivocada da 403 sin consultar la base", async () => {
    const res = await get(rutaNueva(), "hub.mode=subscribe&hub.verify_token=otra&hub.challenge=1234");

    expect(res.status).toBe(403);
    expect(h.webhookVerificado).not.toHaveBeenCalled();
  });

  it("con el token de la plataforma tampoco: la marca es de la ruta, no del ambiente", async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-de-la-plataforma";
    const res = await get(rutaNueva(), "hub.mode=subscribe&hub.verify_token=verify-de-la-plataforma&hub.challenge=1234");

    expect(res.status).toBe(403);
    delete process.env.WHATSAPP_VERIFY_TOKEN;
  });

  it.each([
    ["con espacios", "a b"],
    ["con acentos", "ñandú"],
    ["demasiado largo", "x".repeat(257)],
    ["vacío", ""],
  ])("un desafío %s no se repite: 400", async (_nombre, desafio) => {
    const res = await get(rutaNueva(), buena(desafio));

    expect(res.status).toBe(400);
    expect(h.webhookVerificado).not.toHaveBeenCalled();
  });

  it("una ruta que no es de ninguna fila viva da 404 aunque la marca sea la derivada", async () => {
    h.webhookVerificado.mockResolvedValue(false);

    expect((await get(rutaNueva(), buena())).status).toBe(404);
  });

  it("si la base falla da 500 y no repite el desafío", async () => {
    h.webhookVerificado.mockRejectedValue(new Error("neon caído"));

    const res = await get(rutaNueva(), buena());

    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("1234");
  });

  it("si no se puede derivar la marca da 500", async () => {
    h.derivar.mockImplementation(() => {
      throw new Error("falta el secreto");
    });

    expect((await get(rutaNueva(), buena())).status).toBe(500);
    expect(h.webhookVerificado).not.toHaveBeenCalled();
  });
});

// ── POST: antes de la firma ──────────────────────────────────────────────────

describe("POST: lo que se corta antes de descifrar nada", () => {
  it("una ruta mal formada da 404 sin cupo, fila ni descifrado", async () => {
    const res = await post("corta", mensajes(), null);

    expect(res.status).toBe(404);
    expect(h.appDeLaRuta).not.toHaveBeenCalled();
    expect(h.abrirSobre).not.toHaveBeenCalled();
  });

  it("una ruta que no es de nadie da 404 y no abre ningún sobre", async () => {
    h.appDeLaRuta.mockResolvedValue(null);

    const res = await post(rutaNueva(), mensajes(), firmar(mensajes()));

    expect(res.status).toBe(404);
    expect(h.abrirSobre).not.toHaveBeenCalled();
    expect(h.atenderLote).not.toHaveBeenCalled();
  });

  it("si la base no contesta da 500 para que Meta reintente", async () => {
    h.appDeLaRuta.mockRejectedValue(new Error("neon caído"));

    const res = await post(rutaNueva(), mensajes(), firmar(mensajes()));

    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("ROUTING_FAILED");
    expect(h.atenderLote).not.toHaveBeenCalled();
  });

  it("S14: 4 MB sin Content-Length dan 413 sin descifrar el secreto", async () => {
    const trozo = new Uint8Array(1024 * 1024);
    let enviados = 0;
    const flujo = new ReadableStream<Uint8Array>({
      pull(controlador) {
        if (enviados++ < 4) controlador.enqueue(trozo);
        else controlador.close();
      },
    });
    const ruta = rutaNueva();
    const req = new NextRequest(`http://localhost/api/webhooks/whatsapp/app/${ruta}`, {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.7" },
      body: flujo,
      duplex: "half",
    } as unknown as ConstructorParameters<typeof NextRequest>[1]);

    const res = await POST(req, ctx(ruta));

    expect(res.status).toBe(413);
    expect(h.abrirSobre).not.toHaveBeenCalled();
  });

  it("un Content-Length declarado sobre el tope da 413 sin leer ni descifrar", async () => {
    const res = await post(rutaNueva(), mensajes(), firmar(mensajes()), "203.0.113.7", {
      "content-length": String(5 * 1024 * 1024),
    });

    expect(res.status).toBe(413);
    expect(h.abrirSobre).not.toHaveBeenCalled();
  });

  it("un pedido sin cuerpo da 400", async () => {
    const ruta = rutaNueva();
    const res = await POST(
      new NextRequest(`http://localhost/api/webhooks/whatsapp/app/${ruta}`, { method: "POST" }),
      ctx(ruta)
    );

    expect(res.status).toBe(400);
    expect(h.abrirSobre).not.toHaveBeenCalled();
  });

  it("si el secreto no abre da 500 y no acepta nada", async () => {
    h.abrirSobre.mockReturnValue(null);

    const res = await postBueno(rutaNueva(), mensajes());

    expect(res.status).toBe(500);
    expect(h.atenderLote).not.toHaveBeenCalled();
  });

  it("abre el sobre con el AAD del inquilino y la app de la fila", async () => {
    await postBueno(rutaNueva(), mensajes());

    expect(h.abrirSobre).toHaveBeenCalledWith("sobre-cifrado", `${TENANT}|${APP_ID}`);
  });
});

// ── POST: cupos ──────────────────────────────────────────────────────────────

describe("POST: cupos en memoria", () => {
  it("el pedido 61 del minuto desde una IP recibe 429 con Retry-After y sin consultar la base", async () => {
    const ruta = rutaNueva();
    const cuerpo = mensajes();
    for (let i = 0; i < 60; i++) await post(ruta, cuerpo, null, "203.0.113.9");
    expect(h.appDeLaRuta).toHaveBeenCalledTimes(60);

    const res = await post(ruta, cuerpo, null, "203.0.113.9");

    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(h.appDeLaRuta).toHaveBeenCalledTimes(60);
  });

  it("el pedido 121 de la ruta, aunque venga de otra IP, recibe 429 sin consultar la base", async () => {
    const ruta = rutaNueva();
    const cuerpo = mensajes();
    for (let i = 0; i < 120; i++) await post(ruta, cuerpo, null, `198.51.100.${i % 250}`);
    expect(h.appDeLaRuta).toHaveBeenCalledTimes(120);

    const res = await post(ruta, cuerpo, null, "192.0.2.77");

    expect(res.status).toBe(429);
    expect(h.appDeLaRuta).toHaveBeenCalledTimes(120);
    // Si sólo el cupo de la ruta negó, el de IP devuelve el intento: no se queda con un lugar que no usó.
    expect(checkRateLimit(claveDeCupo("wa:firma:ip", "192.0.2.77"), 1, 60_000).allowed).toBe(true);
  });

  it("inventar rutas distintas desde una IP no estrena cupo: el pedido 61 da 429 sin consultar la base", async () => {
    h.appDeLaRuta.mockResolvedValue(null);
    for (let i = 0; i < 60; i++) {
      expect((await post(rutaNueva(), mensajes(), null, "203.0.113.50")).status).toBe(404);
    }
    expect(h.appDeLaRuta).toHaveBeenCalledTimes(60);

    const res = await post(rutaNueva(), mensajes(), null, "203.0.113.50");

    expect(res.status).toBe(429);
    expect(h.appDeLaRuta).toHaveBeenCalledTimes(60);
  });

  it("una firma buena devuelve los dos cupos: Meta puede mandar más de 120 lotes por minuto", async () => {
    const ruta = rutaNueva();
    const cuerpo = mensajes();
    const estados: number[] = [];
    for (let i = 0; i < 130; i++) estados.push((await postBueno(ruta, cuerpo)).status);

    expect(estados.every((s) => s === 200)).toBe(true);
  });
});

// ── POST: la firma ───────────────────────────────────────────────────────────

describe("POST: firma", () => {
  it.each([
    ["sin cabecera", null],
    ["con basura", "sha256=zzz"],
    ["con otro algoritmo", "sha1=" + "a".repeat(40)],
    ["firmada con otro secreto", firmar(mensajes(), "fake-otro-secreto")],
  ])("%s da 401 y no toca el estado", async (_nombre, firma) => {
    const res = await post(rutaNueva(), mensajes(), firma);

    expect(res.status).toBe(401);
    expect(h.atenderLote).not.toHaveBeenCalled();
    expect(h.atenderEventos).not.toHaveBeenCalled();
    expect(h.primerMensaje).not.toHaveBeenCalled();
    expect(h.wabaEnFalla).not.toHaveBeenCalled();
    expect(h.mockAfter).not.toHaveBeenCalled();
  });

  it("S4: un cuerpo firmado con el secreto de la plataforma no sirve acá", async () => {
    const cuerpo = mensajes();
    const res = await post(rutaNueva(), cuerpo, firmar(cuerpo, "fake-platform-app-secret"));

    expect(res.status).toBe(401);
    expect(h.atenderLote).not.toHaveBeenCalled();
  });

  it("no hay camino con Bearer: un normalizado con el secreto de la plataforma da 401", async () => {
    const res = await post(
      rutaNueva(),
      JSON.stringify({ from: "5492916426930", body: "hola", providerMessageId: "x" }),
      null,
      "203.0.113.7",
      { authorization: "Bearer fake-bearer-secret" }
    );

    expect(res.status).toBe(401);
    expect(h.atenderLote).not.toHaveBeenCalled();
  });

  it("anota la firma inválida con el inquilino y sin el cuerpo, la cabecera ni el secreto", async () => {
    await post(rutaNueva(), mensajes(), "sha256=" + "0".repeat(64));

    expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT }, "whatsapp.webhook.app_firma_invalida");
    const anotado = JSON.stringify([...h.warn.mock.calls, ...h.info.mock.calls, ...h.error.mock.calls]);
    expect(anotado).not.toContain(SECRETO);
    expect(anotado).not.toContain("0".repeat(64));
  });

  it("R1: pasadas 20 firmas malas por hora pregunta una sola vez a Meta, y si no confirma no escribe nada", async () => {
    const ruta = rutaNueva();
    h.leerApp.mockResolvedValue({ ok: true });
    for (let i = 0; i < 25; i++) await post(ruta, mensajes(), null, `198.51.100.${i}`);

    expect(h.rateLimit).toHaveBeenCalledTimes(1);
    expect(h.rateLimit).toHaveBeenCalledWith(
      claveDeCupo("wa:firma:revision", ruta),
      expect.objectContaining({ limit: 1, fallaCerrada: true })
    );
    await vaciarAfter();

    expect(h.leerApp).toHaveBeenCalledTimes(1);
    expect(h.leerApp).toHaveBeenCalledWith({ appId: APP_ID, secreto: SECRETO }, `https://example.com/api/webhooks/whatsapp/app/${ruta}`);
    expect(h.wabaEnFalla).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("R1: si Meta no contesta (falla pasajera) tampoco se da de baja nada", async () => {
    h.leerApp.mockResolvedValue({ ok: false, falla: "esperar" });
    const ruta = rutaNueva();
    for (let i = 0; i < 20; i++) await post(ruta, mensajes(), null, `198.51.100.${i}`);
    await vaciarAfter();

    expect(h.leerApp).toHaveBeenCalledTimes(1);
    expect(h.wabaEnFalla).not.toHaveBeenCalled();
  });

  it("R1: si Meta rechaza el secreto guardado, la cuenta pasa a falla y el operador recibe el aviso", async () => {
    const ruta = rutaNueva();
    for (let i = 0; i < 20; i++) await post(ruta, mensajes(), null, `198.51.100.${i}`);
    await vaciarAfter();

    // Atada al secreto que se probó: si el cliente ya pegó uno nuevo, la falla era del viejo y no se marca.
    expect(h.wabaEnFalla).toHaveBeenCalledWith(TENANT, "secreto_invalido", { secretoCifrado: "sobre-cifrado" });
    expect(h.aviso).toHaveBeenCalledWith("secreto_invalido", TENANT);
  });

  it("R1: si el cliente ya cambió el secreto (la fila no cambió), no hay falla ni aviso falso al operador", async () => {
    h.wabaEnFalla.mockResolvedValue(false);
    const ruta = rutaNueva();
    for (let i = 0; i < 20; i++) await post(ruta, mensajes(), null, `198.51.100.${i}`);
    await vaciarAfter();

    expect(h.wabaEnFalla).toHaveBeenCalledTimes(1);
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("R1: si el contador de Postgres niega la hora, no se pregunta a Meta", async () => {
    h.rateLimit.mockResolvedValue({ allowed: false });
    const ruta = rutaNueva();
    for (let i = 0; i < 22; i++) await post(ruta, mensajes(), null, `198.51.100.${i}`);

    expect(h.mockAfter).not.toHaveBeenCalled();
    expect(h.leerApp).not.toHaveBeenCalled();
  });

  it("R1: la revisión nunca tira aunque Graph o la base fallen", async () => {
    h.leerApp.mockRejectedValue(new Error("red caída"));
    const ruta = rutaNueva();
    for (let i = 0; i < 20; i++) await post(ruta, mensajes(), null, `198.51.100.${i}`);

    await expect(vaciarAfter()).resolves.toBeDefined();
    expect(h.error).toHaveBeenCalledWith(expect.any(Object), "whatsapp.webhook.app_revision_fallo");
  });

  it("las firmas buenas no suman al tope de malas", async () => {
    const ruta = rutaNueva();
    for (let i = 0; i < 25; i++) await postBueno(ruta, mensajes(), `198.51.100.${i}`);

    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.leerApp).not.toHaveBeenCalled();
  });
});

// ── POST: mensajes ───────────────────────────────────────────────────────────

describe("POST: mensajes", () => {
  it("un JSON roto con firma buena da 400", async () => {
    const roto = "{no es json";
    const res = await post(rutaNueva(), roto, firmar(roto));

    expect(res.status).toBe(400);
    expect(h.atenderLote).not.toHaveBeenCalled();
  });

  it("entrega el lote al mismo camino que la plataforma y contesta con su cuerpo", async () => {
    const res = await postBueno(rutaNueva(), mensajes());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, received: 1, case_ids: ["caso-1"] });
    expect(h.atenderLote).toHaveBeenCalledTimes(1);
    const [lote, , hasta] = h.atenderLote.mock.calls[0];
    expect(lote).toHaveLength(1);
    expect(lote[0]).toMatchObject({ from: "5492916426930", providerMessageId: "wamid.1", toPhoneNumberId: NUMERO });
    expect(hasta).toBeGreaterThan(Date.now() + (maxDuration - 5) * 1000);
  });

  it("el dueño del número lo dice la ruta: sólo el número de la fila resuelve al inquilino", async () => {
    await postBueno(rutaNueva(), mensajes());

    const tenantDe = h.atenderLote.mock.calls[0][1] as (n: string) => string | undefined;
    expect(tenantDe(NUMERO)).toBe(TENANT);
    expect(tenantDe(OTRO_NUMERO)).toBeUndefined();
  });

  it("un mensaje para otro phone_number_id se descarta y se cuenta, sin tocar el inquilino", async () => {
    const res = await postBueno(rutaNueva(), mensajes(OTRO_NUMERO));

    expect(res.status).toBe(200);
    expect(h.atenderLote.mock.calls[0]?.[0] ?? []).toHaveLength(0);
    expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT, cantidad: 1 }, "whatsapp.webhook.app_ajena");
    expect(h.primerMensaje).not.toHaveBeenCalled();
    expect(h.mockAfter).not.toHaveBeenCalled();
  });

  it("una fila sin número vivo descarta todo lo que llegue", async () => {
    h.appDeLaRuta.mockResolvedValue(fila({ phoneNumberId: null, numeroEstado: null }));

    const res = await postBueno(rutaNueva(), mensajes());

    expect(res.status).toBe(200);
    expect(h.atenderLote).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT, cantidad: 1 }, "whatsapp.webhook.app_ajena");
  });

  it.each([
    ["el número no está conectado", { numeroEstado: "pendiente" }],
    ["el número está dado de baja", { numeroEstado: "baja" }],
    ["el inquilino no tiene servicio", { sinServicio: true }],
    ["la WABA está cancelada", { estado: "cancelada" }],
    ["la WABA está revocada", { estado: "revocada" }],
    ["la WABA todavía se está armando", { estado: "pendiente" }],
  ])("firma buena pero %s: se acusa con 200 y no se guarda nada", async (_nombre, cambios) => {
    h.appDeLaRuta.mockResolvedValue(fila(cambios));

    const res = await postBueno(rutaNueva(), mensajes());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, received: 0, case_ids: [] });
    expect(h.atenderLote).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, cantidad: 1 }),
      "whatsapp.webhook.app_sin_servicio"
    );
  });

  describe("el caché de la fila puede ir 30 s atrasado", () => {
    const pedido = fila({ estado: "falta_pin", numeroEstado: "pedido" });
    const conectado = fila({ estado: "conectada", numeroEstado: "conectado" });

    it("si dice «no guardes» y llegan mensajes, lee la fila de nuevo antes de descartar (Meta no reintenta un 200)", async () => {
      const ruta = rutaNueva();
      h.appDeLaRuta.mockResolvedValueOnce(pedido).mockResolvedValueOnce(conectado);

      const res = await postBueno(ruta, mensajes());

      expect(res.status).toBe(200);
      expect(h.appDeLaRuta).toHaveBeenCalledTimes(2);
      expect(h.appDeLaRuta).toHaveBeenNthCalledWith(1, ruta);
      expect(h.appDeLaRuta).toHaveBeenNthCalledWith(2, ruta, { fresca: true });
      expect(h.atenderLote).toHaveBeenCalledTimes(1);
      expect(h.atenderLote.mock.calls[0][0]).toHaveLength(1);
      expect(h.warn).not.toHaveBeenCalledWith(expect.anything(), "whatsapp.webhook.app_sin_servicio");
    });

    it("el número que se registró hace segundos también sirve: la fila vieja no lo traía", async () => {
      h.appDeLaRuta
        .mockResolvedValueOnce(fila({ estado: "falta_pin", phoneNumberId: null, numeroEstado: null }))
        .mockResolvedValueOnce(conectado);

      await postBueno(rutaNueva(), mensajes());

      expect(h.atenderLote).toHaveBeenCalledTimes(1);
      const tenantDe = h.atenderLote.mock.calls[0][1] as (n: string) => string | undefined;
      expect(tenantDe(NUMERO)).toBe(TENANT);
      expect(h.warn).not.toHaveBeenCalledWith(expect.anything(), "whatsapp.webhook.app_ajena");
    });

    it("si la fila de ahora tampoco guarda, se acusa y se avisa en el log con el estado de ahora", async () => {
      h.appDeLaRuta.mockResolvedValueOnce(pedido).mockResolvedValueOnce(fila({ estado: "revocada", numeroEstado: "baja" }));

      const res = await postBueno(rutaNueva(), mensajes());

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, received: 0, case_ids: [] });
      expect(h.atenderLote).not.toHaveBeenCalled();
      expect(h.warn).toHaveBeenCalledWith({ tenantId: TENANT, cantidad: 1, estado: "revocada" }, "whatsapp.webhook.app_sin_servicio");
    });

    it("si la fila ya guardaba, no hay segunda lectura", async () => {
      await postBueno(rutaNueva(), mensajes());

      expect(h.appDeLaRuta).toHaveBeenCalledTimes(1);
    });

    it("sin mensajes (sólo estados de entrega) no hay segunda lectura aunque la fila no guarde", async () => {
      h.appDeLaRuta.mockResolvedValue(pedido);
      const soloEstados = JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ id: WABA, changes: [{ field: "messages", value: { metadata: { phone_number_id: NUMERO }, statuses: [{ id: "wamid.9", status: "read" }] } }] }],
      });

      const res = await postBueno(rutaNueva(), soloEstados);

      expect(res.status).toBe(200);
      expect(h.appDeLaRuta).toHaveBeenCalledTimes(1);
    });

    it("si la segunda lectura falla es un 500: Meta reintenta, porque no se sabe si había que guardar", async () => {
      h.appDeLaRuta.mockResolvedValueOnce(pedido).mockRejectedValueOnce(new Error("neon caído"));

      const res = await postBueno(rutaNueva(), mensajes());

      expect(res.status).toBe(500);
      expect(h.atenderLote).not.toHaveBeenCalled();
    });
  });

  it("acusado y descartado (el número no está conectado) no marca primer_mensaje_en: nadie atendió el mensaje", async () => {
    h.appDeLaRuta.mockResolvedValue(fila({ estado: "falta_pin", numeroEstado: "pedido" }));

    const res = await postBueno(rutaNueva(), mensajes());
    await vaciarAfter();

    expect(res.status).toBe(200);
    expect(h.atenderLote).not.toHaveBeenCalled();
    expect(h.primerMensaje).not.toHaveBeenCalled();
  });

  it("una WABA en falla sigue guardando: el cliente no pierde lo que le escriben", async () => {
    h.appDeLaRuta.mockResolvedValue(fila({ estado: "falla" }));

    await postBueno(rutaNueva(), mensajes());

    expect(h.atenderLote).toHaveBeenCalledTimes(1);
  });

  it("el primer mensaje propio marca primer_mensaje_en, después de contestar", async () => {
    await postBueno(rutaNueva(), mensajes());
    expect(h.primerMensaje).not.toHaveBeenCalled();

    await vaciarAfter();

    expect(h.primerMensaje).toHaveBeenCalledWith(TENANT);
  });

  it("si ya había entrado un mensaje no vuelve a marcar", async () => {
    h.appDeLaRuta.mockResolvedValue(fila({ primerMensaje: true }));

    await postBueno(rutaNueva(), mensajes());
    await vaciarAfter();

    expect(h.primerMensaje).not.toHaveBeenCalled();
  });

  it("si el lote falla (500) no se marca el primer mensaje y Meta recibe el 500", async () => {
    h.atenderLote.mockResolvedValue({ status: 500, cuerpo: { error: { code: "INTAKE_FAILED" } } });

    const res = await postBueno(rutaNueva(), mensajes());
    await vaciarAfter();

    expect(res.status).toBe(500);
    expect(h.primerMensaje).not.toHaveBeenCalled();
  });

  it("un fallo al marcar el primer mensaje se anota y no tira", async () => {
    h.primerMensaje.mockRejectedValue(new Error("neon caído"));

    await postBueno(rutaNueva(), mensajes());

    await expect(vaciarAfter()).resolves.toBeDefined();
    expect(h.error).toHaveBeenCalledWith(expect.any(Object), "whatsapp.webhook.app_primer_mensaje_fallo");
  });

  it("un pedido que sólo trae estados de entrega (sin mensajes) se acusa sin correr el agente", async () => {
    const soloEstados = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: WABA, changes: [{ field: "messages", value: { metadata: { phone_number_id: NUMERO }, statuses: [{ id: "wamid.9", status: "read" }] } }] }],
    });

    const res = await postBueno(rutaNueva(), soloEstados);

    expect(res.status).toBe(200);
    expect(h.primerMensaje).not.toHaveBeenCalled();
  });
});

// ── POST: avisos de la cuenta ────────────────────────────────────────────────

describe("POST: avisos de la cuenta", () => {
  it("encola los de la WABA de la fila con el contexto de la ruta y no los atiende antes de contestar", async () => {
    const res = await postBueno(rutaNueva(), cuenta());

    expect(res.status).toBe(200);
    expect(h.atenderEventos).not.toHaveBeenCalled();
    await vaciarAfter();

    expect(h.atenderEventos).toHaveBeenCalledTimes(1);
    const [eventos, contexto] = h.atenderEventos.mock.calls[0];
    expect(eventos).toEqual([expect.objectContaining({ campo: "account_update", wabaId: WABA, evento: "PARTNER_APP_UNINSTALLED" })]);
    expect(contexto).toMatchObject({ tenantId: TENANT, wabaId: WABA });
    expect(typeof contexto.revisar).toBe("function");
  });

  it("le pasa la hora del último cambio de la fila, leída de nuevo, para descartar el aviso que llega tarde", async () => {
    const ruta = rutaNueva();
    h.appDeLaRuta.mockResolvedValueOnce(fila({ actualizadoEn: 1_000 })).mockResolvedValueOnce(fila({ actualizadoEn: 2_000 }));

    await postBueno(ruta, cuenta());
    await vaciarAfter();

    expect(h.appDeLaRuta).toHaveBeenLastCalledWith(ruta, { fresca: true });
    expect(h.atenderEventos.mock.calls[0][1]).toMatchObject({ actualizadoEn: 2_000 });
  });

  it("si la lectura nueva falla, atiende igual con la hora del caché: un aviso no se pierde por eso", async () => {
    h.appDeLaRuta.mockResolvedValueOnce(fila({ actualizadoEn: 1_000 })).mockRejectedValueOnce(new Error("neon caído"));

    await postBueno(rutaNueva(), cuenta());
    await vaciarAfter();

    expect(h.atenderEventos).toHaveBeenCalledTimes(1);
    expect(h.atenderEventos.mock.calls[0][1]).toMatchObject({ actualizadoEn: 1_000 });
  });

  it("descarta los avisos de otra WABA: la ruta no es de ella", async () => {
    await postBueno(rutaNueva(), cuenta("999000111222"));
    await vaciarAfter();

    expect(h.atenderEventos).not.toHaveBeenCalled();
  });

  it("una fila sin WABA no atiende avisos de cuenta", async () => {
    h.appDeLaRuta.mockResolvedValue(fila({ wabaId: null }));

    await postBueno(rutaNueva(), cuenta());
    await vaciarAfter();

    expect(h.atenderEventos).not.toHaveBeenCalled();
  });

  it("pasa los avisos de nombre y de revisión con su decisión", async () => {
    await postBueno(rutaNueva(), cuenta(WABA, "phone_number_name_update", { decision: "APPROVED", phone_number_id: NUMERO }));
    await postBueno(rutaNueva(), cuenta(WABA, "account_review_update", { decision: "REJECTED" }));
    await vaciarAfter();

    const [nombre] = h.atenderEventos.mock.calls[0];
    expect(nombre[0]).toMatchObject({ campo: "phone_number_name_update", nombreEstado: "APPROVED", phoneNumberId: NUMERO });
    const [revision] = h.atenderEventos.mock.calls[1];
    expect(revision[0]).toMatchObject({ campo: "account_review_update", evento: "REJECTED", nombreEstado: null });
  });

  it("revisar pregunta a Graph con el token del cliente y su App Secret", async () => {
    await postBueno(rutaNueva(), cuenta());
    await vaciarAfter();
    const contexto = h.atenderEventos.mock.calls[0][1] as { revisar: () => Promise<unknown> };

    const r = await contexto.revisar();

    expect(h.credenciales).toHaveBeenCalledWith(TENANT);
    expect(h.revisarTokenDeApp).toHaveBeenCalledWith("test-client-system-token-key", { appId: APP_ID, secreto: SECRETO });
    expect(r).toEqual({ ok: false, motivo: "token_vencido" });
  });

  it("revisar sin credenciales abiertas no confirma nada", async () => {
    h.credenciales.mockResolvedValue(null);
    await postBueno(rutaNueva(), cuenta());
    await vaciarAfter();
    const contexto = h.atenderEventos.mock.calls[0][1] as { revisar: () => Promise<unknown> };

    expect(await contexto.revisar()).toEqual({ ok: false, motivo: "meta", codigo: null });
    expect(h.revisarTokenDeApp).not.toHaveBeenCalled();
  });

  it("un pedido con mensajes y avisos a la vez atiende las dos cosas", async () => {
    const mixto = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        ...JSON.parse(mensajes()).entry,
        ...JSON.parse(cuenta()).entry,
      ],
    });

    await postBueno(rutaNueva(), mixto);
    await vaciarAfter();

    expect(h.atenderLote).toHaveBeenCalledTimes(1);
    expect(h.atenderEventos).toHaveBeenCalledTimes(1);
  });

  it("los avisos se encolan aunque el número no esté conectado: la baja de la cuenta no espera al alta", async () => {
    h.appDeLaRuta.mockResolvedValue(fila({ numeroEstado: null, phoneNumberId: null }));

    await postBueno(rutaNueva(), cuenta());
    await vaciarAfter();

    expect(h.atenderEventos).toHaveBeenCalledTimes(1);
  });
});
