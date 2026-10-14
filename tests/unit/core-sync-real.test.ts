/**
 * El webhook real al Core. `node:https` se reemplaza por el mismo pedido en
 * claro a un servidor local: lo que se prueba es qué arma el cliente (a qué IP
 * conecta, con qué nombre, qué firma) y cómo lee la respuesta, sin certificados
 * de prueba en el repo.
 */

import { createServer, type IncomingMessage, type RequestOptions, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  puerto: 0,
  opciones: [] as RequestOptions[],
  validarDestino: vi.fn(),
}));

vi.mock("node:https", async () => {
  const http = await import("node:http");
  const request = (opciones: RequestOptions, alResponder: (r: IncomingMessage) => void) => {
    h.opciones.push(opciones);
    return http.request({ ...opciones, host: "127.0.0.1", family: 4, port: h.puerto }, alResponder);
  };
  return { request, default: { request } };
});

vi.mock("@/server/core-sync/destino", async (original) => ({
  ...(await original<typeof import("@/server/core-sync/destino")>()),
  validarDestino: h.validarDestino,
}));

import type { CoreSyncPayload } from "@/server/core-sync/client";
import { DestinoRechazado } from "@/server/core-sync/destino";
import { RealCoreSyncClient } from "@/server/core-sync/real";
import { verificarFirma } from "../../docs/entrega-al-core/verificar-firma.mjs";

const SECRETO = "test-core-webhook-secret";
const URL_CORE = "https://core.example.com/claimmix/webhook?cuenta=7";

const PAYLOAD: CoreSyncPayload = {
  caseId: "11111111-2222-4333-8444-555555555555",
  tenantId: "00000000-0000-4000-8000-000000000001",
  claimType: "choque",
  severity: "medium",
  customerName: "Persona de Prueba",
  policyNumber: "POL-1",
  accidentDate: "2026-09-01",
  accidentDescription: "roce en estacionamiento",
  extractedFields: { patente: "AA000AA" },
  updatedAt: "2026-09-28T12:00:00.000Z",
};

type Recibido = { headers: IncomingMessage["headers"]; body: string };
let responder: (req: IncomingMessage, res: ServerResponse) => void;
let recibido: Recibido | null;
let servidor: Server;

function contesta(estado: number, cuerpo = "", headers: Record<string, string> = {}) {
  responder = (_, res) => {
    res.writeHead(estado, headers);
    res.end(cuerpo);
  };
}

function cliente(plazoMs?: number) {
  return new RealCoreSyncClient({ url: URL_CORE, secreto: SECRETO, plazoMs });
}

beforeAll(async () => {
  servidor = createServer((req, res) => {
    const trozos: Buffer[] = [];
    req.on("data", (t: Buffer) => trozos.push(t));
    req.on("end", () => {
      recibido = { headers: req.headers, body: Buffer.concat(trozos).toString("utf8") };
      responder(req, res);
    });
  });
  await new Promise<void>((listo) => servidor.listen(0, "127.0.0.1", listo));
  h.puerto = (servidor.address() as AddressInfo).port;
});

afterAll(async () => {
  servidor.closeAllConnections();
  await new Promise((listo) => servidor.close(listo));
});

beforeEach(() => {
  h.opciones.length = 0;
  h.validarDestino.mockReset();
  h.validarDestino.mockResolvedValue({ host: "core.example.com", ip: "93.184.216.34", familia: 4 });
  recibido = null;
  contesta(200, JSON.stringify({ id: "CORE-77" }));
});

