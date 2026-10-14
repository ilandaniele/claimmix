/**
 * Unit tests for /api/webhooks/whatsapp — both auth paths.
 *
 * Path 1: Meta Cloud API (GET verification handshake + signed POST).
 * Path 2: normalized payload + Bearer secret (simulation / BSP adapters).
 *
 * The real cloud-api helpers run (signature math is part of what we're testing);
 * only the DB-backed intake, the agent and the two sweeps are mocked.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHmac } from "crypto";

const { afterCallbacks, mockAfter, mockCreateWhatsAppIntake, mockRunIntakeAgent, mockReap, mockRetomar, mockMarcarPendientes, mockResolverNumeros, mockAtender } = vi.hoisted(() => {
  const afterCallbacks: Array<() => unknown | Promise<unknown>> = [];
  return {
    afterCallbacks,
    mockAfter: vi.fn((cb: () => unknown | Promise<unknown>) => { afterCallbacks.push(cb); }),
    mockCreateWhatsAppIntake: vi.fn(),
    mockRunIntakeAgent: vi.fn(),
    mockReap: vi.fn(),
    mockRetomar: vi.fn(),
    mockMarcarPendientes: vi.fn(),
    mockResolverNumeros: vi.fn(),
    mockAtender: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: mockAfter };
});
vi.mock("@/server/agents/intake-agent", () => ({
  createWhatsAppIntake: mockCreateWhatsAppIntake,
  runIntakeAgent: mockRunIntakeAgent,
}));
vi.mock("@/server/intake/reap-stuck", () => ({ reapStuckProcessingCases: mockReap }));
vi.mock("@/server/intake/retomar-pendientes", () => ({
  retomarExtraccionesPendientes: mockRetomar,
  marcarPendientes: mockMarcarPendientes,
  MINIMO_PARA_RETOMAR_MS: 120_000,
}));

// El ruteo por número se prueba en tests/unit/whatsapp/numeros.test.ts y en
// webhook-ruteo.test.ts; acá sólo importa que cada mensaje llegue al inquilino que devuelve.
vi.mock("@/server/whatsapp/numeros", () => ({
  resolverNumeros: mockResolverNumeros,
  inquilinoDeLaPlataforma: () => process.env.WHATSAPP_TENANT_ID?.trim() || null,
}));

// Los avisos de la cuenta se prueban en tests/unit/alta/eventos-de-cuenta.test.ts;
// acá sólo importa que el camino firmado los encole y el del Bearer no.
vi.mock("@/server/alta/eventos-de-cuenta", () => ({ atenderEventosDeCuenta: mockAtender }));

import { GET, POST, maxDuration } from "@/app/api/webhooks/whatsapp/route";

const APP_SECRET = "test-app-secret";
const VERIFY_TOKEN = "verify-tok";
const TENANT = "10000000-0000-0000-0000-000000000001";
const NUMERO = "111111111111111";

beforeEach(() => {
  mockResolverNumeros.mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, TENANT])));
});

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");
}

function metaReq(rawBody: string, signature: string | null): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature) headers["x-hub-signature-256"] = signature;
  return new NextRequest("http://localhost/api/webhooks/whatsapp", { method: "POST", headers, body: rawBody });
}

const TEXT_PAYLOAD = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{ changes: [{ value: {
    metadata: { phone_number_id: NUMERO },
    contacts: [{ wa_id: "5492916426930", profile: { name: "Ilan" } }],
    messages: [{ from: "5492916426930", id: "wamid.1", type: "text", text: { body: "Tuve un choque" } }],
  } }] }],
});

describe("/api/webhooks/whatsapp", () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_VERIFY_TOKEN = VERIFY_TOKEN;
    process.env.WHATSAPP_TENANT_ID = TENANT;
    process.env.WHATSAPP_WEBHOOK_SECRET = "bearer-secret";
    mockCreateWhatsAppIntake.mockResolvedValue({
      caseId: "case-1",
      tenantId: TENANT,
      created: true,
      duplicado: false,
      excedente: false,
    });
    mockRunIntakeAgent.mockResolvedValue(undefined);
    mockReap.mockResolvedValue({ reaped: 0, caseIds: [] });
    mockRetomar.mockResolvedValue({ retomados: 0, caseIds: [] });
    mockMarcarPendientes.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // ── GET verification handshake ──────────────────────────────────────────────

  it("echoes hub.challenge when the verify token matches", () => {
    const req = new NextRequest(
      `http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=42`
    );
    const res = GET(req);
    expect(res.status).toBe(200);
  });

  it("rejects the handshake with a 403 on token mismatch", () => {
    const req = new NextRequest(
      "http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42"
    );
    expect(GET(req).status).toBe(403);
  });

  // ── Meta Cloud API POST ─────────────────────────────────────────────────────

  it("rejects an unsigned Cloud-API-shaped POST is treated as the bearer path (401 without bearer)", async () => {
    const res = await POST(metaReq(TEXT_PAYLOAD, null));
    expect(res.status).toBe(401); // no signature, no bearer
    expect(mockCreateWhatsAppIntake).not.toHaveBeenCalled();
  });

  it("rejects a POST with an invalid signature (401)", async () => {
    const res = await POST(metaReq(TEXT_PAYLOAD, "sha256=" + "0".repeat(64)));
    expect(res.status).toBe(401);
    expect(mockCreateWhatsAppIntake).not.toHaveBeenCalled();
  });

  it("ingests a validly-signed text message and schedules the agent", async () => {
    const res = await POST(metaReq(TEXT_PAYLOAD, sign(TEXT_PAYLOAD)));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, received: 1, case_ids: ["case-1"] });

    expect(mockCreateWhatsAppIntake).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, from: "5492916426930", providerMessageId: "wamid.1" })
    );
    // Agent runs only after the response is flushed.
    expect(mockRunIntakeAgent).not.toHaveBeenCalled();
    await afterCallbacks[0]();
    expect(mockRunIntakeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: "case-1", tenantId: TENANT, source: "whatsapp" })
    );
  });

  it("retoma con el reloj del pedido, no del after()", async () => {
    const T0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });

    mockCreateWhatsAppIntake.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 20_000);
      return { caseId: "case-1", tenantId: TENANT, created: true, duplicado: false };
    });
    mockRunIntakeAgent.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 100_000);
    });

    const res = await POST(metaReq(TEXT_PAYLOAD, sign(TEXT_PAYLOAD)));
    expect(res.status).toBe(200);
    await afterCallbacks[0]();

    expect(mockRetomar).toHaveBeenCalledWith({ tenantId: TENANT, limit: 2, hasta: T0 + maxDuration * 1000 });
    // El agente también: leer una carta no puede pasarse de lo que le queda a la invocación.
    expect(mockRunIntakeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: "case-1", hasta: T0 + maxDuration * 1000 })
    );
  });

  it("varios mensajes: un after(), agente por caso en serie, un barrido", async () => {
    const dosMensajes = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: NUMERO },
        contacts: [{ wa_id: "5492916426930", profile: { name: "Ilan" } }],
        messages: [
          { from: "5492916426930", id: "wamid.1", type: "text", text: { body: "Choqué" } },
          { from: "5491112345678", id: "wamid.2", type: "text", text: { body: "Choqué yo también" } },
        ],
      } }] }],
    });

    let llamada = 0;
    mockCreateWhatsAppIntake.mockImplementation(async () => {
      llamada++;
      return { caseId: `case-${llamada}`, tenantId: TENANT, created: true, duplicado: false };
    });

    const orden: string[] = [];
    mockRunIntakeAgent.mockImplementation(async ({ caseId }: { caseId: string }) => {
      orden.push(caseId);
    });
    mockMarcarPendientes.mockImplementation(async (ids: string[]) => {
      orden.push(`marca:${ids.join(",")}`);
    });

    const res = await POST(metaReq(dosMensajes, sign(dosMensajes)));
    expect(res.status).toBe(200);
    expect(afterCallbacks).toHaveLength(1);

    await afterCallbacks[0]();

    // El segundo queda marcado ANTES de correr el primero: si matan la
    // invocación a mitad del primero, el barrido igual lo encuentra.
    expect(orden).toEqual(["marca:case-2", "case-1", "case-2"]);
    expect(mockMarcarPendientes).toHaveBeenCalledWith(["case-2"], TENANT);
    expect(mockReap).toHaveBeenCalledTimes(1);
    expect(mockRetomar).toHaveBeenCalledTimes(1);
  });

  it("sin tiempo para el segundo, lo marca pendiente", async () => {
    const T0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });

    const dosMensajes = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: NUMERO },
        contacts: [{ wa_id: "5492916426930", profile: { name: "Ilan" } }],
        messages: [
          { from: "5492916426930", id: "wamid.1", type: "text", text: { body: "Choqué" } },
          { from: "5491112345678", id: "wamid.2", type: "text", text: { body: "Choqué yo también" } },
        ],
      } }] }],
    });

    let llamada = 0;
    mockCreateWhatsAppIntake.mockImplementation(async () => {
      llamada++;
      return { caseId: `case-${llamada}`, tenantId: TENANT, created: true, duplicado: false };
    });
    mockRunIntakeAgent.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 200_000); // sólo quedan 100 s, menos que MINIMO_PARA_RETOMAR_MS
    });

    const res = await POST(metaReq(dosMensajes, sign(dosMensajes)));
    expect(res.status).toBe(200);

    await afterCallbacks[0]();

    expect(mockRunIntakeAgent).toHaveBeenCalledTimes(1);
    expect(mockMarcarPendientes).toHaveBeenCalledWith(["case-2"], TENANT);
  });

  it("ACKs a validly-signed status event (no messages) without creating a case", async () => {
    const statusBody = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { statuses: [{ id: "wamid.x", status: "delivered" }] } }] }],
    });
    const res = await POST(metaReq(statusBody, sign(statusBody)));
    expect(res.status).toBe(200);
    expect(mockCreateWhatsAppIntake).not.toHaveBeenCalled();
  });

  // ── Tope por remitente (E12) ────────────────────────────────────────────────

  it("el que pasó el tope se guarda pero no corre el agente", async () => {
    mockCreateWhatsAppIntake.mockResolvedValue({
      caseId: "case-1",
      tenantId: TENANT,
      created: false,
      duplicado: false,
      excedente: true,
    });

    const res = await POST(metaReq(TEXT_PAYLOAD, sign(TEXT_PAYLOAD)));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, received: 1 });
    // `scheduleAgent([])` vuelve antes de programar el `after()`.
    expect(mockAfter).not.toHaveBeenCalled();
    expect(mockRunIntakeAgent).not.toHaveBeenCalled();
  });

  it("lote con dos remitentes: el excedente no corre, el otro sí", async () => {
    const dosMensajes = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: NUMERO },
        contacts: [{ wa_id: "5490000000021", profile: { name: "Ilan" } }],
        messages: [
          { from: "5490000000021", id: "wamid.1", type: "text", text: { body: "Choqué" } },
          { from: "5491112345678", id: "wamid.2", type: "text", text: { body: "Choqué yo también" } },
        ],
      } }] }],
    });

    let llamada = 0;
    mockCreateWhatsAppIntake.mockImplementation(async () => {
      llamada++;
      return {
        caseId: `case-${llamada}`,
        tenantId: TENANT,
        created: true,
        duplicado: false,
        excedente: llamada === 2,
      };
    });

    const res = await POST(metaReq(dosMensajes, sign(dosMensajes)));
    expect(res.status).toBe(200);

    await afterCallbacks[0]();

    expect(mockRunIntakeAgent).toHaveBeenCalledTimes(1);
    expect(mockRunIntakeAgent).toHaveBeenCalledWith(expect.objectContaining({ caseId: "case-1" }));
  });

  // ── Normalized + Bearer POST ────────────────────────────────────────────────

  it("accepts the normalized payload with a valid Bearer secret", async () => {
    const req = new NextRequest("http://localhost/api/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bearer-secret" },
      body: JSON.stringify({ from: "5492916426930", body: "Choque en la ruta 3" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(202);
    expect(mockCreateWhatsAppIntake).toHaveBeenCalledWith(
      expect.objectContaining({ from: "5492916426930", body: "Choque en la ruta 3" })
    );
  });

  it("la simulación no barre ni retoma", async () => {
    const req = new NextRequest("http://localhost/api/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bearer-secret" },
      body: JSON.stringify({ from: "5492916426930", body: "Ensayo" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(202);

    await afterCallbacks[0]();

    expect(mockReap).not.toHaveBeenCalled();
    expect(mockRetomar).not.toHaveBeenCalled();
  });

  it("bearer: el que pasó el tope no programa el agente", async () => {
    mockCreateWhatsAppIntake.mockResolvedValue({
      caseId: "case-1",
      tenantId: TENANT,
      created: false,
      duplicado: false,
      excedente: true,
    });
    const req = new NextRequest("http://localhost/api/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bearer-secret" },
      body: JSON.stringify({ from: "5490000000021", body: "Ensayo" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(202);
    expect(mockAfter).not.toHaveBeenCalled();
  });

  // ── El nombre de perfil ─────────────────────────────────────────────────────

  it("el nombre de perfil llega al intake en vez de morir acá", async () => {
    // `parseCloudApiMessages` ya lo leía —hay un test que lo prueba— y `ingest`
    // lo tiraba: el agente no sabía con quién hablaba y le pedía el nombre a
    // alguien que lo trae en el sobre.
    await POST(metaReq(TEXT_PAYLOAD, sign(TEXT_PAYLOAD)));

    expect(mockCreateWhatsAppIntake).toHaveBeenCalledWith(
      expect.objectContaining({ senderName: "Ilan" })
    );
  });

  it("y el payload normalizado también lo puede mandar", async () => {
    // Para que el adaptador BSP y el ensayo recorran el mismo camino.
    const req = new NextRequest("http://localhost/api/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bearer-secret" },
      body: JSON.stringify({ from: "5492916426930", body: "Choqué ayer", name: "Martín Sosa" }),
    });

    expect((await POST(req)).status).toBe(202);
    expect(mockCreateWhatsAppIntake).toHaveBeenCalledWith(
      expect.objectContaining({ senderName: "Martín Sosa" })
    );
  });
});

/**
 * Las dos mitades de lo mismo: qué hace el webhook cuando el mensaje no es
 * nuevo, y qué le contesta a Meta cuando no lo pudo guardar.
 *
 * Van juntas porque arreglar una sola empeora las cosas. Devolver 500 hace que
 * Meta reentregue el evento ENTERO, incluidos los mensajes que sí entraron; si
 * cada reentrega vuelve a correr el agente, cambiar un mensaje perdido por N
 * extracciones repetidas y N mensajes al asegurado no es un arreglo.
 */
