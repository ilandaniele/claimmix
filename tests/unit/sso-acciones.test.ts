/**
 * Las acciones del panel de SSO (B19) y cómo traducen lo que contesta la API a
 * uno de los resultados de la lista cerrada que la página sabe pintar.
 *
 * Las acciones no validan ni deciden nada: arman un pedido para /api/admin/sso y
 * le hacen caso a la respuesta. Lo que se afirma acá es lo que mandan, que el
 * formulario no pueda colar un campo que la API no espera, y adónde redirigen.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { PUT, POST, PATCH, urlDelSso, loggerError } = vi.hoisted(() => ({
  PUT: vi.fn(),
  POST: vi.fn(),
  PATCH: vi.fn(),
  urlDelSso: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("@/app/api/admin/sso/route", () => ({ PUT, POST, PATCH }));
vi.mock("@/server/sso/ingreso", () => ({ urlDelSso }));
vi.mock("@/lib/observability/logger", () => ({ logger: { error: loggerError, warn: vi.fn(), info: vi.fn() } }));

import {
  cambiarSso,
  guardarSso,
  probarSso,
  verificarSso,
} from "@/app/(app)/configuracion/sso-actions";
import {
  esExito,
  esResultadoSso,
  RESULTADOS_SSO,
  resultadoDeLaVerificacion,
  resultadoDeRechazo,
  type ResultadoSso,
} from "@/app/(app)/configuracion/sso-resultados";

const formulario = (campos: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(campos)) form.set(k, v);
  return form;
};

/** A dónde redirigió la acción: las acciones siempre terminan en un redirect(). */
async function destino(accion: Promise<void>): Promise<string> {
  try {
    await accion;
  } catch (e) {
    const mensaje = e instanceof Error ? e.message : "";
    if (mensaje.startsWith("REDIRECT:")) return mensaje.slice("REDIRECT:".length);
    throw e;
  }
  throw new Error("la acción no redirigió");
}

const ok = (cuerpo: object = { ok: true }) => Response.json(cuerpo, { status: 200 });
const rechazo = (code: string, motivo?: string, status = 400) =>
  Response.json({ error: { code, message: "x", ...(motivo ? { details: { motivo } } : {}) } }, { status });