describe("RealCoreSyncClient", () => {
  it("conecta a la IP validada, con el nombre sólo para el certificado y el Host", async () => {
    await cliente().syncCase(PAYLOAD);
    expect(h.validarDestino).toHaveBeenCalledWith(URL_CORE);
    expect(h.opciones).toHaveLength(1);
    expect(h.opciones[0]).toMatchObject({
      host: "93.184.216.34",
      family: 4,
      port: 443,
      servername: "core.example.com",
      path: "/claimmix/webhook?cuenta=7",
      method: "POST",
      agent: false,
    });
    expect(recibido?.headers.host).toBe("core.example.com");
  });

  it("firma el cuerpo exacto y manda los encabezados de la documentación", async () => {
    await cliente().syncCase(PAYLOAD);
    const { headers, body } = recibido!;
    expect(JSON.parse(body)).toEqual(PAYLOAD);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["user-agent"]).toBe("ClaimMix-Core-Sync/1");
    expect(headers["idempotency-key"]).toBe(PAYLOAD.caseId);
    expect(headers["x-claimmix-event-id"]).toBe(`${PAYLOAD.caseId}:${PAYLOAD.updatedAt}`);
    const firma = String(headers["x-claimmix-signature"]);
    expect(firma).toMatch(new RegExp(`^t=${headers["x-claimmix-timestamp"]},v1=[0-9a-f]{64}$`));
    expect(verificarFirma({ secreto: SECRETO, encabezado: firma, body })).toBe(true);
    expect(verificarFirma({ secreto: "test-other-webhook-secret", encabezado: firma, body })).toBe(false);
  });

  it("un 2xx con id devuelve ese id", async () => {
    await expect(cliente().syncCase(PAYLOAD)).resolves.toEqual({ ok: true, externalId: "CORE-77" });
  });

  it("toma external_id si no hay id", async () => {
    contesta(201, JSON.stringify({ external_id: "EXT-9" }));
    await expect(cliente().syncCase(PAYLOAD)).resolves.toEqual({ ok: true, externalId: "EXT-9" });
  });

  it.each([
    ["sin cuerpo", ""],
    ["texto", "recibido"],
    ["id que no es string", JSON.stringify({ id: 42 })],
    ["id demasiado largo", JSON.stringify({ id: "x".repeat(201) })],
  ])("un 2xx %s es entrega sin id", async (_, cuerpo) => {
    contesta(200, cuerpo);
    await expect(cliente().syncCase(PAYLOAD)).resolves.toEqual({ ok: true, externalId: null });
  });

  it("un 2xx más grande que el tope es entrega sin id", async () => {
    contesta(200, JSON.stringify({ id: "CORE-77", relleno: "a".repeat(70 * 1024) }));
    await expect(cliente().syncCase(PAYLOAD)).resolves.toEqual({ ok: true, externalId: null });
  });

  it("un 3xx no se sigue", async () => {
    contesta(302, "", { Location: "http://169.254.169.254/latest/meta-data/" });
    await expect(cliente().syncCase(PAYLOAD)).resolves.toEqual({ ok: false, motivo: "redireccion" });
    expect(h.opciones).toHaveLength(1);
  });

  it("un 500 es http_500, sin el cuerpo ni el secreto", async () => {
    contesta(500, `stack trace ${SECRETO}`);
    const r = await cliente().syncCase(PAYLOAD);
    expect(r).toEqual({ ok: false, motivo: "http_500" });
    expect(JSON.stringify(r)).not.toContain(SECRETO);
    expect(JSON.stringify(r)).not.toContain("stack");
  });

  it("vence el plazo si el Core no contesta", async () => {
    responder = () => {};
    await expect(cliente(150).syncCase(PAYLOAD)).resolves.toEqual({ ok: false, motivo: "timeout" });
  });

  it("vence el plazo también si la resolución DNS se cuelga", async () => {
    h.validarDestino.mockReturnValue(new Promise(() => {}));
    await expect(cliente(100).syncCase(PAYLOAD)).resolves.toEqual({ ok: false, motivo: "timeout" });
    expect(h.opciones).toHaveLength(0);
  });

  it("un destino rechazado no conecta", async () => {
    h.validarDestino.mockRejectedValue(new DestinoRechazado("direccion_interna"));
    await expect(cliente().syncCase(PAYLOAD)).resolves.toEqual({ ok: false, motivo: "destino_rechazado" });
    expect(h.opciones).toHaveLength(0);
  });

  it("una falla de DNS es red", async () => {
    h.validarDestino.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    await expect(cliente().syncCase(PAYLOAD)).resolves.toEqual({ ok: false, motivo: "red" });
  });

  it("una conexión cortada es red", async () => {
    responder = (req) => req.socket.destroy();
    await expect(cliente().syncCase(PAYLOAD)).resolves.toEqual({ ok: false, motivo: "red" });
  });
});