describe("/api/webhooks/whatsapp — reentregas de Meta", () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_TENANT_ID = TENANT;
    process.env.WHATSAPP_WEBHOOK_SECRET = "bearer-secret";
    mockRunIntakeAgent.mockResolvedValue(undefined);
  });

  it("un mensaje nuevo corre el agente", async () => {
    mockCreateWhatsAppIntake.mockResolvedValue({
      caseId: "case-1",
      tenantId: TENANT,
      created: true,
      duplicado: false,
    });

    const res = await POST(metaReq(TEXT_PAYLOAD, sign(TEXT_PAYLOAD)));

    expect(res.status).toBe(200);
    expect(afterCallbacks).toHaveLength(1);
  });

  it("una reentrega del mismo mensaje no lo vuelve a correr", async () => {
    // La base ya lo frenaba —hay un índice único sobre el id del proveedor—
    // pero el aviso se perdía: `insertWhatsAppMessage` devolvía `null`, que es
    // lo mismo que devuelve cuando todo salió bien. Cada reintento de Meta era
    // otra extracción contra Vertex y otro mensaje al asegurado.
    mockCreateWhatsAppIntake.mockResolvedValue({
      caseId: "case-1",
      tenantId: TENANT,
      created: false,
      duplicado: true,
    });

    const res = await POST(metaReq(TEXT_PAYLOAD, sign(TEXT_PAYLOAD)));

    // Sigue siendo 200: el mensaje está guardado, no hay nada que reintentar.
    expect(res.status).toBe(200);
    expect(afterCallbacks).toHaveLength(0);
  });

  it("si el mensaje no se guardó, Meta se entera", async () => {
    // Antes: el try/catch estaba adentro del for, se tragaba el error, y la
    // ruta contestaba 200. Un hipo de Neon durante un pico y esa denuncia no
    // existía en ningún lado, marcada como entregada y sin reintento posible.
    mockCreateWhatsAppIntake.mockRejectedValue(
      new Error("whatsapp_claim_message_insert_failed:53300")
    );

    const res = await POST(metaReq(TEXT_PAYLOAD, sign(TEXT_PAYLOAD)));

    expect(res.status).toBe(500);
    expect(afterCallbacks).toHaveLength(0);
  });

  it("el teléfono de la persona no sale en el log del error", async () => {
    // El log imprimía `err.name` —siempre "Error"— junto al número de quien
    // escribió. Lo primero no dice nada y lo segundo es un dato de alguien.
    const errores: unknown[][] = [];
    const espia = vi.spyOn(console, "error").mockImplementation((...args) => {
      errores.push(args);
    });

    mockCreateWhatsAppIntake.mockRejectedValue(
      new Error("whatsapp_claim_message_insert_failed:53300")
    );
    await POST(metaReq(TEXT_PAYLOAD, sign(TEXT_PAYLOAD)));
    espia.mockRestore();

    const todo = errores.flat().map(String).join(" ");
    expect(todo).not.toContain("5492916426930");
    // Y el código de Postgres, que es lo único que sirve para diagnosticar.
    expect(todo).toContain("53300");
  });
});

