/**
 * Sentry #137: `beforeSend` tacha todo el evento, no sólo el mensaje de la
 * excepción — cabeceras, cookies, breadcrumbs, extra, tags, contexts y user.
 */

import { describe, it, expect } from "vitest";
import { limpiarEventoDeSentry, sinConsultaDeMeta, sinRutaDeApp, tacharTexto } from "@/lib/observability/sentry-scrub";

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

describe("sinConsultaDeMeta", () => {
  it("saca la consulta y el fragmento de una URL de Graph", () => {
    expect(sinConsultaDeMeta("https://graph.facebook.com/v22.0/oauth/access_token?client_secret=fake-secret&code=fake-code")).toBe(
      "https://graph.facebook.com/v22.0/oauth/access_token"
    );
    expect(sinConsultaDeMeta("https://graph.facebook.com/v22.0/123?fields=id#fake-fragment")).toBe("https://graph.facebook.com/v22.0/123");
    expect(sinConsultaDeMeta("https://graph.facebook.com/v22.0/123?")).toBe("https://graph.facebook.com/v22.0/123");
  });

  it("vale para cualquier subdominio de facebook.com y para http, con puerto o mayúsculas", () => {
    expect(sinConsultaDeMeta("https://www.facebook.com/dialog/oauth?access_token=fake-token")).toBe("https://www.facebook.com/dialog/oauth");
    expect(sinConsultaDeMeta("https://facebook.com/x?a=1")).toBe("https://facebook.com/x");
    expect(sinConsultaDeMeta("HTTP://GRAPH.FACEBOOK.COM:443/x?a=1")).toBe("HTTP://GRAPH.FACEBOOK.COM:443/x");
    expect(sinConsultaDeMeta("https://graph.facebook.com?a=1")).toBe("https://graph.facebook.com");
  });

  it("una URL de Graph sin consulta queda igual", () => {
    expect(sinConsultaDeMeta("https://graph.facebook.com/v22.0/123/register")).toBe("https://graph.facebook.com/v22.0/123/register");
  });

  it("otros hosts quedan como vienen, también los que se le parecen", () => {
    for (const url of [
      "https://example.com/x?a=1",
      "https://evil-facebook.com/x?a=1",
      "https://facebook.com.example.com/x?a=1",
      "https://graph.facebook.com@example.com/x?a=1",
      "https://example.com/?next=https://graph.facebook.com/x",
      "/api/cases?dni=1",
      "no es una url?a=1",
    ]) {
      expect(sinConsultaDeMeta(url)).toBe(url);
    }
  });
});

describe("limpiarEventoDeSentry: pedidos a Meta", () => {
  const CON_SECRETOS = "https://graph.facebook.com/v22.0/oauth/access_token?client_secret=fake-secret&code=fake-code&access_token=fake-token";
  const SIN_CONSULTA = "https://graph.facebook.com/v22.0/oauth/access_token";

  it("el breadcrumb de un fetch a Graph pierde la consulta de su URL", () => {
    const evento = {
      breadcrumbs: [
        { category: "fetch", data: { url: CON_SECRETOS, method: "POST", status_code: 400 } },
        { category: "fetch", data: { url: "https://example.com/api?x=1", method: "GET" } },
      ],
    };

    const resultado = limpiarEventoDeSentry(evento);

    expect(resultado?.breadcrumbs?.[0]?.data).toEqual({ url: SIN_CONSULTA, method: "POST", status_code: 400 });
    expect(resultado?.breadcrumbs?.[1]?.data?.url).toBe("https://example.com/api?x=1");
    expect(JSON.stringify(resultado)).not.toMatch(/fake-secret|fake-code|fake-token/);
  });

  it("la transacción pierde la consulta en los spans: sus datos y su descripción", () => {
    const evento = {
      type: "transaction",
      spans: [
        {
          description: `POST ${CON_SECRETOS}`,
          data: {
            url: CON_SECRETOS,
            "url.full": CON_SECRETOS,
            "http.url": CON_SECRETOS,
            "http.query": "?client_secret=fake-secret",
            "url.query": "client_secret=fake-secret",
            "http.method": "POST",
          },
        },
        { description: "GET https://example.com/a?b=1", data: { url: "https://example.com/a?b=1", "http.query": "?b=1" } },
        { description: "select 1" },
      ],
    };

    const resultado = limpiarEventoDeSentry(evento);

    expect(resultado?.spans?.[0]?.description).toBe(`POST ${SIN_CONSULTA}`);
    expect(resultado?.spans?.[0]?.data).toEqual({
      url: SIN_CONSULTA,
      "url.full": SIN_CONSULTA,
      "http.url": SIN_CONSULTA,
      "http.method": "POST",
    });
    expect(resultado?.spans?.[1]).toEqual({
      description: "GET https://example.com/a?b=1",
      data: { url: "https://example.com/a?b=1", "http.query": "?b=1" },
    });
    expect(resultado?.spans?.[2]).toEqual({ description: "select 1" });
    expect(JSON.stringify(resultado)).not.toMatch(/fake-secret|fake-code|fake-token/);
  });

  it("un span o breadcrumb sin datos no tira", () => {
    expect(limpiarEventoDeSentry({ spans: [{}], breadcrumbs: [{ message: "x" }] })).toEqual({
      spans: [{}],
      breadcrumbs: [{ message: "x" }],
    });
  });
});

