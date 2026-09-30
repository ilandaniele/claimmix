// @vitest-environment node
/**
 * El pedido HTTPS que comparten el webhook al Core y el SSO. `node:https` se
 * reemplaza por el mismo pedido en claro a un servidor local y el DNS por una
 * tabla: lo que se prueba es la guarda (a qué IP conecta, qué rechaza, qué no
 * sigue) con la `validarDestino` de verdad.
 */

import { createServer, type IncomingMessage, type RequestOptions, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  puerto: 0,
  opciones: [] as RequestOptions[],
  lookup: vi.fn(),
}));

vi.mock("node:https", async () => {
  const http = await import("node:http");
  const request = (opciones: RequestOptions, alResponder: (r: IncomingMessage) => void) => {
    h.opciones.push(opciones);
    return http.request({ ...opciones, host: "127.0.0.1", family: 4, port: h.puerto }, alResponder);
  };
  return { request, default: { request } };
});

vi.mock("node:dns/promises", () => ({ lookup: h.lookup, default: { lookup: h.lookup } }));

import { pedirFijado } from "@/server/red/https-fijado";

const PUBLICA = [{ address: "93.184.216.34", family: 4 }];
const URL_IDP = "https://idp.example.com/.well-known/openid-configuration?x=1";

let responder: (req: IncomingMessage, res: ServerResponse) => void;
let recibido: { metodo?: string; headers: IncomingMessage["headers"]; body: string } | null;
let servidor: Server;

function contesta(estado: number, cuerpo = "", headers: Record<string, string> = {}) {
  responder = (_, res) => {
    res.writeHead(estado, headers);
    res.end(cuerpo);
  };
}

const pedir = (extra: Partial<Parameters<typeof pedirFijado>[0]> = {}) =>
  pedirFijado({ url: URL_IDP, plazoMs: 2_000, topeBytes: 1024, ...extra });