/** El cuerpo JSON con el que se llamó al manejador. */
async function cuerpoEnviado(manejador: ReturnType<typeof vi.fn>): Promise<Record<string, unknown>> {
  const pedido = manejador.mock.calls[0]![0] as Request;
  return pedido.json();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("guardarSso", () => {
  const campos = { issuer: "https://idp.empresa.com", client_id: "cliente-1", dominio: "empresa.com", client_secret: "s3creto" };

  it("manda un PUT a la API con los cuatro datos, y vuelve con «guardado»", async () => {
    PUT.mockResolvedValue(ok());

    await expect(destino(guardarSso(formulario(campos)))).resolves.toBe("/configuracion?sso=guardado");

    const pedido = PUT.mock.calls[0]![0] as Request;
    expect(pedido.method).toBe("PUT");
    expect(new URL(pedido.url).pathname).toBe("/api/admin/sso");
    expect(pedido.headers.get("content-type")).toBe("application/json");
    expect(await cuerpoEnviado(PUT)).toEqual({
      issuer: "https://idp.empresa.com",
      client_id: "cliente-1",
      dominio: "empresa.com",
      client_secret: "s3creto",
    });
  });

  it("con el secreto vacío no lo manda: la API lo interpreta como «conservar el guardado»", async () => {
    PUT.mockResolvedValue(ok());

    await destino(guardarSso(formulario({ ...campos, client_secret: "   " })));

    const cuerpo = await cuerpoEnviado(PUT);
    expect(cuerpo).not.toHaveProperty("client_secret");
  });

  it("recorta los espacios de lo que escribió la persona", async () => {
    PUT.mockResolvedValue(ok());

    await destino(guardarSso(formulario({ ...campos, dominio: "  empresa.com ", issuer: " https://idp.empresa.com  " })));

    expect(await cuerpoEnviado(PUT)).toMatchObject({ dominio: "empresa.com", issuer: "https://idp.empresa.com" });
  });

  it("no hay manera de colar otros campos: lo que no es de los cuatro se descarta", async () => {
    PUT.mockResolvedValue(ok());

    await destino(
      guardarSso(formulario({ ...campos, tenant_id: "10000000-0000-0000-0000-000000000002", activo: "1", exigir: "1" }))
    );

    expect(Object.keys(await cuerpoEnviado(PUT)).sort()).toEqual(["client_id", "client_secret", "dominio", "issuer"]);
  });

  it("un rechazo de la API se traduce al resultado que le toca", async () => {
    PUT.mockResolvedValue(rechazo("VALIDATION_ERROR", "dominio_publico"));
    await expect(destino(guardarSso(formulario(campos)))).resolves.toBe("/configuracion?sso=dominioPublico");

    PUT.mockResolvedValue(rechazo("RATE_LIMITED"));
    await expect(destino(guardarSso(formulario(campos)))).resolves.toBe("/configuracion?sso=limite");
  });
});

describe("verificarSso", () => {
  it("manda un POST con la acción «verificar» y nada más", async () => {
    POST.mockResolvedValue(ok({ verificado: true }));

    await expect(destino(verificarSso())).resolves.toBe("/configuracion?sso=verificado");

    expect((POST.mock.calls[0]![0] as Request).method).toBe("POST");
    expect(await cuerpoEnviado(POST)).toEqual({ accion: "verificar" });
  });

  it.each([
    ["sin_registro", "dnsSinRegistro"],
    ["sin_respuesta", "dnsSinRespuesta"],
    ["no_coincide", "dnsNoCoincide"],
  ])("el DNS dijo «%s»: vuelve con «%s»", async (motivo, resultado) => {
    POST.mockResolvedValue(ok({ verificado: false, motivo }));

    await expect(destino(verificarSso())).resolves.toBe(`/configuracion?sso=${resultado}`);
  });

  it("un rechazo de la API (dominio en uso, por ejemplo) no se confunde con la respuesta del DNS", async () => {
    POST.mockResolvedValue(rechazo("CONFLICT", "dominio_en_uso", 409));

    await expect(destino(verificarSso())).resolves.toBe("/configuracion?sso=dominioEnUso");
  });
});

describe("cambiarSso", () => {
  it.each([
    ["activo", "1", { activo: true }, "activado"],
    ["activo", "0", { activo: false }, "apagado"],
    ["exigir", "0", { exigir: false }, "noExigido"],
  ])("%s=%s manda %j y vuelve con «%s»", async (campo, valor, cuerpo, resultado) => {
    PATCH.mockResolvedValue(ok({ sesiones_cerradas: 0 }));

    await expect(destino(cambiarSso(formulario({ campo, valor })))).resolves.toBe(`/configuracion?sso=${resultado}`);

    expect((PATCH.mock.calls[0]![0] as Request).method).toBe("PATCH");
    expect(await cuerpoEnviado(PATCH)).toEqual(cuerpo);
  });

  it("exigir con las sesiones cerradas vuelve con «exigido»", async () => {
    PATCH.mockResolvedValue(ok({ sesiones_cerradas: 4 }));

    await expect(destino(cambiarSso(formulario({ campo: "exigir", valor: "1" })))).resolves.toBe("/configuracion?sso=exigido");
    expect(await cuerpoEnviado(PATCH)).toEqual({ exigir: true });
  });

  it("exigir cuando no se pudieron cerrar las sesiones avisa que falta ese paso", async () => {
    PATCH.mockResolvedValue(ok({ sesiones_cerradas: null }));

    await expect(destino(cambiarSso(formulario({ campo: "exigir", valor: "1" })))).resolves.toBe(
      "/configuracion?sso=exigidoSinCerrar"
    );
  });

  it("sólo «activo» y «exigir» son campos: cualquier otro se rechaza sin llamar a la API", async () => {
    for (const campo of ["tenant_id", "issuer", "dominio_verificado_en", "", "__proto__"]) {
      await expect(destino(cambiarSso(formulario({ campo, valor: "1" })))).resolves.toBe("/configuracion?sso=fallo");
    }
    await expect(destino(cambiarSso(formulario({ valor: "1" })))).resolves.toBe("/configuracion?sso=fallo");
    expect(PATCH).not.toHaveBeenCalled();
  });

  it("todo valor que no sea «1» es falso: nunca se enciende por accidente", async () => {
    PATCH.mockResolvedValue(ok());

    for (const valor of ["", "true", "si", "2", "0"]) {
      PATCH.mockClear();
      await destino(cambiarSso(formulario({ campo: "activo", valor })));
      expect(await cuerpoEnviado(PATCH)).toEqual({ activo: false });
    }
  });

  it("un rechazo de la API se traduce, y no se cuenta como éxito", async () => {
    PATCH.mockResolvedValue(rechazo("VALIDATION_ERROR", "sso_sin_prueba", 409));
    await expect(destino(cambiarSso(formulario({ campo: "exigir", valor: "1" })))).resolves.toBe(
      "/configuracion?sso=ssoSinPrueba"
    );

    PATCH.mockResolvedValue(rechazo("VALIDATION_ERROR", "sso_incompleto", 409));
    await expect(destino(cambiarSso(formulario({ campo: "activo", valor: "1" })))).resolves.toBe(
      "/configuracion?sso=ssoIncompleto"
    );
  });
});

describe("probarSso", () => {
  it("con la dirección del IdP, redirige ahí, y deja los retornos en el panel", async () => {
    urlDelSso.mockResolvedValue("https://idp.empresa.com/authorize?x=1");

    await expect(destino(probarSso(formulario({ email: " ana@empresa.com " })))).resolves.toBe(
      "https://idp.empresa.com/authorize?x=1"
    );
    expect(urlDelSso).toHaveBeenCalledWith("ana@empresa.com", "/configuracion?sso=probado", "/configuracion?sso=pruebaFallo");
  });

  it("sin dirección —dominio sin SSO, IdP caído, tope— vuelve con «pruebaFallo»", async () => {
    urlDelSso.mockResolvedValue(null);

    await expect(destino(probarSso(formulario({ email: "ana@empresa.com" })))).resolves.toBe("/configuracion?sso=pruebaFallo");
  });

  it("sin correo no llega a ningún lado: lo resuelve `urlDelSso`, que devuelve null", async () => {
    urlDelSso.mockResolvedValue(null);

    await expect(destino(probarSso(formulario({})))).resolves.toBe("/configuracion?sso=pruebaFallo");
    expect(urlDelSso).toHaveBeenCalledWith("", expect.any(String), expect.any(String));
  });
});

describe("un fallo inesperado", () => {
  it("que tire el manejador vuelve con «fallo», deja el rastro y no filtra el mensaje", async () => {
    PUT.mockRejectedValue(new Error("connection string postgres://secreto@host"));

    const url = await destino(guardarSso(formulario({ issuer: "https://i.com", client_id: "a", dominio: "e.com" })));

    expect(url).toBe("/configuracion?sso=fallo");
    expect(loggerError).toHaveBeenCalledWith(expect.objectContaining({ detalle: expect.any(String) }), "configuracion.sso_accion_fallo");
    expect(url).not.toContain("secreto");
  });

  it("una respuesta que no es JSON también da «fallo»", async () => {
    POST.mockResolvedValue(new Response("<html>502</html>", { status: 502 }));

    await expect(destino(verificarSso())).resolves.toBe("/configuracion?sso=fallo");
  });

  it("un éxito con el cuerpo ilegible en «verificar» no se da por verificado", async () => {
    POST.mockResolvedValue(new Response("no es json", { status: 200 }));

    await expect(destino(verificarSso())).resolves.toBe("/configuracion?sso=fallo");
  });
});

describe("resultadoDeRechazo", () => {
  const conCodigo = (code: string, motivo?: string) => ({ error: { code, details: motivo ? { motivo } : undefined } });

  it("el código de error va primero: el tope y la migración no dependen del motivo", () => {
    expect(resultadoDeRechazo(conCodigo("RATE_LIMITED", "issuer_invalido"))).toBe("limite");
    expect(resultadoDeRechazo(conCodigo("MIGRACION_PENDIENTE"))).toBe("migracion");
  });

  it.each([
    ["issuer_invalido", "idpIssuer"],
    ["issuer_no_coincide", "idpIssuer"],
    ["endpoint_rechazado", "idpIssuer"],
    ["sin_respuesta", "idpRespuesta"],
    ["documento_ilegible", "idpRespuesta"],
    ["dominio_invalido", "dominioInvalido"],
    ["dominio_publico", "dominioPublico"],
    ["dominio_en_uso", "dominioEnUso"],
    ["sso_incompleto", "ssoIncompleto"],
    ["sso_sin_prueba", "ssoSinPrueba"],
  ])("el motivo «%s» da «%s»", (motivo, resultado) => {
    expect(resultadoDeRechazo(conCodigo("VALIDATION_ERROR", motivo))).toBe(resultado);
  });

  it("cualquier otro campo que no pasó el esquema da «datosInvalidos»", () => {
    for (const motivo of ["client_id_invalido", "client_secret_invalido", "cuerpo_invalido"]) {
      expect(resultadoDeRechazo(conCodigo("VALIDATION_ERROR", motivo))).toBe("datosInvalidos");
    }
  });

  it("lo que no se reconoce da «fallo», sin romper con cuerpos raros", () => {
    for (const cuerpo of [null, undefined, "texto", 42, {}, { error: null }, { error: { code: 7, details: { motivo: {} } } }]) {
      expect(resultadoDeRechazo(cuerpo)).toBe("fallo");
    }
    expect(resultadoDeRechazo(conCodigo("INTERNAL", "motivo_inventado"))).toBe("fallo");
  });

  it("no hay manera de que devuelva algo fuera de la lista cerrada", () => {
    const motivos = ["x", "__proto__", "constructor", "toString", "issuer_invalido", "a_invalido"];
    for (const motivo of motivos) {
      expect(esResultadoSso(resultadoDeRechazo(conCodigo("VALIDATION_ERROR", motivo)))).toBe(true);
    }
  });
});

describe("resultadoDeLaVerificacion", () => {
  it("verificado es verificado; los motivos del DNS tienen su resultado", () => {
    expect(resultadoDeLaVerificacion({ verificado: true })).toBe("verificado");
    expect(resultadoDeLaVerificacion({ verificado: false, motivo: "sin_registro" })).toBe("dnsSinRegistro");
    expect(resultadoDeLaVerificacion({ verificado: false, motivo: "sin_respuesta" })).toBe("dnsSinRespuesta");
    expect(resultadoDeLaVerificacion({ verificado: false, motivo: "no_coincide" })).toBe("dnsNoCoincide");
  });

  it("lo demás es «fallo»: nunca se da por verificado con un cuerpo dudoso", () => {
    for (const cuerpo of [null, undefined, {}, { verificado: "true" }, { verificado: 1 }, { verificado: false }, { verificado: false, motivo: "otro" }]) {
      expect(resultadoDeLaVerificacion(cuerpo)).toBe("fallo");
    }
  });
});

describe("la lista cerrada de resultados", () => {
  it("esResultadoSso sólo acepta nombres de la lista", () => {
    for (const r of RESULTADOS_SSO) expect(esResultadoSso(r)).toBe(true);
    for (const x of ["", "GUARDADO", "<script>", "__proto__", "constructor", null, undefined, 1, ["guardado"], { r: "guardado" }]) {
      expect(esResultadoSso(x)).toBe(false);
    }
  });

  it("los éxitos son siete, y lo que pide una acción del admin no cuenta como éxito", () => {
    const exitos = (RESULTADOS_SSO as readonly ResultadoSso[]).filter(esExito);
    expect(exitos.sort()).toEqual(["activado", "apagado", "exigido", "guardado", "noExigido", "probado", "verificado"]);
    expect(esExito("exigidoSinCerrar")).toBe(false);
    expect(esExito("pruebaFallo")).toBe(false);
  });

  it("no hay nombres repetidos", () => {
    expect(new Set(RESULTADOS_SSO).size).toBe(RESULTADOS_SSO.length);
  });
});
