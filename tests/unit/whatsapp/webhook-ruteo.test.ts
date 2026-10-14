/**
 * A qué inquilino va cada mensaje de /api/webhooks/whatsapp.
 *
 * Corre el `resolverNumeros` de verdad contra una base simulada, para probar la
 * ruta y la tabla de decisión juntas: lo que Meta firma trae el
 * `phone_number_id` al que le escribieron, y de ahí sale el inquilino. Nunca de
 * una constante del deploy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "crypto";
import { capturarLogs, type LogsCapturados } from "../../mocks/capturar-logs";

const { afterCallbacks, mockCreateWhatsAppIntake, mockRunIntakeAgent, mockSelectDb } = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => unknown | Promise<unknown>>,
  mockCreateWhatsAppIntake: vi.fn(),
  mockRunIntakeAgent: vi.fn(),
  mockSelectDb: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: (cb: () => unknown | Promise<unknown>) => afterCallbacks.push(cb) };
});
vi.mock("@/lib/db", () => ({ db: { select: (...args: unknown[]) => mockSelectDb(...args) } }));
vi.mock("@/data/scope", () => ({ enTenant: vi.fn() }));
vi.mock("@/lib/security/cifrado", () => ({ descifrar: (s: string) => s }));
vi.mock("@/server/agents/intake-agent", () => ({
  createWhatsAppIntake: mockCreateWhatsAppIntake,
  runIntakeAgent: mockRunIntakeAgent,
}));
vi.mock("@/server/intake/reap-stuck", () => ({
  reapStuckProcessingCases: vi.fn().mockResolvedValue({ reaped: 0, caseIds: [] }),
}));
vi.mock("@/server/intake/retomar-pendientes", () => ({
  retomarExtraccionesPendientes: vi.fn().mockResolvedValue({ retomados: 0, caseIds: [] }),
  marcarPendientes: vi.fn().mockResolvedValue(undefined),
  MINIMO_PARA_RETOMAR_MS: 120_000,
}));

import { POST } from "@/app/api/webhooks/whatsapp/route";

const APP_SECRET = "test-app-secret";
const PLATAFORMA = "10000000-0000-0000-0000-000000000001";
const OTRO = "20000000-0000-0000-0000-000000000002";
const NUMERO_PLATAFORMA = "111111111111111";
const NUMERO_OTRO = "222222222222222";

function firmado(cuerpo: string): NextRequest {
  const firma = "sha256=" + createHmac("sha256", APP_SECRET).update(cuerpo).digest("hex");
  return new NextRequest("http://localhost/api/webhooks/whatsapp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": firma },
    body: cuerpo,
  });
}

/** Un `value` del webhook de Meta: un mensaje de texto al número `numero` (o sin metadata). */
function valor(numero: string | null, id: string, from = "5491100000000") {
  return {
    ...(numero ? { metadata: { phone_number_id: numero, display_phone_number: "5491100000000" } } : {}),
    contacts: [{ wa_id: from, profile: { name: "Ilan" } }],
    messages: [{ from, id, type: "text", text: { body: "Choqué" } }],
  };
}

function evento(...valores: Array<ReturnType<typeof valor>>): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: valores.map((value) => ({ value })) }],
  });
}

/** Lo que devuelve la consulta de `resolverNumeros`: encadenable y se espera. */
function filas(resultado: unknown[] | Error) {
  const promesa = () => (resultado instanceof Error ? Promise.reject(resultado) : Promise.resolve(resultado));
  const cadena = {
    from: () => cadena,
    innerJoin: () => cadena,
    leftJoin: () => cadena,
    where: () => cadena,
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => promesa().then(ok, ko),
  };
  return cadena;
}

const conectado = (numero: string, tenantId: string) => ({
  phone_number_id: numero,
  tenant_id: tenantId,
  estado: "conectado",
  billing_status: "active",
});