describe("/api/webhooks/whatsapp — a qué número le hablaron", () => {
  function payload(phoneNumberId: string | null): string {
    return JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: {
        ...(phoneNumberId ? { metadata: { phone_number_id: phoneNumberId } } : {}),
        contacts: [{ wa_id: "5492916426930", profile: { name: "Ilan" } }],
        messages: [{ from: "5492916426930", id: "wamid.9", type: "text", text: { body: "Choqué" } }],
      } }] }],
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    afterCallbacks.length = 0;
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_TENANT_ID = TENANT;
    mockCreateWhatsAppIntake.mockResolvedValue({
      caseId: "case-1", tenantId: TENANT, created: true, duplicado: false,
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("el mensaje a un número con dueño entra a ese inquilino", async () => {
    const cuerpo = payload(NUMERO);
    const res = await POST(metaReq(cuerpo, sign(cuerpo)));

    expect(res.status).toBe(200);
    expect(mockResolverNumeros).toHaveBeenCalledWith([NUMERO], expect.any(Map));
    expect(mockCreateWhatsAppIntake).toHaveBeenCalledTimes(1);
    expect(mockCreateWhatsAppIntake).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }));
  });

  it("el de un número que nadie tiene no se guarda en la bandeja de nadie", async () => {
    // Firma válida, evento real, y aún así no es de ningún inquilino: una app de
    // Meta puede estar suscripta a varios números.
    mockResolverNumeros.mockResolvedValue(new Map());
    const espia = vi.spyOn(console, "error").mockImplementation(() => {});
    const cuerpo = payload("999999999999999");
    const res = await POST(metaReq(cuerpo, sign(cuerpo)));
    espia.mockRestore();

    expect(mockCreateWhatsAppIntake).not.toHaveBeenCalled();
    // 200: el evento está bien, el destinatario no es de nadie. Reintentarlo
    // no lo va a cambiar.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored_other_number: 1 });
  });

  it("le pasa al ruteo la WABA que trae el evento para cada número", async () => {
    const cuerpo = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "555000111222", changes: [{ value: {
        metadata: { phone_number_id: NUMERO },
        contacts: [{ wa_id: "5492916426930", profile: { name: "Ilan" } }],
        messages: [{ from: "5492916426930", id: "wamid.10", type: "text", text: { body: "Choqué" } }],
      } }] }],
    });
    const res = await POST(metaReq(cuerpo, sign(cuerpo)));

    expect(res.status).toBe(200);
    const [ids, wabaDe] = mockResolverNumeros.mock.calls[0] as [string[], Map<string, string>];
    expect(ids).toEqual([NUMERO]);
    expect(wabaDe.get(NUMERO)).toBe("555000111222");
  });

  it("sin id de WABA en el evento el mapa llega vacío y el ruteo sigue por el número", async () => {
    const cuerpo = payload(NUMERO);
    await POST(metaReq(cuerpo, sign(cuerpo)));

    const [, wabaDe] = mockResolverNumeros.mock.calls[0] as [string[], Map<string, string>];
    expect(wabaDe.size).toBe(0);
  });
});