describe("sinRutaDeApp", () => {
  const RUTA = "fake-ruta-secreta-del-webhook_0-9";

  it("deja el tramo de la ruta de la app de un cliente en «:ruta»", () => {
    expect(sinRutaDeApp(`/api/webhooks/whatsapp/app/${RUTA}`)).toBe("/api/webhooks/whatsapp/app/:ruta");
  });

  it("vale dentro de una URL completa, con consulta o fragmento, y deja lo demás", () => {
    expect(sinRutaDeApp(`https://claimmix.example.com/api/webhooks/whatsapp/app/${RUTA}?x=1`)).toBe(
      "https://claimmix.example.com/api/webhooks/whatsapp/app/:ruta?x=1"
    );
    expect(sinRutaDeApp(`/api/webhooks/whatsapp/app/${RUTA}#frag`)).toBe("/api/webhooks/whatsapp/app/:ruta#frag");
  });

  it("vale dentro de un texto: «POST <ruta> 200», entre comillas y varias veces", () => {
    expect(sinRutaDeApp(`POST /api/webhooks/whatsapp/app/${RUTA} 200`)).toBe("POST /api/webhooks/whatsapp/app/:ruta 200");
    expect(sinRutaDeApp(`"/api/webhooks/whatsapp/app/${RUTA}" y '/api/webhooks/whatsapp/app/${RUTA}'`)).toBe(
      `"/api/webhooks/whatsapp/app/:ruta" y '/api/webhooks/whatsapp/app/:ruta'`
    );
    expect(sinRutaDeApp(`a /api/webhooks/whatsapp/app/${RUTA} b /api/webhooks/whatsapp/app/${RUTA}-otra`)).toBe(
      "a /api/webhooks/whatsapp/app/:ruta b /api/webhooks/whatsapp/app/:ruta"
    );
  });

  it("sólo toca el primer tramo tras /app/: lo que sigue de la ruta queda", () => {
    expect(sinRutaDeApp(`/api/webhooks/whatsapp/app/${RUTA}/extra`)).toBe("/api/webhooks/whatsapp/app/:ruta/extra");
  });

  it("el webhook de la plataforma y cualquier otra ruta quedan igual", () => {
    for (const texto of [
      "/api/webhooks/whatsapp",
      "/api/webhooks/whatsapp?hub.mode=subscribe",
      "/api/webhooks/gmail/app/algo",
      "/api/cases/app/algo",
      "texto sin ruta",
      "",
    ]) {
      expect(sinRutaDeApp(texto)).toBe(texto);
    }
  });

  it("sin nada tras /app/ no hay ruta que sacar", () => {
    expect(sinRutaDeApp("/api/webhooks/whatsapp/app/")).toBe("/api/webhooks/whatsapp/app/");
  });

  it("repetirlo da lo mismo", () => {
    const una = sinRutaDeApp(`/api/webhooks/whatsapp/app/${RUTA}`);
    expect(sinRutaDeApp(una)).toBe(una);
  });
});

