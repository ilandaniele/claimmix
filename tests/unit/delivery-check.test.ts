/**
 * El envío en sí, con los transportes reemplazados.
 *
 * En archivo aparte del de la ruta a propósito: allá `vi.mock` reemplaza
 * `probarEntrega` entera para poder mirar el borde HTTP, y ese mock alcanza a
 * todas las importaciones del archivo — incluso a las que vuelven a importar
 * el módulo después de `resetModules`. Con los dos juntos, estos tests pasaban
 * mirando el mock del otro.
 *
 * Lo que se prueba acá: que cada respuesta del proveedor se traduzca a lo que
 * el chequeo va a informar. Importa porque un chequeo que dice «funciona»
 * cuando no salió nada es peor que no tenerlo.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const TENANT = "tenant-uuid-001";
const CRED = { accessToken: "test-token", phoneNumberId: "123456", wabaId: "654321", autoalta: false, vencida: false };

/** El número del inquilino, sin tocar la base. */
const conNumero = (cred: typeof CRED | null) =>
  vi.doMock("@/server/whatsapp/numeros", () => ({ credencialesWhatsApp: vi.fn().mockResolvedValue(cred) }));

describe("probarEntrega", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("WhatsApp: si Meta lo acepta, informa que salió", async () => {
    const enviar = vi.fn().mockResolvedValue({ ok: true });
    conNumero(CRED);
    vi.doMock("@/server/whatsapp/cloud-api", () => ({ sendWhatsAppText: enviar }));

    const { probarEntrega } = await import("@/server/notify/delivery-check");
    expect(await probarEntrega("whatsapp", TENANT, "5491100000000")).toEqual({
      ok: true,
      detail: "Meta lo aceptó y lo puso en camino",
    });
    expect(enviar).toHaveBeenCalledWith("5491100000000", expect.any(String), CRED);
  });

  it("WhatsApp: sin número conectado NO salió, y no llama a Meta", async () => {
    const enviar = vi.fn();
    conNumero(null);
    vi.doMock("@/server/whatsapp/cloud-api", () => ({ sendWhatsAppText: enviar }));

    const { probarEntrega } = await import("@/server/notify/delivery-check");
    const res = await probarEntrega("whatsapp", TENANT, "5491100000000");
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/número/i);
    expect(enviar).not.toHaveBeenCalled();
  });

  it("WhatsApp: si Meta lo rechaza, informa que NO salió y con qué motivo", async () => {
    conNumero(CRED);
    vi.doMock("@/server/whatsapp/cloud-api", () => ({
      sendWhatsAppText: vi.fn().mockResolvedValue({ ok: false, error: "131030" }),
    }));

    const { probarEntrega } = await import("@/server/notify/delivery-check");
    expect(await probarEntrega("whatsapp", TENANT, "5491100000000")).toEqual({
      ok: false,
      detail: "131030",
    });
  });

  it("mail: sin casilla conectada no dice que funciona", async () => {
    vi.doMock("@/server/email/gmail/accounts", () => ({
      getGmailAccountForTenant: vi.fn().mockResolvedValue(null),
    }));

    const { probarEntrega } = await import("@/server/notify/delivery-check");
    const res = await probarEntrega("email", TENANT, "prueba@ejemplo.com");
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/casilla/i);
  });

  it("mail: con id del proveedor, salió; y dice desde dónde", async () => {
    vi.doMock("@/server/email/gmail/accounts", () => ({
      getGmailAccountForTenant: vi
        .fn()
        .mockResolvedValue({ email: "casilla@aseguradora.com", refreshToken: "tok" }),
    }));
    vi.doMock("@/server/email/gmail/gmail-sender", () => ({
      GmailSender: class {
        send = vi.fn().mockResolvedValue({ providerMessageId: "msg-1" });
      },
    }));

    const { probarEntrega } = await import("@/server/notify/delivery-check");
    expect(await probarEntrega("email", TENANT, "prueba@ejemplo.com")).toEqual({
      ok: true,
      detail: "enviado desde casilla@aseguradora.com",
    });
  });

  it("mail: sin id del proveedor NO salió, aunque no haya tirado error", async () => {
    // El caso que más importa: Gmail contesta 200 sin id. Tomar eso por bueno
    // sería el chequeo mintiendo sobre su propia cobertura.
    vi.doMock("@/server/email/gmail/accounts", () => ({
      getGmailAccountForTenant: vi
        .fn()
        .mockResolvedValue({ email: "casilla@aseguradora.com", refreshToken: "tok" }),
    }));
    vi.doMock("@/server/email/gmail/gmail-sender", () => ({
      GmailSender: class {
        send = vi.fn().mockResolvedValue({ errorCode: "GMAIL_SEND_FAILED" });
      },
    }));

    const { probarEntrega } = await import("@/server/notify/delivery-check");
    expect(await probarEntrega("email", TENANT, "prueba@ejemplo.com")).toEqual({
      ok: false,
      detail: "GMAIL_SEND_FAILED",
    });
  });
});
