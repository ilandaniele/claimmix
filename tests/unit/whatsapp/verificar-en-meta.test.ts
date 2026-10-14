/**
 * Lo que se le pregunta a Meta antes de conectar un número, y cómo se lee lo que
 * contesta. El resto de la historia (qué se escribe después) está en
 * `tests/unit/alta/panel-operador.test.ts`; acá sólo el cuidado con Graph.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { estaEnLaWaba, recorrerLaWaba, recorrerLaWabaOFalla, verificarEnMeta } from "@/server/whatsapp/verificar-en-meta";

const SAVED = { ...process.env };

const WABA = "200000000000001";
const ID = "100000000000777";
const NUMERO = "+5491100000000";
const PEDIDO = { phoneNumberId: ID, wabaId: WABA, numeroE164: NUMERO };

const respuesta = (cuerpo: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => cuerpo }) as Response;

beforeEach(() => {
  process.env.WHATSAPP_ACCESS_TOKEN = "fake-access-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = "100000000000001";
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = WABA;
  delete process.env.WHATSAPP_API_VERSION;
});

afterEach(() => {
  process.env = { ...SAVED };
  vi.unstubAllGlobals();
});

describe("verificarEnMeta", () => {
  it("confirma número e id con el token de la plataforma y devuelve el nombre verificado", async () => {
    const fetchFalso = vi.fn(async (url: string) =>
      url.includes("/phone_numbers")
        ? respuesta({ data: [{ id: ID }] })
        : respuesta({ display_phone_number: "+54 9 11 0000-0000", verified_name: " Seguros Fake " })
    );
    vi.stubGlobal("fetch", fetchFalso);

    expect(await verificarEnMeta(PEDIDO)).toEqual({ ok: true, nombreVerificado: "Seguros Fake" });

    const [primera, segunda] = fetchFalso.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(primera[0]).toBe(`https://graph.facebook.com/v22.0/${ID}?fields=display_phone_number,verified_name`);
    expect(segunda[0]).toBe(`https://graph.facebook.com/v22.0/${WABA}/phone_numbers?fields=id&limit=100`);
    expect(primera[1].headers).toEqual({ Authorization: "Bearer fake-access-token" });
  });

  it("recorre las páginas de la WABA hasta encontrar el id, y se detiene cuando no hay más", async () => {
    const pedidos: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        pedidos.push(url);
        if (!url.includes("/phone_numbers")) return respuesta({ display_phone_number: NUMERO });
        if (url.includes("after=PAG2")) return respuesta({ data: [{ id: ID }] });
        return respuesta({ data: [{ id: "100000000000001" }], paging: { cursors: { after: "PAG2" }, next: "https://graph.example.com/x" } });
      })
    );

    expect(await verificarEnMeta(PEDIDO)).toMatchObject({ ok: true });
    expect(pedidos.filter((u) => u.includes("/phone_numbers"))).toHaveLength(2);

    // Sin `next` no hay otra página: el id que no está es «fuera de la WABA», no un bucle.
    pedidos.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/phone_numbers")
          ? respuesta({ data: [{ id: "100000000000001" }], paging: { cursors: { after: "PAG2" } } })
          : respuesta({ display_phone_number: NUMERO })
      )
    );
    expect(await verificarEnMeta(PEDIDO)).toEqual({ ok: false, motivo: "fuera_de_la_waba" });
  });

  it("un paging que nunca termina se corta en diez páginas", async () => {
    const fetchFalso = vi.fn(async (url: string) =>
      url.includes("/phone_numbers")
        ? respuesta({ data: [{ id: "100000000000001" }], paging: { cursors: { after: "SIGUE" }, next: "https://graph.example.com/x" } })
        : respuesta({ display_phone_number: NUMERO })
    );
    vi.stubGlobal("fetch", fetchFalso);

    expect(await verificarEnMeta(PEDIDO)).toEqual({ ok: false, motivo: "fuera_de_la_waba" });
    expect(fetchFalso).toHaveBeenCalledTimes(11);
  });

  it("lo tipeado no llega a la URL si no son sólo dígitos", async () => {
    const fetchFalso = vi.fn();
    vi.stubGlobal("fetch", fetchFalso);

    for (const raro of ["../me", "1234/accounts", "12345?access_token=x", "1234", "abc12345", ""]) {
      expect(await verificarEnMeta({ ...PEDIDO, phoneNumberId: raro })).toEqual({ ok: false, motivo: "id_inexistente" });
    }
    expect(await verificarEnMeta({ ...PEDIDO, wabaId: "12345/x" })).toEqual({ ok: false, motivo: "id_inexistente" });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("una WABA distinta de la del entorno, o sin WABA en el entorno, no se consulta", async () => {
    const fetchFalso = vi.fn();
    vi.stubGlobal("fetch", fetchFalso);

    expect(await verificarEnMeta({ ...PEDIDO, wabaId: "200000000000999" })).toEqual({ ok: false, motivo: "waba_distinta" });

    delete process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    expect(await verificarEnMeta(PEDIDO)).toEqual({ ok: false, motivo: "sin_credencial" });

    delete process.env.WHATSAPP_ACCESS_TOKEN;
    process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = WABA;
    expect(await verificarEnMeta(PEDIDO)).toEqual({ ok: false, motivo: "sin_credencial" });
    expect(fetchFalso).not.toHaveBeenCalled();
  });

  it("4xx es «no existe»; 429, 5xx, red caída y cuerpo raro son «Meta no responde»", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respuesta({}, 404)));
    expect(await verificarEnMeta(PEDIDO)).toEqual({ ok: false, motivo: "id_inexistente" });

    vi.stubGlobal("fetch", vi.fn(async () => respuesta({}, 429)));
    expect(await verificarEnMeta(PEDIDO)).toEqual({ ok: false, motivo: "meta_no_responde" });

    vi.stubGlobal("fetch", vi.fn(async () => respuesta({}, 502)));
    expect(await verificarEnMeta(PEDIDO)).toEqual({ ok: false, motivo: "meta_no_responde" });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    expect(await verificarEnMeta(PEDIDO)).toEqual({ ok: false, motivo: "meta_no_responde" });

    // 200 sin display_phone_number: no se interpreta, no se conecta.
    vi.stubGlobal("fetch", vi.fn(async () => respuesta({ verified_name: "Seguros Fake" })));
    expect(await verificarEnMeta(PEDIDO)).toEqual({ ok: false, motivo: "meta_no_responde" });

    // La lista de la WABA que no es una lista tampoco.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (url.includes("/phone_numbers") ? respuesta({ data: "raro" }) : respuesta({ display_phone_number: NUMERO })))
    );
    expect(await verificarEnMeta(PEDIDO)).toEqual({ ok: false, motivo: "meta_no_responde" });
  });

  it("el número de Graph es otro: numero_distinto, y no llega a mirar la WABA", async () => {
    const fetchFalso = vi.fn(async () => respuesta({ display_phone_number: "+54 9 11 0000-0001" }));
    vi.stubGlobal("fetch", fetchFalso);

    expect(await verificarEnMeta(PEDIDO)).toEqual({ ok: false, motivo: "numero_distinto" });
    expect(fetchFalso).toHaveBeenCalledTimes(1);
  });
});

describe("recorrerLaWaba", () => {
  const SIGUE = { cursors: { after: "SIGUE" }, next: "https://graph.example.com/x" };

  it("pide los campos que se le piden, con el token de la plataforma, y devuelve las filas", async () => {
    const fetchFalso = vi.fn(async () =>
      respuesta({ data: [{ id: ID, display_phone_number: " +54 9 11 0000-0000 " }, { id: "100000000000001" }] })
    );
    vi.stubGlobal("fetch", fetchFalso);

    expect(await recorrerLaWaba(WABA, "id,display_phone_number", "fake-access-token")).toEqual({
      filas: [
        { id: ID, display: "+54 9 11 0000-0000", nombre: null },
        { id: "100000000000001", display: null, nombre: null },
      ],
      completa: true,
    });

    const [[url, init]] = fetchFalso.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(url).toBe(`https://graph.facebook.com/v22.0/${WABA}/phone_numbers?fields=id,display_phone_number&limit=100`);
    expect(init.headers).toEqual({ Authorization: "Bearer fake-access-token" });
  });

  it("con verified_name trae el nombre de cada número, y lo que no es un texto queda en null", async () => {
    const fetchFalso = vi.fn(async () =>
      respuesta({ data: [{ id: "100000000000001", display_phone_number: "+54 9 291 000-0000", verified_name: " Veltra " }, { id: 7, verified_name: "" }] })
    );
    vi.stubGlobal("fetch", fetchFalso);

    expect(await recorrerLaWaba(WABA, "id,display_phone_number,verified_name", "fake-access-token")).toEqual({
      filas: [
        { id: "100000000000001", display: "+54 9 291 000-0000", nombre: "Veltra" },
        { id: null, display: null, nombre: null },
      ],
      completa: true,
    });
    expect((fetchFalso.mock.calls as unknown as Array<[string]>)[0][0]).toBe(
      `https://graph.facebook.com/v22.0/${WABA}/phone_numbers?fields=id,display_phone_number,verified_name&limit=100`
    );
  });

  it("sigue el cursor de cada página y junta las filas en orden", async () => {
    const pedidos: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        pedidos.push(url);
        if (url.includes("after=PAG2")) return respuesta({ data: [{ id: "2" }] });
        return respuesta({ data: [{ id: "1" }], paging: { cursors: { after: "PAG2" }, next: "https://graph.example.com/x" } });
      })
    );

    const r = await recorrerLaWaba(WABA, "id", "fake-access-token");
    expect(r).toEqual({ filas: [{ id: "1", display: null, nombre: null }, { id: "2", display: null, nombre: null }], completa: true });
    expect(pedidos).toEqual([
      `https://graph.facebook.com/v22.0/${WABA}/phone_numbers?fields=id&limit=100`,
      `https://graph.facebook.com/v22.0/${WABA}/phone_numbers?fields=id&limit=100&after=PAG2`,
    ]);
  });

  it("un paging que nunca termina se corta en diez páginas, y no está completa", async () => {
    const fetchFalso = vi.fn(async () => respuesta({ data: [{ id: "100000000000001" }], paging: SIGUE }));
    vi.stubGlobal("fetch", fetchFalso);

    const r = await recorrerLaWaba(WABA, "id", "fake-access-token");
    expect(r?.completa).toBe(false);
    expect(r?.filas).toHaveLength(10);
    expect(fetchFalso).toHaveBeenCalledTimes(10);
  });

  it("un next sin cursor para pedir la que sigue tampoco está completa", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respuesta({ data: [{ id: "1" }], paging: { next: "https://graph.example.com/x" } })));

    expect(await recorrerLaWaba(WABA, "id", "fake-access-token")).toEqual({
      filas: [{ id: "1", display: null, nombre: null }],
      completa: false,
    });
  });

  it("si parar da true corta en esa fila, sin pedir más páginas, y queda completa", async () => {
    const fetchFalso = vi.fn(async () => respuesta({ data: [{ id: "1" }, { id: ID }, { id: "3" }], paging: SIGUE }));
    vi.stubGlobal("fetch", fetchFalso);

    const r = await recorrerLaWaba(WABA, "id", "fake-access-token", (f) => f.id === ID);
    expect(r?.completa).toBe(true);
    expect(r?.filas.map((f) => f.id)).toEqual(["1", ID]);
    expect(fetchFalso).toHaveBeenCalledTimes(1);
  });

  it("una página que no es 2xx, la red caída o un data que no es lista dan null", async () => {
    let paginas = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (++paginas === 1 ? respuesta({ data: [{ id: "1" }], paging: SIGUE }) : respuesta({}, 502)))
    );
    expect(await recorrerLaWaba(WABA, "id", "fake-access-token")).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    expect(await recorrerLaWaba(WABA, "id", "fake-access-token")).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => respuesta({ data: "raro" })));
    expect(await recorrerLaWaba(WABA, "id", "fake-access-token")).toBeNull();
  });
});

describe("recorrerLaWabaOFalla", () => {
  const error = (code: number | undefined, status: number, subcode?: number) =>
    respuesta({ error: { ...(code === undefined ? {} : { code }), ...(subcode === undefined ? {} : { error_subcode: subcode }) } }, status);

  it("con filas devuelve el recorrido en `valor`", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respuesta({ data: [{ id: ID }] })));
    expect(await recorrerLaWabaOFalla(WABA, "id", "fake-access-token")).toEqual({
      ok: true,
      valor: { filas: [{ id: ID, display: null, nombre: null }], completa: true },
    });
  });

  it.each<[string, Response, { falla: string; codigo: number | null; subcodigo?: number }]>([
    ["un 400 con el code 100 de Graph", error(100, 400), { falla: "rechazo", codigo: 100 }],
    ["un 400 con code y subcode", error(190, 400, 463), { falla: "rechazo", codigo: 190, subcodigo: 463 }],
    ["un 403 con el code 200", error(200, 403), { falla: "rechazo", codigo: 200 }],
    ["un 4xx sin code ni cuerpo", respuesta(null, 400), { falla: "rechazo", codigo: null }],
    ["un 429", error(undefined, 429), { falla: "esperar", codigo: null }],
    ["un code que pide esperar, con 400", error(4, 400), { falla: "esperar", codigo: 4 }],
    ["un 502", respuesta({}, 502), { falla: "meta", codigo: null }],
  ])("%s: la falla lleva lo que Graph dijo", async (_nombre, res, esperado) => {
    vi.stubGlobal("fetch", vi.fn(async () => res));
    expect(await recorrerLaWabaOFalla(WABA, "id", "fake-access-token")).toEqual({ ok: false, ...esperado });
  });

  it("el error de una página posterior también trae el code", async () => {
    let paginas = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (++paginas === 1 ? respuesta({ data: [{ id: "1" }], paging: { cursors: { after: "SIGUE" }, next: "https://graph.example.com/x" } }) : error(100, 400)))
    );
    expect(await recorrerLaWabaOFalla(WABA, "id", "fake-access-token")).toEqual({ ok: false, falla: "rechazo", codigo: 100 });
  });

  it("la red caída y un data que no es lista son «meta»: Graph no dijo nada", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
    expect(await recorrerLaWabaOFalla(WABA, "id", "fake-access-token")).toEqual({ ok: false, falla: "meta", codigo: null });

    vi.stubGlobal("fetch", vi.fn(async () => respuesta({ data: "raro" })));
    expect(await recorrerLaWabaOFalla(WABA, "id", "fake-access-token")).toEqual({ ok: false, falla: "meta", codigo: null });
  });

  it("recorrerLaWaba sigue dando null con cualquiera de ellas", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => error(100, 400)));
    expect(await recorrerLaWaba(WABA, "id", "fake-access-token")).toBeNull();
  });
});

describe("estaEnLaWaba", () => {
  it("true si el id figura entre los números de la WABA que se pasa, con el token que se pasa", async () => {
    const fetchFalso = vi.fn(async () => respuesta({ data: [{ id: "100000000000001" }, { id: ID }] }));
    vi.stubGlobal("fetch", fetchFalso);

    expect(await estaEnLaWaba("200000000000009", ID, "fake-client-token")).toBe(true);

    const [url, init] = fetchFalso.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://graph.facebook.com/v22.0/200000000000009/phone_numbers?fields=id&limit=100");
    expect(init.headers).toEqual({ Authorization: "Bearer fake-client-token" });
  });

  it("false si no figura, y sigue las páginas antes de decirlo", async () => {
    const pedidos: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        pedidos.push(url);
        return url.includes("after=PAG2")
          ? respuesta({ data: [{ id: "100000000000003" }] })
          : respuesta({ data: [{ id: "100000000000001" }], paging: { cursors: { after: "PAG2" }, next: "https://graph.example.com/x" } });
      })
    );

    expect(await estaEnLaWaba(WABA, ID, "fake-client-token")).toBe(false);
    expect(pedidos).toHaveLength(2);
  });

  it("null si Meta no contestó: ni un sí ni un no", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respuesta({}, 500)));
    expect(await estaEnLaWaba(WABA, ID, "fake-client-token")).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("red caída"); }));
    expect(await estaEnLaWaba(WABA, ID, "fake-client-token")).toBeNull();
  });
});

describe("el appsecret_proof de la app propia (R5)", () => {
  const PRUEBA = "c".repeat(64);

  it("recorrerLaWaba sin prueba pide la URL de siempre, con y sin cursor", async () => {
    const pedidos: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        pedidos.push(url);
        return url.includes("after=PAG2")
          ? respuesta({ data: [{ id: "2" }] })
          : respuesta({ data: [{ id: "1" }], paging: { cursors: { after: "PAG2" }, next: "https://graph.example.com/x" } });
      })
    );

    await recorrerLaWaba(WABA, "id", "fake-client-token");

    expect(pedidos).toEqual([
      `https://graph.facebook.com/v22.0/${WABA}/phone_numbers?fields=id&limit=100`,
      `https://graph.facebook.com/v22.0/${WABA}/phone_numbers?fields=id&limit=100&after=PAG2`,
    ]);
  });

  it("recorrerLaWaba con prueba la suma al final de la consulta de cada página, tras el cursor", async () => {
    const pedidos: string[] = [];
    const fetchFalso = vi.fn(async (url: string) => {
      pedidos.push(url);
      return url.includes("after=PAG2")
        ? respuesta({ data: [{ id: "2" }] })
        : respuesta({ data: [{ id: "1" }], paging: { cursors: { after: "PAG2" }, next: "https://graph.example.com/x" } });
    });
    vi.stubGlobal("fetch", fetchFalso);

    const r = await recorrerLaWaba(WABA, "id", "fake-client-token", undefined, PRUEBA);

    expect(r?.filas.map((f) => f.id)).toEqual(["1", "2"]);
    expect(pedidos).toEqual([
      `https://graph.facebook.com/v22.0/${WABA}/phone_numbers?fields=id&limit=100&appsecret_proof=${PRUEBA}`,
      `https://graph.facebook.com/v22.0/${WABA}/phone_numbers?fields=id&limit=100&after=PAG2&appsecret_proof=${PRUEBA}`,
    ]);
    for (const [url, init] of fetchFalso.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(url).not.toContain("fake-client-token");
      expect(init.headers).toEqual({ Authorization: "Bearer fake-client-token" });
    }
  });

  it("la prueba no cambia lo que se hace con las filas: parar corta igual", async () => {
    const fetchFalso = vi.fn(async () =>
      respuesta({ data: [{ id: "1" }, { id: ID }, { id: "3" }], paging: { cursors: { after: "PAG2" }, next: "https://graph.example.com/x" } })
    );
    vi.stubGlobal("fetch", fetchFalso);

    const r = await recorrerLaWaba(WABA, "id", "fake-client-token", (f) => f.id === ID, PRUEBA);

    expect(r).toEqual({
      filas: [
        { id: "1", display: null, nombre: null },
        { id: ID, display: null, nombre: null },
      ],
      completa: true,
    });
    expect(fetchFalso).toHaveBeenCalledTimes(1);
  });

  it("estaEnLaWaba con prueba la manda en cada página y decide igual", async () => {
    const pedidos: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        pedidos.push(url);
        return url.includes("after=PAG2")
          ? respuesta({ data: [{ id: ID }] })
          : respuesta({ data: [{ id: "100000000000001" }], paging: { cursors: { after: "PAG2" }, next: "https://graph.example.com/x" } });
      })
    );

    expect(await estaEnLaWaba(WABA, ID, "fake-client-token", PRUEBA)).toBe(true);
    expect(pedidos).toHaveLength(2);
    for (const url of pedidos) expect(new URL(url).searchParams.get("appsecret_proof")).toBe(PRUEBA);
  });

  it("estaEnLaWaba sin prueba no manda appsecret_proof", async () => {
    const fetchFalso = vi.fn(async (_url: string) => respuesta({ data: [{ id: ID }] }));
    vi.stubGlobal("fetch", fetchFalso);

    await estaEnLaWaba(WABA, ID, "fake-client-token");

    expect(fetchFalso.mock.calls[0]?.[0]).not.toContain("appsecret_proof");
  });

  it("verificarEnMeta, la conexión del operador sobre la WABA de la plataforma, nunca manda prueba", async () => {
    const fetchFalso = vi.fn(async (url: string) =>
      url.includes("/phone_numbers") ? respuesta({ data: [{ id: ID }] }) : respuesta({ display_phone_number: NUMERO, verified_name: "Seguros Fake" })
    );
    vi.stubGlobal("fetch", fetchFalso);

    await verificarEnMeta(PEDIDO);

    for (const [url] of fetchFalso.mock.calls as unknown as Array<[string]>) expect(url).not.toContain("appsecret_proof");
  });

  it("un fallo de Graph con la prueba puesta sigue siendo null, sin tirar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respuesta({}, 500)));
    expect(await recorrerLaWaba(WABA, "id", "fake-client-token", undefined, PRUEBA)).toBeNull();
    expect(await estaEnLaWaba(WABA, ID, "fake-client-token", PRUEBA)).toBeNull();
  });
});
