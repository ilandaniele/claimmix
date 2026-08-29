/**
 * `POST /api/health/delivery` — el endpoint que manda mensajes de verdad.
 *
 * No tenía ni un test. Y es el único de todo el producto que, con la llave
 * interna, hace que la casilla de la aseguradora le escriba a una dirección que
 * viene en el cuerpo de la petición. Que eso estuviera sin cubrir es peor que
 * que estuviera mal.
 *
 * Ojo con cómo se prueba: `isInternalRequest` falla cerrado cuando no hay
 * `CRON_SECRET`, así que un test que se olvide de configurarlo recibe 401 y
 * pasa sin haber ejercido ninguna guarda. Por eso el secreto se pone en
 * `beforeEach` y hay un test que comprueba que la petición autorizada SÍ llega
 * a mandar: si no, todos los «no mandó nada» de acá abajo serían tautologías.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockEnTenant, mockWriteAuditLog, mockProbarEntrega } = vi.hoisted(() => ({
  mockEnTenant: vi.fn(),
  mockWriteAuditLog: vi.fn(),
  mockProbarEntrega: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/data/scope", () => ({ enTenant: mockEnTenant }));

vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: mockWriteAuditLog,
  AuditEvent: { DELIVERY_TEST: "delivery.test" },
}));

// Parcial: `enmascararDestinatario` se prueba de verdad, sólo se reemplaza el
// envío. Si se mockeara entero, el test del enmascarado no probaría nada.
vi.mock("@/server/notify/delivery-check", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/notify/delivery-check")>()),
  probarEntrega: mockProbarEntrega,
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/health/delivery/route";
import { enmascararDestinatario, cuerpoDePrueba } from "@/server/notify/delivery-check";

const SECRETO = "secreto-de-prueba";
const TENANT = "tenant-uuid-001";

function pedir(body: unknown, opciones: { autorizado?: boolean } = {}) {
  const { autorizado = true } = opciones;
  return new NextRequest("http://localhost/api/health/delivery", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(autorizado ? { Authorization: `Bearer ${SECRETO}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", SECRETO);
  vi.stubEnv("GMAIL_TENANT_ID", TENANT);
  // Sin pruebas recientes: el limitador no se mete.
  mockEnTenant.mockResolvedValue([]);
  mockWriteAuditLog.mockResolvedValue(undefined);
  mockProbarEntrega.mockResolvedValue({ ok: true, detail: "enviado desde casilla@x.com" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/health/delivery", () => {
  it("una petición válida SÍ manda, que es lo que hace verdaderos a los demás tests", async () => {
    const res = await POST(pedir({ channel: "email", to: "prueba@ejemplo.com" }));

    expect(res.status).toBe(200);
    expect(mockProbarEntrega).toHaveBeenCalledWith("email", TENANT, "prueba@ejemplo.com");
  });

  it("sin el secreto es 401 y no manda nada", async () => {
    const res = await POST(pedir({ channel: "email", to: "prueba@ejemplo.com" }, { autorizado: false }));

    expect(res.status).toBe(401);
    expect(mockProbarEntrega).not.toHaveBeenCalled();
  });

  /*
   * Acá estaba el bug.
   *
   * El canal se resolvía con `body.channel === "whatsapp" ? "whatsapp" :
   * "email"`, así que cualquier cosa que no fuera exactamente «whatsapp» —un
   * typo, una mayúscula, un campo faltante— mandaba un MAIL. Quien quería
   * probar WhatsApp escribiendo «whatsap» le mandaba un correo a lo que en
   * realidad era un número de teléfono; y con la dirección de una persona en
   * `to`, le mandaba un mail a alguien a quien quería escribirle por otro lado.
   */
  it.each(["whatsap", "WhatsApp", "wa", "", null, undefined])(
    "un canal que no es exactamente email ni whatsapp (%s) es 400 y no manda",
    async (channel) => {
      const res = await POST(pedir({ channel, to: "persona@ejemplo.com" }));

      expect(res.status).toBe(400);
      expect(mockProbarEntrega).not.toHaveBeenCalled();
    }
  );

  it("«whatsapp» exacto sí manda por WhatsApp", async () => {
    // La otra mitad: una validación que rechaza todo también pasaría lo de arriba.
    const res = await POST(pedir({ channel: "whatsapp", to: "5491100000000" }));

    expect(res.status).toBe(200);
    expect(mockProbarEntrega).toHaveBeenCalledWith("whatsapp", TENANT, "5491100000000");
  });

  it.each([
    ["un mail por WhatsApp", "whatsapp", "persona@ejemplo.com"],
    ["un teléfono por mail", "email", "5491100000000"],
    ["algo que no es ninguna de las dos", "email", "quién sabe"],
  ])("%s es 400 y no manda", async (_c, channel, to) => {
    const res = await POST(pedir({ channel, to }));

    expect(res.status).toBe(400);
    expect(mockProbarEntrega).not.toHaveBeenCalled();
  });

  it("sin 'to' es 400", async () => {
    const res = await POST(pedir({ channel: "email" }));

    expect(res.status).toBe(400);
    expect(mockProbarEntrega).not.toHaveBeenCalled();
  });

  it("sin GMAIL_TENANT_ID no manda: no sabría desde qué casilla", async () => {
    vi.stubEnv("GMAIL_TENANT_ID", "");

    const res = await POST(pedir({ channel: "email", to: "prueba@ejemplo.com" }));

    expect(res.status).toBe(500);
    expect(mockProbarEntrega).not.toHaveBeenCalled();
  });

  it("si hubo una prueba en el último minuto, 429 y no manda", async () => {
    mockEnTenant.mockResolvedValue([{ id: "audit-1" }]);

    const res = await POST(pedir({ channel: "email", to: "prueba@ejemplo.com" }));

    expect(res.status).toBe(429);
    expect(mockProbarEntrega).not.toHaveBeenCalled();
  });

  it("si el proveedor falla es 502, y queda asentado igual", async () => {
    mockProbarEntrega.mockResolvedValue({ ok: false, detail: "token revocado" });

    const res = await POST(pedir({ channel: "email", to: "prueba@ejemplo.com" }));

    expect(res.status).toBe(502);
    // Se intentó mandar un mensaje real: eso va al registro pase lo que pase.
    expect(mockWriteAuditLog).toHaveBeenCalled();
  });

  /*
   * El registro no guardaba a quién.
   *
   * Quedaba asentado que hubo una prueba, con el canal y el resultado, pero no
   * el destinatario. Ante «me llegó un mail de ustedes y no sé por qué» el
   * registro no servía para nada.
   */
  it("asienta el destinatario enmascarado, ni entero ni ausente", async () => {
    await POST(pedir({ channel: "email", to: "marina.gutierrez@ejemplo.com" }));

    const payload = mockWriteAuditLog.mock.calls[0][0].payload;
    expect(payload.to).toBe("m***************@ejemplo.com");
    expect(payload.to).not.toContain("marina.gutierrez");
    expect(payload.channel).toBe("email");
  });
});

