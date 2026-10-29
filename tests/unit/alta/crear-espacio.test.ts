/**
 * `crearEspacio`: lo que se hace al pedir el espacio de quien ya tiene cuenta, sin
 * pasar por la acción. Se prueba suelto porque es lo que comparten la acción de
 * /alta y el ensayo del alta: el orden de los cupos, qué se libera y qué se
 * devuelve. No redirige, no usa cookies ni `after()`: eso queda en la acción
 * (ver `acciones-de-alta-sin-reexportar.test.ts`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  crearInquilino: vi.fn(),
  tomarCupo: vi.fn(),
  soltarCupo: vi.fn(),
  iniciarBase: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  /** Para probar que no se toma ningún cupo antes de tiempo. */
  orden: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: h.error },
}));
vi.mock("@/server/alta/crear-inquilino", () => ({ crearInquilino: h.crearInquilino }));
vi.mock("@/server/alta/cupo-por-ip", () => ({ tomarCupoDeAlta: h.tomarCupo, soltarCupoDeAlta: h.soltarCupo }));
vi.mock("@/server/bases/iniciar", () => ({ iniciarBase: h.iniciarBase }));

import { conError, crearEspacio, SIN_ESPACIO } from "@/server/alta/crear-espacio";
import { PRIMEROS_PASOS } from "@/server/alta/pasos-hechos";

const USUARIO = "11111111-1111-4111-8111-111111111111";
const TENANT = "aaaaaaaa-0000-4000-8000-00000000000a";
const IP = "203.0.113.7";
const CLAVE = "alta:ip:203.0.113.0";
const VENTANA = 1_700_000_000_000;

const ALTA = { resultado: "ok" as const, tenantId: TENANT, creadas24h: 3, tope: 20 };

const buenos = (extra: Record<string, unknown> = {}) => ({
  userId: USUARIO,
  empresa: "  Seguros del Sur  ",
  whatsapp: "+54 9 (291) 642-6930",
  terminos: true,
  numeroAutomatico: false,
  ip: IP,
  ...extra,
});

const cupo = (extra: Record<string, unknown> = {}) => ({
  clave: CLAVE,
  cupo: { allowed: true, remaining: 2, resetAt: VENTANA + 1, retryAfterSeconds: 0, ventana: VENTANA, ...extra },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.orden.length = 0;
  delete process.env.BASE_POR_CLIENTE;
  h.tomarCupo.mockImplementation(async () => {
    h.orden.push("cupo");
    return cupo();
  });
  h.crearInquilino.mockImplementation(async () => {
    h.orden.push("base");
    return ALTA;
  });
  h.soltarCupo.mockResolvedValue(undefined);
  h.iniciarBase.mockResolvedValue(undefined);
});

describe("crearEspacio: lo que se mira antes de gastar un cupo", () => {
  it.each([
    ["una empresa de un solo carácter", { empresa: "A" }],
    ["una empresa que no es texto", { empresa: 42 }],
    ["un WhatsApp sin prefijo de país", { whatsapp: "291 642 6930" }],
    ["un WhatsApp que no es texto", { whatsapp: null }],
    ["los términos sin tildar", { terminos: false }],
  ])("%s: va a «datos» y no toca el contador ni la base", async (_caso, campos) => {
    expect(await crearEspacio(buenos(campos))).toEqual({ destino: "/alta?e=datos" });

    expect(h.tomarCupo).not.toHaveBeenCalled();
    expect(h.crearInquilino).not.toHaveBeenCalled();
    expect(h.soltarCupo).not.toHaveBeenCalled();
  });

  it("con el número por código, un +54 de diez dígitos sin el 9 va a «celular», también antes del cupo", async () => {
    expect(await crearEspacio(buenos({ numeroAutomatico: true, whatsapp: "+54 11 0000 0000" }))).toEqual({
      destino: "/alta?e=celular",
    });

    expect(h.tomarCupo).not.toHaveBeenCalled();
    expect(h.crearInquilino).not.toHaveBeenCalled();
  });

  it("sin el número por código, el mismo número se acepta como siempre", async () => {
    const r = await crearEspacio(buenos({ numeroAutomatico: false, whatsapp: "+54 11 0000 0000" }));

    expect(r.destino).toBe(PRIMEROS_PASOS);
    expect(h.crearInquilino).toHaveBeenCalledWith(expect.objectContaining({ numero: "+541100000000" }));
  });
});