describe("/api/webhooks/whatsapp — ruteo por número", () => {
  let logs: LogsCapturados;

  beforeEach(() => {
    vi.clearAllMocks();
    afterCallbacks.length = 0;
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_TENANT_ID = PLATAFORMA;
    process.env.WHATSAPP_PHONE_NUMBER_ID = NUMERO_PLATAFORMA;
    let n = 0;
    mockCreateWhatsAppIntake.mockImplementation(async ({ tenantId }: { tenantId: string }) => ({
      caseId: `case-${++n}`,
      tenantId,
      created: true,
      duplicado: false,
      excedente: false,
    }));
    mockRunIntakeAgent.mockResolvedValue(undefined);
    mockSelectDb.mockReturnValue(filas([]));
    logs = capturarLogs();
  });

  afterEach(() => {
    logs.restaurar();
    delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  });

  it("un número que nadie tiene: 200, ningún caso y ningún agente", async () => {
    const res = await POST(firmado(evento(valor("999999999999999", "wamid.1"))));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: 0, ignored_other_number: 1 });
    expect(mockCreateWhatsAppIntake).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(0);
    expect(logs.texto()).toContain("whatsapp.webhook.numero_desconocido");
  });

  it("sin metadata no hay a quién entregárselo: se descarta, no cae en la plataforma", async () => {
    const res = await POST(firmado(evento(valor(null, "wamid.1"))));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: 0, ignored_other_number: 1 });
    expect(mockCreateWhatsAppIntake).not.toHaveBeenCalled();
    expect(mockSelectDb).not.toHaveBeenCalled();
  });

  it("el número de la plataforma, sin fila, entra al inquilino de la plataforma", async () => {
    const res = await POST(firmado(evento(valor(NUMERO_PLATAFORMA, "wamid.1"))));

    expect(res.status).toBe(200);
    expect(mockCreateWhatsAppIntake).toHaveBeenCalledWith(expect.objectContaining({ tenantId: PLATAFORMA }));
  });

  it("el número de un inquilino con fila conectada entra a ese inquilino", async () => {
    mockSelectDb.mockReturnValue(filas([conectado(NUMERO_OTRO, OTRO)]));

    const res = await POST(firmado(evento(valor(NUMERO_OTRO, "wamid.1"))));

    expect(res.status).toBe(200);
    expect(mockCreateWhatsAppIntake).toHaveBeenCalledTimes(1);
    expect(mockCreateWhatsAppIntake).toHaveBeenCalledWith(expect.objectContaining({ tenantId: OTRO }));
    await afterCallbacks[0]();
    expect(mockRunIntakeAgent).toHaveBeenCalledWith(expect.objectContaining({ tenantId: OTRO, source: "whatsapp" }));
  });

  it("un número suspendido se descarta aunque sea el de la plataforma", async () => {
    mockSelectDb.mockReturnValue(
      filas([{ ...conectado(NUMERO_PLATAFORMA, PLATAFORMA), estado: "suspendido" }])
    );

    const res = await POST(firmado(evento(valor(NUMERO_PLATAFORMA, "wamid.1"))));

    expect(res.status).toBe(200);
    expect(mockCreateWhatsAppIntake).not.toHaveBeenCalled();
  });

  it("el número de una app propia no entra por acá: firma con otro secreto y su webhook es otro", async () => {
    mockSelectDb.mockReturnValue(filas([{ ...conectado(NUMERO_OTRO, OTRO), origen: "app_propia" }]));

    const res = await POST(firmado(evento(valor(NUMERO_OTRO, "wamid.1"))));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: 0, ignored_other_number: 1 });
    expect(mockCreateWhatsAppIntake).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(0);
    expect(logs.lineas().find((l) => l.msg === "whatsapp.webhook.app_por_plataforma")).toMatchObject({ tenantId: OTRO });
  });

  it("un número de Embedded Signup sigue entrando aunque haya una app propia en el mismo pedido", async () => {
    const PROPIO = "30000000-0000-0000-0000-000000000003";
    mockSelectDb.mockReturnValue(
      filas([
        { ...conectado(NUMERO_OTRO, OTRO), origen: "embedded_signup" },
        { ...conectado("333333333333333", PROPIO), origen: "app_propia" },
      ])
    );

    const res = await POST(
      firmado(evento(valor(NUMERO_OTRO, "wamid.1"), valor("333333333333333", "wamid.2", "5491100000001")))
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: 1, ignored_other_number: 1 });
    expect(mockCreateWhatsAppIntake).toHaveBeenCalledTimes(1);
    expect(mockCreateWhatsAppIntake).toHaveBeenCalledWith(expect.objectContaining({ tenantId: OTRO }));
  });

  it("un pedido con dos inquilinos: una consulta, cada mensaje al suyo y un agente por inquilino", async () => {
    mockSelectDb.mockReturnValue(filas([conectado(NUMERO_OTRO, OTRO)]));

    const res = await POST(
      firmado(
        evento(
          valor(NUMERO_PLATAFORMA, "wamid.1", "5491100000000"),
          valor(NUMERO_OTRO, "wamid.2", "5491100000001"),
          valor("999999999999999", "wamid.3", "5491100000002")
        )
      )
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: 2, ignored_other_number: 1 });
    expect(mockSelectDb).toHaveBeenCalledTimes(1);

    const llamadas = mockCreateWhatsAppIntake.mock.calls as Array<[{ tenantId: string; providerMessageId: string }]>;
    const porMensaje = llamadas.map(([a]) => [a.providerMessageId, a.tenantId]);
    expect(porMensaje).toEqual([
      ["wamid.1", PLATAFORMA],
      ["wamid.2", OTRO],
    ]);

    expect(afterCallbacks).toHaveLength(2);
    for (const cb of afterCallbacks) await cb();
    const corridas = mockRunIntakeAgent.mock.calls as Array<[{ caseId: string; tenantId: string }]>;
    const agentes = corridas.map(([a]) => [a.caseId, a.tenantId]);
    expect(agentes).toEqual([
      ["case-1", PLATAFORMA],
      ["case-2", OTRO],
    ]);
  });

  it("si no se puede resolver el número: 500 para que Meta reintente, y nada se guarda", async () => {
    mockSelectDb.mockReturnValue(filas(new Error("fetch failed")));

    const res = await POST(firmado(evento(valor(NUMERO_PLATAFORMA, "wamid.1"))));

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "ROUTING_FAILED" } });
    expect(mockCreateWhatsAppIntake).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(0);
    expect(logs.texto()).toContain("whatsapp.webhook.ruteo_failed");
  });

  it("sin la 0048 sigue andando el número de la plataforma, y sólo ése", async () => {
    mockSelectDb.mockReturnValue(filas(Object.assign(new Error("relation does not exist"), { code: "42P01" })));

    const res = await POST(
      firmado(evento(valor(NUMERO_PLATAFORMA, "wamid.1"), valor(NUMERO_OTRO, "wamid.2", "5491100000001")))
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: 1, ignored_other_number: 1 });
    expect(mockCreateWhatsAppIntake).toHaveBeenCalledTimes(1);
    expect(mockCreateWhatsAppIntake).toHaveBeenCalledWith(expect.objectContaining({ tenantId: PLATAFORMA }));
  });
});