describe("enmascararDestinatario", () => {
  it("de un correo deja la inicial y el dominio", () => {
    // Alcanza para decir «sí, fuiste vos» sin guardar la dirección.
    expect(enmascararDestinatario("email", "marina.gutierrez@ejemplo.com")).toBe(
      "m***************@ejemplo.com"
    );
  });

  it("de un teléfono deja los últimos cuatro", () => {
    expect(enmascararDestinatario("whatsapp", "+54 9 11 5555-4321")).toBe("…4321");
  });

  it("con algo que no tiene forma de destinatario no inventa nada", () => {
    expect(enmascararDestinatario("email", "sin-arroba")).toBe("…");
    expect(enmascararDestinatario("whatsapp", "12")).toBe("…");
  });
});

describe("cuerpoDePrueba", () => {
  it("se anuncia como prueba y no pide respuesta", () => {
    // El texto es fijo del lado del servidor: quien llama elige a quién, nunca
    // qué. Es lo que impide que el endpoint sirva para algo si alguien se hace
    // del secreto.
    const cuerpo = cuerpoDePrueba(new Date("2026-08-29T12:34:56Z"));

    expect(cuerpo).toContain("2026-08-29 12:34");
    expect(cuerpo).toMatch(/prueba/i);
    expect(cuerpo).toMatch(/no hace falta que contestes/i);
  });
});