describe("crearEspacio: el cupo por IP", () => {
  it("toma el cupo con la IP, y recién después llama a la base", async () => {
    await crearEspacio(buenos());

    expect(h.tomarCupo).toHaveBeenCalledWith(IP);
    expect(h.orden).toEqual(["cupo", "base"]);
  });

  it("sin cupo va a «intentos», sin llamar a la base ni liberar lo que no se tomó", async () => {
    h.tomarCupo.mockResolvedValue(cupo({ allowed: false, retryAfterSeconds: 3600 }));

    expect(await crearEspacio(buenos())).toEqual({ destino: "/alta?e=intentos" });

    expect(h.crearInquilino).not.toHaveBeenCalled();
    expect(h.soltarCupo).not.toHaveBeenCalled();
  });

  it("`ventana: 0` es que el contador no contestó: «falla», no «intentos»", async () => {
    h.tomarCupo.mockResolvedValue(cupo({ allowed: false, ventana: 0 }));

    expect(await crearEspacio(buenos())).toEqual({ destino: "/alta?e=falla" });
    expect(h.crearInquilino).not.toHaveBeenCalled();
  });

  it("si el contador tira, tira: la acción no confunde la falla con un espacio creado", async () => {
    h.tomarCupo.mockRejectedValue(new Error("contador caído"));

    await expect(crearEspacio(buenos())).rejects.toThrow("contador caído");
    expect(h.crearInquilino).not.toHaveBeenCalled();
  });
});

describe("crearEspacio: la función de la base", () => {
  it("le pasa el usuario, la empresa limpia, el E.164 y la IP", async () => {
    await crearEspacio(buenos());

    expect(h.crearInquilino).toHaveBeenCalledWith({
      userId: USUARIO,
      empresa: "Seguros del Sur",
      numero: "+5492916426930",
      ip: IP,
    });
  });

  it("una IP que no es una IP llega como null a la base, pero el cupo se toma igual", async () => {
    await crearEspacio(buenos({ ip: "desconocida" }));

    expect(h.tomarCupo).toHaveBeenCalledWith("desconocida");
    expect(h.crearInquilino).toHaveBeenCalledWith(expect.objectContaining({ ip: null }));
  });

  it("si la base tira, va a «falla», anota sólo el nombre del error y suelta lo que tomó", async () => {
    h.crearInquilino.mockRejectedValue(Object.assign(new Error("Failed query: ana@example.com"), { name: "NeonDbError" }));

    expect(await crearEspacio(buenos())).toEqual({ destino: "/alta?e=falla" });

    expect(h.error).toHaveBeenCalledWith({ error: "NeonDbError" }, "alta.crear_inquilino_fallo");
    expect(JSON.stringify(h.error.mock.calls)).not.toContain("ana@example.com");
    expect(h.soltarCupo).toHaveBeenCalledTimes(1);
    expect(h.soltarCupo).toHaveBeenCalledWith(CLAVE, VENTANA);
  });

  it.each([
    ["ya_tiene_espacio", "/bandeja"],
    ["no_verificado", "/alta?e=falla"],
    ["datos_invalidos", "/alta?e=datos"],
    ["alta_cerrada", "/alta?e=cerrada"],
  ] as const)("%s: va a %s, sin `alta`, y suelta el cupo", async (resultado, destino) => {
    h.crearInquilino.mockResolvedValue({ ...ALTA, resultado });

    const r = await crearEspacio(buenos());

    expect(r).toEqual({ destino });
    expect(r.alta).toBeUndefined();
    expect(h.soltarCupo).toHaveBeenCalledTimes(1);
    expect(h.soltarCupo).toHaveBeenCalledWith(CLAVE, VENTANA);
  });

  it("alta_cerrada anota el tope sin datos personales", async () => {
    h.crearInquilino.mockResolvedValue({ ...ALTA, resultado: "alta_cerrada", creadas24h: 20, tope: 20 });

    await crearEspacio(buenos());

    expect(h.warn).toHaveBeenCalledWith({ creadas24h: 20, tope: 20 }, "alta.cerrada");
  });

  it("la tabla de destinos sin espacio cubre todo resultado que no crea uno", () => {
    expect(Object.keys(SIN_ESPACIO).sort()).toEqual(["alta_cerrada", "datos_invalidos", "no_verificado", "ya_tiene_espacio"]);
    expect(conError("celular")).toBe("/alta?e=celular");
  });
});

describe("crearEspacio: el espacio creado", () => {
  it.each(["ok", "ok_numero_en_revision"] as const)(
    "%s: va a los primeros pasos, devuelve `alta` para que la acción avise, y no suelta el cupo",
    async (resultado) => {
      const alta = { ...ALTA, resultado };
      h.crearInquilino.mockResolvedValue(alta);

      expect(await crearEspacio(buenos())).toEqual({ destino: PRIMEROS_PASOS, alta });

      expect(h.soltarCupo).not.toHaveBeenCalled();
    }
  );

  it("con una base por cliente lanza la preparación de ESE espacio y manda a /preparando", async () => {
    process.env.BASE_POR_CLIENTE = "1";

    const r = await crearEspacio(buenos());

    expect(r).toEqual({ destino: "/preparando", alta: ALTA });
    expect(h.iniciarBase).toHaveBeenCalledWith(TENANT);
  });

  it("si la preparación no arranca, el espacio igual existe: /preparando y nada se suelta", async () => {
    process.env.BASE_POR_CLIENTE = "1";
    h.iniciarBase.mockRejectedValue(new Error("sin red"));

    expect(await crearEspacio(buenos())).toEqual({ destino: "/preparando", alta: ALTA });
    expect(h.soltarCupo).not.toHaveBeenCalled();
  });
});