describe("/api/webhooks/whatsapp — avisos de la cuenta", () => {
  const EVENTO = {
    object: "whatsapp_business_account",
    entry: [{
      id: "555000111222",
      time: 1_790_000_000,
      changes: [{
        field: "account_update",
        value: { event: "PARTNER_APP_UNINSTALLED", waba_info: { waba_id: "555000111222" } },
      }],
    }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    afterCallbacks.length = 0;
    process.env.WHATSAPP_APP_SECRET = APP_SECRET;
    process.env.WHATSAPP_TENANT_ID = TENANT;
    process.env.WHATSAPP_WEBHOOK_SECRET = "bearer-secret";
    mockAtender.mockResolvedValue(undefined);
    mockResolverNumeros.mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, TENANT])));
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("un aviso firmado se contesta 200 y se atiende después de contestar", async () => {
    const cuerpo = JSON.stringify(EVENTO);
    const res = await POST(metaReq(cuerpo, sign(cuerpo)));

    expect(res.status).toBe(200);
    expect(mockAtender).not.toHaveBeenCalled();

    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();

    expect(mockAtender).toHaveBeenCalledTimes(1);
    expect(mockAtender).toHaveBeenCalledWith([
      expect.objectContaining({
        campo: "account_update",
        wabaId: "555000111222",
        evento: "PARTNER_APP_UNINSTALLED",
        hora: 1_790_000_000,
      }),
    ]);
  });

  it("un aviso no pasa por el ruteo de mensajes ni crea casos", async () => {
    const cuerpo = JSON.stringify(EVENTO);
    await POST(metaReq(cuerpo, sign(cuerpo)));

    expect(mockResolverNumeros).toHaveBeenCalledWith([], expect.any(Map));
    expect(mockCreateWhatsAppIntake).not.toHaveBeenCalled();
  });

  it("el cambio de nombre del número también se atiende", async () => {
    const cuerpo = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        id: "555000111222",
        time: 1_790_000_000,
        changes: [{ field: "phone_number_name_update", value: { phone_number_id: NUMERO, decision: "APPROVED" } }],
      }],
    });
    await POST(metaReq(cuerpo, sign(cuerpo)));
    await afterCallbacks[0]();

    expect(mockAtender).toHaveBeenCalledWith([
      expect.objectContaining({ campo: "phone_number_name_update", phoneNumberId: NUMERO, nombreEstado: "APPROVED" }),
    ]);
  });

  it("un pedido de mensajes sin avisos no encola nada para la cuenta", async () => {
    const cuerpo = TEXT_PAYLOAD;
    await POST(metaReq(cuerpo, sign(cuerpo)));
    for (const cb of afterCallbacks) await cb();

    expect(mockAtender).not.toHaveBeenCalled();
  });

  it("un aviso con firma que no vale no se atiende", async () => {
    const cuerpo = JSON.stringify(EVENTO);
    const res = await POST(metaReq(cuerpo, "sha256=" + "0".repeat(64)));

    expect(res.status).toBe(401);
    expect(afterCallbacks).toHaveLength(0);
    expect(mockAtender).not.toHaveBeenCalled();
  });

  it("el camino del Bearer no atiende avisos de la cuenta", async () => {
    const req = new NextRequest("http://localhost/api/webhooks/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bearer-secret" },
      body: JSON.stringify(EVENTO),
    });
    await POST(req);
    for (const cb of afterCallbacks) await cb();

    expect(mockAtender).not.toHaveBeenCalled();
  });
});
