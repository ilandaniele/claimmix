/**
 * Lo que comparten los tres clientes de Graph: la forma de la ruta. Nada que llegue
 * como ruta puede cambiar el host, salir de la versión ni colar otro camino.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { logger } from "@/lib/observability/logger";
import { clienteDeGraph, rutaDeGraph, SIN_PEDIDO, type Pedido } from "@/server/whatsapp/graph";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rutaDeGraph", () => {
  it.each([
    "debug_token",
    "oauth/access_token",
    "200000000000002/subscribed_apps",
    "100000000000777?fields=display_phone_number,verified_name",
    "100000000000777/whatsapp_business_profile?fields=description,email,vertical",
    "debug_token?input_token=fake-client-token.0123_456",
    "200000000000002?fields=health_status&appsecret_proof=0a1b",
  ])("deja pasar %s tal cual", (ruta) => {
    expect(rutaDeGraph(ruta)).toBe(ruta);
  });

  it.each([
    "",
    "/",
    "/200000000000002",
    "200000000000002/",
    "//evil.example/200000000000002",
    "https://evil.example/200000000000002",
    "../../v1/200000000000002",
    "200000000000002/../otra",
    "200000000000002@evil.example",
    "200000000000002#x",
    "200000000000002?fields=a#x",
    "200000000000002?fields=a?b",
    "200000000000002?fields=a/b",
    "200000000000002/subscribed_apps/mas",
    "2000000 00000002",
    "200000000000002?fields=a b",
    "200000000000002%2F..",
  ])("rechaza %j", (ruta) => {
    expect(rutaDeGraph(ruta)).toBeNull();
  });
});

describe("clienteDeGraph", () => {
  it("con una ruta sin forma de Graph no llama a fetch: es un pedido que ni salió", async () => {
    const fetchFalso = vi.fn();
    vi.stubGlobal("fetch", fetchFalso);
    const { llamar } = clienteDeGraph<"paso">("test.graph");
    await expect(llamar("paso", "200000000000002/../otra", { autorizacion: "Bearer fake-token" })).resolves.toEqual({
      ok: false,
      falla: SIN_PEDIDO,
    });
    expect(fetchFalso).not.toHaveBeenCalled();
  });
});

describe("lo que se anota de una falla", () => {
  const PRUEBA = "b".repeat(64);
  const RUTA = "100000000000777/request_code";
  const T = "[tachado]";

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  /** Graph contesta 400 con `error`; devuelve lo que llamar() contestó y deja lo anotado en `warn`. */
  async function fallaConError(error: unknown, pedido: Pedido = {}, opciones: { recortes?: boolean } = { recortes: true }, ruta = RUTA) {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error }) }) as Response));
    return clienteDeGraph<"paso">("test.graph", opciones).llamar("paso", ruta, pedido);
  }

  const anotado = () => warn.mock.calls.at(-1)?.[0] as Record<string, unknown>;
  const mensaje = () => anotado().mensaje;

  it("con recortes queda paso, status, code y el mensaje; con subcódigo, también el subcódigo", async () => {
    await fallaConError({ message: "algo pasó", code: 100 });
    expect(warn).toHaveBeenLastCalledWith({ paso: "paso", status: 400, codigo: 100, mensaje: "algo pasó" }, "test.graph");

    await fallaConError({ message: "algo pasó", code: 100, error_subcode: 7 });
    expect(warn).toHaveBeenLastCalledWith({ paso: "paso", status: 400, codigo: 100, subcodigo: 7, mensaje: "algo pasó" }, "test.graph");
  });

  it("sin recortes el texto de Meta no se anota, pero el subcódigo sí", async () => {
    await fallaConError({ message: "texto de Meta", error_user_msg: "otro texto", error_data: { details: "más texto" }, code: 100, error_subcode: 7 }, {}, {});

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith({ paso: "paso", status: 400, codigo: 100, subcodigo: 7 }, "test.graph");
  });

  it("la Falla que vuelve es la misma con y sin recortes", async () => {
    const error = { message: "texto", code: 136024, error_subcode: 9 };
    const con = await fallaConError(error, {}, { recortes: true });
    const sin = await fallaConError(error, {}, {});

    expect(con).toEqual(sin);
    expect(con).toEqual({ ok: false, falla: { ok: false, falla: "esperar", codigo: 136024, subcodigo: 9 } });
  });

  describe("tachado por valor", () => {
    it("el token sin «Bearer» y cada pieza de «id|secreto»", async () => {
      await fallaConError(
        { message: "token fake-app-id|fake-app-secret, id fake-app-id, secreto fake-app-secret", code: 190 },
        { autorizacion: "Bearer fake-app-id|fake-app-secret" }
      );
      expect(mensaje()).toBe(`token ${T}, id ${T}, secreto ${T}`);
    });

    it("la prueba, en el cuerpo del POST y en la consulta del GET", async () => {
      await fallaConError({ message: `prueba ${PRUEBA} inválida`, code: 190 }, { json: { pin: "fake-pin-1" }, prueba: PRUEBA });
      expect(mensaje()).toBe(`prueba ${T} inválida`);

      await fallaConError({ message: "prueba fake-proof-xyz inválida", code: 190 }, { metodo: "GET", prueba: "fake-proof-xyz" });
      expect(mensaje()).toBe(`prueba ${T} inválida`);
    });

    it("las hojas de texto de json anidado y del formulario", async () => {
      await fallaConError(
        { message: "verify_token fake-verify-token mal", code: 100 },
        { json: { webhook_configuration: { verify_token: "fake-verify-token" } } }
      );
      expect(mensaje()).toBe(`verify_token ${T} mal`);

      await fallaConError({ message: "numero fake-phone-1234 ya", code: 100 }, { formulario: { phone_number: "fake-phone-1234" } });
      expect(mensaje()).toBe(`numero ${T} ya`);
    });

    it("el nodo de la ruta y los valores de la consulta, menos `fields`", async () => {
      await fallaConError({ message: "no existe nodo12", code: 100 }, {}, { recortes: true }, "nodo12/register");
      expect(mensaje()).toBe(`no existe ${T}`);

      await fallaConError({ message: "token fake-tok1 y campo name", code: 100 }, {}, { recortes: true }, "nodo12?fields=name&input_token=fake-tok1");
      expect(mensaje()).toBe(`token ${T} y campo name`);
    });

    it("los valores fijos del pedido y los de menos de 4 caracteres no rompen el mensaje", async () => {
      await fallaConError(
        { message: "whatsapp SMS es_AR es 12", code: 100 },
        { json: { messaging_product: "whatsapp", code_method: "SMS", language: "es_AR", pin: "12", x: "es" } }
      );
      expect(mensaje()).toBe("whatsapp SMS es_AR es 12");
    });

    it("el más largo primero: un secreto no deja la cola de otro", async () => {
      await fallaConError({ message: "clave fake-secret-largo", code: 100 }, { json: { a: "fake-secret", b: "fake-secret-largo" } });
      expect(mensaje()).toBe(`clave ${T}`);
    });
  });

  describe("tachado por forma", () => {
    it("mail, teléfono, racha de dígitos, EAA y tira larga; una palabra común queda a la vista", async () => {
      await fallaConError({
        message: `mail ana@example.com, tel +54 9 11 0000-0000, código 123456, token EAAB1234567890abc, clave ${"a".repeat(40)}, palabra normal`,
        code: 100,
      });
      expect(mensaje()).toBe(`mail ${T}, tel ${T}, código ${T}, token ${T}, clave ${T}, palabra normal`);
    });
  });

  describe("el corte", () => {
    it("un secreto que cruza el carácter 160 no deja ningún pedazo", async () => {
      await fallaConError({ message: `${"a ".repeat(75)}fake-secret-value-123`, code: 100 }, { json: { pin: "fake-secret-value-123" } });
      expect(mensaje()).toBe(`${"a ".repeat(75)}${T}`);
      expect(JSON.stringify(anotado())).not.toContain("fake");
    });

    it("160 puntos de código como mucho, aunque haya un emoji en el borde", async () => {
      await fallaConError({ message: "😀".repeat(200), code: 100 });
      const m = mensaje() as string;
      expect(Array.from(m)).toHaveLength(160);
      expect(m).toBe("😀".repeat(160));
    });

    it("un campo de más de 2000 caracteres no se anota", async () => {
      await fallaConError({ message: "a".repeat(2001), error_user_msg: "corto", code: 100 });
      expect(anotado()).toEqual({ paso: "paso", status: 400, codigo: 100, mensaje_usuario: "corto" });
    });
  });

  describe("campos", () => {
    it("mensaje_usuario y detalles salen con su nombre", async () => {
      await fallaConError({ message: "uno", error_user_msg: "dos", error_data: { details: "tres" }, code: 100 });
      expect(anotado()).toEqual({ paso: "paso", status: 400, codigo: 100, mensaje: "uno", mensaje_usuario: "dos", detalles: "tres" });
    });

    it("error_data como texto no da detalles", async () => {
      await fallaConError({ message: "uno", error_data: "tres", code: 100 });
      expect(anotado()).not.toHaveProperty("detalles");
    });

    it("un campo vacío o que no es texto no deja clave", async () => {
      await fallaConError({ message: "  ", error_user_msg: 5, error_data: { details: {} }, code: 100 });
      expect(anotado()).toEqual({ paso: "paso", status: 400, codigo: 100 });
    });

    it("un cuerpo sin `error` no deja recortes", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ message: "x" }) }) as Response));
      await clienteDeGraph<"paso">("test.graph", { recortes: true }).llamar("paso", RUTA, {});
      expect(warn).toHaveBeenLastCalledWith({ paso: "paso", status: 500, codigo: null }, "test.graph");
    });
  });

  describe("lo que no es un error de Meta con texto", () => {
    it("respuestaRara, rechazada y la falla de red se anotan sin recortes ni subcódigo", async () => {
      const cliente = clienteDeGraph<"paso">("test.graph", { recortes: true });

      cliente.respuestaRara("paso");
      expect(warn).toHaveBeenLastCalledWith({ paso: "paso", status: 200, codigo: null }, "test.graph");

      cliente.rechazada("paso", 5);
      expect(warn).toHaveBeenLastCalledWith({ paso: "paso", status: 200, codigo: 5 }, "test.graph");

      vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET"); }));
      await cliente.llamar("paso", RUTA, {});
      expect(warn).toHaveBeenLastCalledWith({ paso: "paso", status: null, codigo: null }, "test.graph");
    });
  });
});