beforeAll(async () => {
  servidor = createServer((req, res) => {
    const trozos: Buffer[] = [];
    req.on("data", (t: Buffer) => trozos.push(t));
    req.on("end", () => {
      recibido = { metodo: req.method, headers: req.headers, body: Buffer.concat(trozos).toString("utf8") };
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
  h.lookup.mockReset();
  h.lookup.mockResolvedValue(PUBLICA);
  recibido = null;
  contesta(200, "hola");
});

describe("pedirFijado: a dónde conecta", () => {
  it("a la IP resuelta, con el nombre sólo para el certificado y el Host", async () => {
    await pedir();
    expect(h.lookup).toHaveBeenCalledTimes(1);
    expect(h.opciones[0]).toMatchObject({
      host: "93.184.216.34",
      family: 4,
      port: 443,
      servername: "idp.example.com",
      path: "/.well-known/openid-configuration?x=1",
      method: "GET",
      agent: false,
    });
    expect(recibido?.headers.host).toBe("idp.example.com");
  });

  it("un Host que mande el llamador no pisa el de la URL", async () => {
    await pedir({ encabezados: { Host: "interno.local", Accept: "application/json" } });
    expect(recibido?.headers.host).toBe("idp.example.com");
    expect(recibido?.headers.accept).toBe("application/json");
  });

  it("un POST lleva el cuerpo y su largo en bytes", async () => {
    const cuerpo = "grant_type=authorization_code&code=ñandú";
    await pedir({ metodo: "POST", cuerpo, encabezados: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(recibido?.metodo).toBe("POST");
    expect(recibido?.body).toBe(cuerpo);
    expect(recibido?.headers["content-length"]).toBe(String(Buffer.byteLength(cuerpo)));
  });
});

describe("pedirFijado: lo que rechaza sin conectar", () => {
  it.each([
    ["http plano", "http://idp.example.com/x", "destino_rechazado"],
    ["IP literal", "https://93.184.216.34/x", "destino_rechazado"],
    ["la metadata de la nube", "https://169.254.169.254/latest/meta-data/", "destino_rechazado"],
    ["loopback escrito raro", "https://0x7f.1/x", "destino_rechazado"],
    ["otro puerto", "https://idp.example.com:8443/x", "destino_rechazado"],
    ["credenciales en la URL", "https://ana:clave@idp.example.com/x", "destino_rechazado"],
    ["URL que no es URL", "no-es-una-url", "destino_rechazado"],
  ])("%s", async (_, url, motivo) => {
    await expect(pedir({ url })).resolves.toEqual({ ok: false, motivo });
    expect(h.opciones).toHaveLength(0);
  });

  it.each([
    ["privada 10/8", "10.1.2.3"],
    ["loopback", "127.0.0.1"],
    ["link-local (metadata)", "169.254.169.254"],
    ["CGNAT", "100.64.0.9"],
    ["IPv6 loopback", "::1"],
    ["IPv6 local única", "fc00::1"],
    ["IPv4 mapeada a loopback", "::ffff:127.0.0.1"],
  ])("un nombre que resuelve a una dirección %s", async (_, address) => {
    h.lookup.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
    await expect(pedir()).resolves.toEqual({ ok: false, motivo: "destino_rechazado" });
    expect(h.opciones).toHaveLength(0);
  });

  it("si UNA de las direcciones es interna, rechaza (el sistema podría elegir esa)", async () => {
    h.lookup.mockResolvedValue([...PUBLICA, { address: "10.0.0.5", family: 4 }]);
    await expect(pedir()).resolves.toEqual({ ok: false, motivo: "destino_rechazado" });
    expect(h.opciones).toHaveLength(0);
  });

  it("una falla de DNS es red", async () => {
    h.lookup.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    await expect(pedir()).resolves.toEqual({ ok: false, motivo: "red" });
  });
});

describe("pedirFijado: la respuesta", () => {
  it("un 2xx devuelve el estado y el cuerpo", async () => {
    contesta(200, '{"a":1}');
    await expect(pedir()).resolves.toEqual({ ok: true, estado: 200, cuerpo: '{"a":1}' });
  });

  it("un 3xx no se sigue ni se pide de nuevo", async () => {
    contesta(302, "", { Location: "http://169.254.169.254/latest/meta-data/" });
    await expect(pedir()).resolves.toEqual({ ok: false, motivo: "redireccion" });
    expect(h.opciones).toHaveLength(1);
    expect(h.lookup).toHaveBeenCalledTimes(1);
  });

  it("un 4xx/5xx es http_<estado> sin el cuerpo", async () => {
    contesta(500, "stack trace con un secreto");
    const r = await pedir();
    expect(r).toEqual({ ok: false, motivo: "http_500" });
    expect(JSON.stringify(r)).not.toContain("secreto");
  });

  it("un cuerpo más grande que el tope llega como null, no cortado", async () => {
    contesta(200, "a".repeat(5_000));
    await expect(pedir({ topeBytes: 1024 })).resolves.toEqual({ ok: true, estado: 200, cuerpo: null });
  });

  it("uno justo en el tope entra entero", async () => {
    contesta(200, "a".repeat(1024));
    await expect(pedir({ topeBytes: 1024 })).resolves.toMatchObject({ ok: true, cuerpo: "a".repeat(1024) });
  });

  it("vence el plazo si el otro lado no contesta", async () => {
    responder = () => {};
    await expect(pedir({ plazoMs: 150 })).resolves.toEqual({ ok: false, motivo: "timeout" });
  });

  it("vence el plazo también si el DNS se cuelga", async () => {
    h.lookup.mockReturnValue(new Promise(() => {}));
    await expect(pedir({ plazoMs: 100 })).resolves.toEqual({ ok: false, motivo: "timeout" });
    expect(h.opciones).toHaveLength(0);
  });

  it("una conexión cortada es red", async () => {
    responder = (req) => req.socket.destroy();
    await expect(pedir()).resolves.toEqual({ ok: false, motivo: "red" });
  });
});
