/**
 * `reintentarMiBase`: el botón de /preparando.
 *
 * Lo que importa es de quién es la base que se reintenta y cuándo:
 *   - el inquilino sale de la fila de la sesión, jamás de lo que mande el formulario;
 *   - sólo se reintenta una base `fallida`, o `creando` desde hace más de 15 minutos;
 *   - son 3 pedidos por usuario cada 10 minutos, y sin cupo no se hace nada;
 *   - termina siempre en /preparando, y el `redirect` va afuera de todo try/catch.
 * Más `vistaDeBase`, la regla que comparten la pantalla y la acción.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sesion: vi.fn(),
  fila: vi.fn(),
  olvidar: vi.fn(),
  rateLimit: vi.fn(),
  iniciarBase: vi.fn(),
  error: vi.fn(),
}));

vi.mock("server-only", () => ({}));

class RedirigioA extends Error {
  constructor(public readonly destino: string) {
    super(`NEXT_REDIRECT:${destino}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new RedirigioA(destino);
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSessionContext: h.sesion }));
vi.mock("@/lib/auth/fila-de-usuario-cacheada", () => ({
  filaDeUsuario: h.fila,
  olvidarFilaDeUsuario: h.olvidar,
}));
vi.mock("@/lib/rate-limit/index", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit/index")>()),
  rateLimit: h.rateLimit,
}));
vi.mock("@/server/bases/iniciar", () => ({ iniciarBase: h.iniciarBase }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: h.error },
}));

import { reintentarMiBase } from "@/app/preparando/actions";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { MINUTOS_PARA_REINTENTAR, vistaDeBase } from "@/server/bases/espera";

const USUARIO = "11111111-1111-4111-8111-111111111111";
const SU_INQUILINO = "aaaaaaaa-0000-4000-8000-00000000000a";
const OTRO_INQUILINO = "bbbbbbbb-0000-4000-8000-00000000000b";
const MIN = 60_000;

const hace = (minutos: number) => new Date(Date.now() - minutos * MIN);
const filaCon = (base: string | null, baseDesde: Date | null = hace(1)) => ({
  id: USUARIO,
  tenant_id: SU_INQUILINO,
  role: "owner",
  base,
  baseDesde,
});

/** Corre la acción y devuelve adónde redirigió. `campos` es lo que un navegador malicioso mandaría. */
async function reintentar(campos: Record<string, string> = {}): Promise<string> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.set(k, v);
  try {
    await (reintentarMiBase as (fd: FormData) => Promise<void>)(fd);
  } catch (e) {
    if (e instanceof RedirigioA) return e.destino;
    throw e;
  }
  throw new Error("la acción no redirigió");
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BASE_POR_CLIENTE = "1";
  h.sesion.mockResolvedValue({ user: { id: USUARIO, email: "ana@example.com" } });
  h.fila.mockResolvedValue(filaCon("fallida"));
  h.rateLimit.mockResolvedValue({ allowed: true, remaining: 2, resetAt: 0, retryAfterSeconds: 0, ventana: 1 });
  h.iniciarBase.mockResolvedValue(undefined);
});

describe("de quién es la base", () => {
  it("es la del inquilino de la sesión, y un `tenantId` del formulario se ignora", async () => {
    expect(await reintentar({ tenantId: OTRO_INQUILINO, tenant_id: OTRO_INQUILINO, base: OTRO_INQUILINO })).toBe(
      "/preparando"
    );

    expect(h.fila).toHaveBeenCalledWith(USUARIO);
    expect(h.iniciarBase).toHaveBeenCalledTimes(1);
    expect(h.iniciarBase).toHaveBeenCalledWith(SU_INQUILINO);
  });

  it("sin sesión va a /login y no toca nada", async () => {
    h.sesion.mockResolvedValue(null);

    expect(await reintentar({ tenantId: OTRO_INQUILINO })).toBe("/login");
    expect(h.fila).not.toHaveBeenCalled();
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.iniciarBase).not.toHaveBeenCalled();
  });

  it("sin fila de users va a /pendiente", async () => {
    h.fila.mockResolvedValue(null);

    expect(await reintentar()).toBe("/pendiente");
    expect(h.iniciarBase).not.toHaveBeenCalled();
  });

  it("apagada la bandera va a /bandeja y no cuenta ni lanza nada", async () => {
    delete process.env.BASE_POR_CLIENTE;

    expect(await reintentar()).toBe("/bandeja");
    expect(h.rateLimit).not.toHaveBeenCalled();
    expect(h.iniciarBase).not.toHaveBeenCalled();
  });

  it("lee la fila sin la copia en memoria", async () => {
    await reintentar();

    expect(h.olvidar).toHaveBeenCalledWith(USUARIO);
    expect(h.olvidar.mock.invocationCallOrder[0]).toBeLessThan(h.fila.mock.invocationCallOrder[0]);
  });
});

