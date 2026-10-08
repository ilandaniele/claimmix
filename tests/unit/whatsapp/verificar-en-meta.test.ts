/**
 * Lo que se le pregunta a Meta antes de conectar un número, y cómo se lee lo que
 * contesta. El resto de la historia (qué se escribe después) está en
 * `tests/unit/alta/panel-operador.test.ts`; acá sólo el cuidado con Graph.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { verificarEnMeta } from "@/server/whatsapp/verificar-en-meta";

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
