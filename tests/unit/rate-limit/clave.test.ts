/**
 * La IP con la que se cuenta un cupo (H13).
 *
 * Con la dirección IPv6 literal, un VPS con un /64 (lo normal en cualquier
 * proveedor) tiene 2^64 direcciones: cada pedido sale de una distinta y estrena
 * cupo, así que ni el tope de altas ni el del login frenan nada. La clave
 * cuenta por prefijo.
 *
 * Direcciones de documentación (2001:db8::/32, 203.0.113.0/24), nunca reales.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { claveDeCupo, normalizarIpParaCupo } from "@/lib/rate-limit/clave";
import { clearAllRateLimits, RATE_LIMIT_CONFIGS, topePorIp } from "@/lib/rate-limit/index";

describe("normalizarIpParaCupo", () => {
  it("corta una IPv6 a su /64", () => {
    expect(normalizarIpParaCupo("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
  });

  it("la misma dirección escrita de otra forma da lo mismo", () => {
    const comprimida = normalizarIpParaCupo("2001:db8::1");
    expect(normalizarIpParaCupo("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe(comprimida);
    expect(normalizarIpParaCupo("[2001:db8::1]")).toBe(comprimida);
    expect(normalizarIpParaCupo("2001:db8::1%eth0")).toBe(comprimida);
  });

  it("la IPv4 mapeada es la IPv4, escrita como se escriba", () => {
    expect(normalizarIpParaCupo("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(normalizarIpParaCupo("::FFFF:cb00:7107")).toBe("203.0.113.7");
    expect(normalizarIpParaCupo("0:0:0:0:0:ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("una IPv4 queda literal", () => {
    expect(normalizarIpParaCupo("203.0.113.7")).toBe("203.0.113.7");
  });

  it("corta a /56 cuando se lo piden", () => {
    expect(normalizarIpParaCupo("2001:db8:abcd:12ff::1", 56)).toBe("2001:db8:abcd:1200::/56");
    expect(normalizarIpParaCupo("2001:db8:abcd:1200::1", 56)).toBe("2001:db8:abcd:1200::/56");
  });

  it("lo que no es una IPv6 vuelve como entró", () => {
    expect(normalizarIpParaCupo("anonymous")).toBe("anonymous");
    expect(normalizarIpParaCupo("ana@example.com")).toBe("ana@example.com");
    expect(normalizarIpParaCupo("0a1b2c3d4e5f60718293a4b5c6d7e8f9")).toBe("0a1b2c3d4e5f60718293a4b5c6d7e8f9");
    expect(normalizarIpParaCupo("2001:db8::zzzz")).toBe("2001:db8::zzzz");
    expect(normalizarIpParaCupo("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
    expect(normalizarIpParaCupo("2001::db8::1")).toBe("2001::db8::1");
  });

  it("aplicarla dos veces no la cambia", () => {
    const una = normalizarIpParaCupo("2001:db8:abcd:12::99");
    expect(normalizarIpParaCupo(una)).toBe(una);
  });
});

describe("claveDeCupo con IP", () => {
  it("dos IPv6 del mismo /64 comparten cupo", () => {
    expect(claveDeCupo("auth:ip", "2001:db8:abcd:12::1")).toBe(
      claveDeCupo("auth:ip", "2001:db8:abcd:12:ffff:ffff:ffff:ffff")
    );
  });

  it("dos /64 distintos no", () => {
    expect(claveDeCupo("auth:ip", "2001:db8:abcd:12::1")).not.toBe(
      claveDeCupo("auth:ip", "2001:db8:abcd:13::1")
    );
  });

  it("dos /64 distintos del mismo /56 comparten alta:ip, y no auth:ip", () => {
    const a = "2001:db8:abcd:1200::1";
    const b = "2001:db8:abcd:12ff::1";
    expect(claveDeCupo("alta:ip", a)).toBe(claveDeCupo("alta:ip", b));
    expect(claveDeCupo("auth:ip", a)).not.toBe(claveDeCupo("auth:ip", b));
  });

  it("alta:correo-ip también corta a /56", () => {
    expect(claveDeCupo("alta:correo-ip", "2001:db8:abcd:1200::1")).toBe(
      claveDeCupo("alta:correo-ip", "2001:db8:abcd:12ff::1")
    );
    expect(claveDeCupo("alta:correo-ip", "2001:db8:abcd:1200::1")).toBe("alta:correo-ip:2001:db8:abcd:1200::/56");
  });

  it("dos /56 distintos no comparten alta:ip", () => {
    expect(claveDeCupo("alta:ip", "2001:db8:abcd:1200::1")).not.toBe(
      claveDeCupo("alta:ip", "2001:db8:abcd:1300::1")
    );
  });

  it("::ffff:a.b.c.d cuenta como a.b.c.d", () => {
    expect(claveDeCupo("auth:up", "::ffff:203.0.113.7")).toBe(claveDeCupo("auth:up", "203.0.113.7"));
  });

  it("la dirección de un mail y el resto de las partes no se tocan", () => {
    expect(claveDeCupo("auth:in", "2001:db8:abcd:12::1", " Ana@Example.COM ")).toBe(
      "auth:in:2001:db8:abcd:12::/64:ana@example.com"
    );
    expect(claveDeCupo("aviso-tardio", "T-1", "C-1")).toBe("aviso-tardio:t-1:c-1");
  });
});

describe("topePorIp con IPv6", () => {
  beforeEach(() => {
    clearAllRateLimits();
  });

  it("diez direcciones del mismo /64 agotan UN cupo, no diez", async () => {
    const tope = RATE_LIMIT_CONFIGS.AUTH_POR_IP.limit;
    let ultimo = await topePorIp("2001:db8:1:2::1");
    for (let i = 2; i <= tope + 1; i++) {
      ultimo = await topePorIp(`2001:db8:1:2:${i.toString(16)}::${i.toString(16)}`);
    }
    expect(ultimo.allowed).toBe(false);

    expect((await topePorIp("2001:db8:1:3::1")).allowed).toBe(true);
  });

  it("la IPv4 mapeada y la IPv4 comparten cupo", async () => {
    const a = await topePorIp("203.0.113.40");
    const b = await topePorIp("::ffff:203.0.113.40");
    expect(b.remaining).toBe(a.remaining - 1);
  });
});
