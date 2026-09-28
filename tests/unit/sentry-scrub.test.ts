/**
 * Sentry #137: `beforeSend` tacha todo el evento, no sólo el mensaje de la
 * excepción — cabeceras, cookies, breadcrumbs, extra, tags, contexts y user.
 */

import { describe, it, expect } from "vitest";
import { limpiarEventoDeSentry } from "@/lib/observability/sentry-scrub";

describe("limpiarEventoDeSentry", () => {
  it("tacha DNI, email, póliza y patente en todo el evento, y no deja credenciales ni PII", () => {
    const evento = {
      message: "DNI 30.145.882 de ana.perez@ejemplo.com, póliza 1234-5678, patente AB 123 CD",
      exception: {
        values: [
          {
            value: "DNI 30.145.882 de ana.perez@ejemplo.com, póliza 1234-5678, patente AB 123 CD",
          },
        ],
      },
      breadcrumbs: [
        {
          message: "select … where dni = 30145882",
          data: { cookie: "s=abc", dni: "30145882" },
        },
      ],
      request: {
        url: "/api/cases?dni=30145882",
        data: { body: "x" },
        cookies: { session: "abc" },
        headers: {
          Authorization: "Bearer t",
          Cookie: "s=1",
          "user-agent": "UA",
          "x-api-key": "k",
        },
      },
      extra: { token: "t", texto: "DNI 30145882" },
      user: { id: "u1", email: "ana.perez@ejemplo.com", ip_address: "1.2.3.4" },
      tags: { email: "ana.perez@ejemplo.com" },
    };

    const resultado = limpiarEventoDeSentry(evento);
    const json = JSON.stringify(resultado);

    expect(json).not.toContain("30.145.882");
    expect(json).not.toContain("30145882");
    expect(json).not.toContain("ana.perez");
    expect(json).not.toContain("Bearer t");
    expect(json).not.toContain("s=abc");
    expect(json).not.toContain("s=1");
    expect(json).not.toContain('"k"');
    expect(json).not.toContain("1.2.3.4");
    expect(json).not.toContain("1234-5678");

    expect(json).toContain("[DNI]");
    expect(json).toContain("[EMAIL]");
    expect(json).toContain("[TACHADO]");

    expect(resultado?.request?.headers).toEqual({ "user-agent": "UA" });
    expect(resultado?.request?.data).toBeUndefined();
    expect(resultado?.request?.cookies).toBeUndefined();
    expect(resultado?.user).toEqual({ id: "u1" });
    expect(resultado?.exception?.values?.[0]?.value).toContain("[DNI]");
  });

  it("también tacha un evento de transacción (beforeSendTransaction)", () => {
    const evento = {
      type: "transaction",
      transaction: "GET /api/cases",
      request: {
        url: "https://claimmix.vercel.app/api/cases?dni=30145882",
        headers: { Cookie: "s=abc", "user-agent": "UA" },
        cookies: { session: "abc" },
      },
    };

    const resultado = limpiarEventoDeSentry(evento);

    expect(resultado?.request?.url).toContain("[DNI]");
    expect(resultado?.request?.url).not.toContain("30145882");
    expect(resultado?.request?.headers).toEqual({ "user-agent": "UA" });
    expect(resultado?.request?.cookies).toBeUndefined();
  });

  it("descarta el evento si algo tira adentro", () => {
    const evento: Record<string, unknown> = { message: "ok" };
    Object.defineProperty(evento, "extra", {
      get() {
        throw new Error("x");
      },
      enumerable: true,
    });

    expect(limpiarEventoDeSentry(evento)).toBeNull();
  });

  it("evento vacío no tira", () => {
    expect(limpiarEventoDeSentry({})).toEqual({});
  });
});
