// @vitest-environment node
/**
 * La guarda SSRF del webhook al Core. La URL la escribe un admin y la pide
 * nuestro servidor: sin esto, un admin (o quien le robe la sesión) apunta el
 * webhook a la metadata de la nube o a la red interna.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup, default: { lookup } }));

import { DestinoRechazado, revisarForma, validarDestino } from "@/server/core-sync/destino";

function resuelve(...direcciones: string[]) {
  lookup.mockResolvedValue(direcciones.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
}

async function motivo(url: string): Promise<string | null> {
  try {
    await validarDestino(url);
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(DestinoRechazado);
    return (e as DestinoRechazado).motivo;
  }
}

beforeEach(() => {
  lookup.mockReset();
});

describe("la forma de la URL, sin resolver", () => {
  it.each([
    ["http://core.example.com/h", "protocolo"],
    ["https://core.example.com:8443/h", "puerto"],
    ["https://core.example.com:80/h", "puerto"],
    ["https://user:pass@core.example.com/h", "credenciales"],
    [`https://core.example.com/${"a".repeat(2048)}`, "largo"],
    ["no es una url", "url_invalida"],
  ])("rechaza %s", async (url, esperado) => {
    expect(await motivo(url)).toBe(esperado);
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    "https://127.0.0.1/h",
    "https://2130706433/h",
    "https://0177.0.0.1/h",
    "https://0x7f.1/h",
    "https://[::1]/h",
    "https://[::ffff:127.0.0.1]/h",
    "https://[::ffff:7f00:1]/h",
    "https://93.184.216.34/h",
  ])("rechaza la IP literal %s", async (url) => {
    expect(await motivo(url)).toBe("ip_literal");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("revisarForma devuelve el host y deja pasar el 443 explícito", () => {
    expect(revisarForma("https://core.example.com:443/webhook?x=1")).toBe("core.example.com");
  });
});

describe("a dónde resuelve el nombre", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "100.64.0.1",
    "172.16.5.4",
    "192.168.1.1",
    "0.0.0.0",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "2001:db8::1",
    "2002::1",
    "2001::1",
    "ff02::1",
  ])("rechaza un nombre que resuelve a %s", async (ip) => {
    resuelve(ip);
    expect(await motivo("https://core.example.com/h")).toBe("direccion_interna");
  });

  it("rechaza si UNA de varias direcciones es interna", async () => {
    resuelve("93.184.216.34", "10.0.0.1");
    expect(await motivo("https://core.example.com/h")).toBe("direccion_interna");
  });

  it("rechaza un nombre sin direcciones", async () => {
    resuelve();
    expect(await motivo("https://core.example.com/h")).toBe("sin_direcciones");
  });

  it("acepta una IPv4 pública y devuelve esa IP con el nombre original", async () => {
    resuelve("93.184.216.34");
    await expect(validarDestino("https://core.example.com/h")).resolves.toEqual({
      host: "core.example.com",
      ip: "93.184.216.34",
      familia: 4,
    });
  });

  it("acepta una IPv6 pública", async () => {
    resuelve("2606:4700::1");
    await expect(validarDestino("https://core.example.com/h")).resolves.toEqual({
      host: "core.example.com",
      ip: "2606:4700::1",
      familia: 6,
    });
  });

  it("resuelve una sola vez, con todas las direcciones", async () => {
    resuelve("93.184.216.34");
    await validarDestino("https://core.example.com/h");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("core.example.com", { all: true, verbatim: true });
  });
});