describe("cuándo reintenta", () => {
  it.each([
    ["fallida", filaCon("fallida")],
    ["fallida desde hace una hora", filaCon("fallida", hace(60))],
    ["creando desde hace más de 15 minutos", filaCon("creando", hace(16))],
    ["sin fila de base desde hace más de 15 minutos", filaCon(null, hace(16))],
    ["creando, sin saber desde cuándo", filaCon("creando", null)],
  ])("%s: lanza la base", async (_caso, fila) => {
    h.fila.mockResolvedValue(fila);

    expect(await reintentar()).toBe("/preparando");
    expect(h.iniciarBase).toHaveBeenCalledWith(SU_INQUILINO);
  });

  it.each([
    ["creando hace un minuto", filaCon("creando", hace(1))],
    ["creando hace 14 minutos", filaCon("creando", hace(14))],
    ["sin fila de base y recién creada", filaCon(null, hace(2))],
    ["lista", filaCon("lista", hace(600))],
    ["borrada", filaCon("borrada", hace(600))],
  ])("%s: no hace nada", async (_caso, fila) => {
    h.fila.mockResolvedValue(fila);

    expect(await reintentar()).toBe("/preparando");
    expect(h.iniciarBase).not.toHaveBeenCalled();
  });
});

describe("el cupo", () => {
  it("son 3 pedidos cada 10 minutos por usuario, y falla cerrado", async () => {
    await reintentar();

    expect(h.rateLimit).toHaveBeenCalledTimes(1);
    expect(h.rateLimit).toHaveBeenCalledWith(claveDeCupo("user", USUARIO, "reintentar-base"), {
      limit: 3,
      windowMs: 10 * MIN,
      fallaCerrada: true,
    });
  });

  it("sin cupo no lee la fila ni lanza nada, y vuelve a /preparando", async () => {
    h.rateLimit.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 0, retryAfterSeconds: 60, ventana: 1 });

    expect(await reintentar()).toBe("/preparando");
    expect(h.fila).not.toHaveBeenCalled();
    expect(h.iniciarBase).not.toHaveBeenCalled();
  });
});

describe("cuando el lanzamiento falla", () => {
  it("lo anota sin el mensaje y igual vuelve a /preparando", async () => {
    h.iniciarBase.mockRejectedValue(new Error("Failed query: params: ana@example.com"));

    expect(await reintentar()).toBe("/preparando");
    expect(h.error).toHaveBeenCalledWith(
      { error: "Error", tenantId: SU_INQUILINO },
      "preparando.reintento_fallo"
    );
  });
});

describe("vistaDeBase", () => {
  const AHORA = Date.parse("2026-10-08T12:00:00Z");
  const desde = (minutos: number) => new Date(AHORA - minutos * MIN);

  it("el plazo es de 15 minutos", () => {
    expect(MINUTOS_PARA_REINTENTAR).toBe(15);
  });

  it.each([
    ["lista", desde(0), "lista"],
    ["borrada", desde(0), "borrada"],
    ["fallida", desde(0), "reintentable"],
    ["creando", desde(14), "esperando"],
    ["creando", desde(15), "esperando"],
    ["creando", desde(16), "reintentable"],
    [null, desde(1), "esperando"],
    [null, desde(60), "reintentable"],
    ["creando", null, "reintentable"],
  ] as const)("%s desde %s es %s", (base, baseDesde, vista) => {
    expect(vistaDeBase({ base, baseDesde }, AHORA)).toBe(vista);
  });
});