describe("limpiarEventoDeSentry: la ruta del webhook de una app", () => {
  const RUTA = "fake-ruta-secreta-del-webhook_0-9";
  const PATH = `/api/webhooks/whatsapp/app/${RUTA}`;
  const SIN_RUTA = "/api/webhooks/whatsapp/app/:ruta";

  it("tacharTexto la saca de cualquier texto", () => {
    expect(tacharTexto(`falló ${PATH}`)).toBe(`falló ${SIN_RUTA}`);
  });

  it("no queda en ninguna parte del evento", () => {
    const evento = {
      message: `POST ${PATH} 500`,
      transaction: `POST ${PATH}`,
      exception: { values: [{ value: `firma inválida en ${PATH}` }] },
      breadcrumbs: [{ message: `llegó ${PATH}`, data: { url: PATH, "http.url": `https://claimmix.example.com${PATH}?x=1` } }],
      spans: [
        { description: `POST https://claimmix.example.com${PATH}`, data: { url: `https://claimmix.example.com${PATH}`, "http.target": PATH } },
      ],
      request: { url: `https://claimmix.example.com${PATH}`, query_string: "x=1" },
      extra: { ruta: PATH },
      tags: { transaction: PATH },
      contexts: { trace: { description: PATH } },
    };

    const resultado = limpiarEventoDeSentry(evento);

    expect(JSON.stringify(resultado)).not.toContain(RUTA);
    expect(resultado?.message).toBe(`POST ${SIN_RUTA} 500`);
    expect(resultado?.transaction).toBe(`POST ${SIN_RUTA}`);
    expect(resultado?.exception?.values?.[0]?.value).toBe(`firma inválida en ${SIN_RUTA}`);
    expect(resultado?.breadcrumbs?.[0]?.message).toBe(`llegó ${SIN_RUTA}`);
    expect(resultado?.spans?.[0]?.description).toBe(`POST https://claimmix.example.com${SIN_RUTA}`);
    expect(resultado?.spans?.[0]?.data).toEqual({ url: `https://claimmix.example.com${SIN_RUTA}`, "http.target": SIN_RUTA });
    expect(resultado?.request?.url).toBe(`https://claimmix.example.com${SIN_RUTA}`);
  });

  it("la transacción de la ruta del webhook de la plataforma no se toca", () => {
    expect(limpiarEventoDeSentry({ transaction: "POST /api/webhooks/whatsapp" })?.transaction).toBe("POST /api/webhooks/whatsapp");
  });

  it("un evento sin transacción ni spans no gana ninguno", () => {
    expect(limpiarEventoDeSentry({ message: "ok" })).toEqual({ message: "ok" });
  });

  it("los datos de un span que no son texto quedan como vienen", () => {
    const resultado = limpiarEventoDeSentry({ spans: [{ data: { "http.status_code": 200, ok: true, nada: null, url: PATH } }] });
    expect(resultado?.spans?.[0]?.data).toEqual({ "http.status_code": 200, ok: true, nada: null, url: SIN_RUTA });
  });
});

describe("limpiarEventoDeSentry: los secretos de la app propia", () => {
  it("las claves con secreto, token o prueba salen tachadas de extra, tags, contexts y breadcrumbs", () => {
    const evento = {
      extra: {
        secreto: "fake-client-app-secret",
        appsecret_proof: "fake-proof-0123456789",
        access_token: "fake-token-value",
        token: "fake-token-value",
        client_secret: "fake-client-app-secret",
        input_token: "fake-token-value",
        wabaId: "200000000000002",
      },
      contexts: { alta: { token: "fake-token-value", pasos: 3 } },
      breadcrumbs: [{ data: { appsecret_proof: "fake-proof-0123456789", paso: "revisar" } }],
    };

    const resultado = limpiarEventoDeSentry(evento);
    const json = JSON.stringify(resultado);

    expect(json).not.toContain("fake-client-app-secret");
    expect(json).not.toContain("fake-proof-0123456789");
    expect(json).not.toContain("fake-token-value");
    expect(resultado?.extra).toMatchObject({ secreto: "[TACHADO]", appsecret_proof: "[TACHADO]", access_token: "[TACHADO]", wabaId: "200000000000002" });
    expect(resultado?.breadcrumbs?.[0]?.data).toEqual({ appsecret_proof: "[TACHADO]", paso: "revisar" });
    expect(resultado?.contexts).toEqual({ alta: { token: "[TACHADO]", pasos: 3 } });
  });

  it("la URL de Graph con appsecret_proof o access_token pierde la consulta, en breadcrumbs, spans y descripción", () => {
    const URL_CON_PRUEBA = "https://graph.facebook.com/v22.0/200000000000002/subscribed_apps?appsecret_proof=fake-proof-0123456789";
    const evento = {
      breadcrumbs: [{ category: "fetch", data: { url: URL_CON_PRUEBA, method: "POST" } }],
      spans: [{ description: `POST ${URL_CON_PRUEBA}`, data: { "http.url": URL_CON_PRUEBA, "http.query": "?appsecret_proof=fake-proof-0123456789" } }],
    };

    const resultado = limpiarEventoDeSentry(evento);

    expect(JSON.stringify(resultado)).not.toContain("fake-proof-0123456789");
    expect(resultado?.breadcrumbs?.[0]?.data?.url).toBe("https://graph.facebook.com/v22.0/200000000000002/subscribed_apps");
    expect(resultado?.spans?.[0]?.description).toBe("POST https://graph.facebook.com/v22.0/200000000000002/subscribed_apps");
    expect(resultado?.spans?.[0]?.data).toEqual({ "http.url": "https://graph.facebook.com/v22.0/200000000000002/subscribed_apps" });
  });
});
