/**
 * `pedirAcceso`: la Server Action del botón «pedir acceso» de /alta.
 *
 * Lo que se prueba es la forma de la respuesta, no el aviso (eso está en `pedir-acceso.test.ts`):
 *  - la guarda es la misma que la de `crearMiEspacio` y no gasta nada;
 *  - con sesión verificada contesta SIEMPRE lo mismo (cookie y redirección), haya o no un espacio del dominio;
 *  - antes de contestar no se consulta la base ni se cuenta ni se manda nada: todo eso va en `after()`;
 *  - el usuario, en el aviso y en la cookie, sale de la sesión, nunca de lo que mande el navegador.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  sesion: vi.fn(),
  pedirAccesoAlEspacio: vi.fn(),
  db: vi.fn(),
  rateLimit: vi.fn(),
  enviar: vi.fn(),
  /** Cada cookie que la acción escribió: `set(nombre, valor, opciones)`. */
  cookieSet: vi.fn(),
  /** Lo que la acción dejó para después de responder (`after`). */
  pendientes: [] as Array<() => unknown>,
}));

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
  cookies: async () => ({ set: h.cookieSet }),
}));

/** `redirect` tira, igual que en Next: se atrapa el destino. */
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

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (tarea: () => unknown) => {
    h.pendientes.push(tarea);
  },
}));

vi.mock("@/lib/auth/session", () => ({ getSessionContext: h.sesion }));
vi.mock("@/lib/auth/require-operator", () => ({
  isOperatorEmail: (e: string | null | undefined) => e === "ops@example.com",
}));
/** Sólo se sustituye el aviso: la cookie es la de verdad, contra el `cookies()` de arriba. */
vi.mock("@/server/alta/pedir-acceso", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/alta/pedir-acceso")>()),
  pedirAccesoAlEspacio: h.pedirAccesoAlEspacio,
}));
/** Cualquier contacto con la base, el limitador o el remitente antes de `after()` se ve acá. */
vi.mock("@/lib/db", () => ({ db: new Proxy({}, { get: () => h.db }) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  rateLimit: h.rateLimit,
}));
vi.mock("@/server/notify/remitente-sistema", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/notify/remitente-sistema")>()),
  enviarCorreoDelSistema: h.enviar,
}));

import { pedirAcceso } from "@/app/alta/actions";

const USUARIO = "11111111-1111-4111-8111-111111111111";
/** Lo que el servidor le pone al navegador: el id de la sesión, sólo para /alta, 2 minutos, sin JavaScript. */
const COOKIE_DEL_PEDIDO = [
  "cm_pedido",
  USUARIO,
  { httpOnly: true, secure: true, sameSite: "lax", path: "/alta", maxAge: 120 },
] as const;

/** Corre la acción y devuelve la ruta a la que redirigió. */
async function correr(...args: unknown[]): Promise<string> {
  try {
    await (pedirAcceso as (...a: unknown[]) => Promise<void>)(...args);
  } catch (e) {
    if (e instanceof RedirigioA) return e.destino;
    throw e;
  }
  throw new Error("pedirAcceso no redirigió");
}

const conSesion = (user: Record<string, unknown>) => h.sesion.mockResolvedValue({ user });
const verificada = { id: USUARIO, email: "ana@acme.example", emailVerified: true };

function sinContactoConNadie() {
  expect(h.db).not.toHaveBeenCalled();
  expect(h.rateLimit).not.toHaveBeenCalled();
  expect(h.enviar).not.toHaveBeenCalled();
  expect(h.pedirAccesoAlEspacio).not.toHaveBeenCalled();
}

/** Ni cookie ni aviso: la guarda cortó antes de aceptar el pedido. */
function sinPedidoAceptado() {
  expect(h.pendientes).toHaveLength(0);
  expect(h.cookieSet).not.toHaveBeenCalled();
  sinContactoConNadie();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.pendientes.length = 0;
  h.pedirAccesoAlEspacio.mockResolvedValue(undefined);
});

describe("la guarda", () => {
  it("sin sesión vuelve a /login y no agenda nada", async () => {
    h.sesion.mockResolvedValue(null);

    expect(await correr()).toBe("/login");

    sinPedidoAceptado();
  });

  it("con el correo sin verificar vuelve a /alta, donde la pantalla dice por qué, y no agenda nada", async () => {
    conSesion({ ...verificada, emailVerified: false });

    expect(await correr()).toBe("/alta");

    sinPedidoAceptado();
  });

  it("un correo de operación vuelve a /alta y no agenda nada", async () => {
    conSesion({ ...verificada, email: "ops@example.com" });

    expect(await correr()).toBe("/alta");

    sinPedidoAceptado();
  });
});

describe("con la sesión verificada", () => {
  it("redirige a /alta, sin parámetros, y deja el trabajo para después de responder", async () => {
    conSesion(verificada);

    expect(await correr()).toBe("/alta");

    expect(h.pendientes).toHaveLength(1);
  });

  it("deja la cookie del pedido con el id de la sesión y esas opciones, antes de redirigir", async () => {
    conSesion(verificada);

    await correr();

    expect(h.cookieSet).toHaveBeenCalledTimes(1);
    expect(h.cookieSet).toHaveBeenCalledWith(...COOKIE_DEL_PEDIDO);
  });

  it("antes de contestar no se consulta la base, no se cuenta y no se manda: nada de eso corre hasta `after()`", async () => {
    conSesion(verificada);

    await correr();

    sinContactoConNadie();
  });

  it("lo agendado avisa con el id y el correo de la sesión", async () => {
    conSesion(verificada);
    await correr();

    await h.pendientes[0]();

    expect(h.pedirAccesoAlEspacio).toHaveBeenCalledTimes(1);
    expect(h.pedirAccesoAlEspacio).toHaveBeenCalledWith({ userId: USUARIO, email: "ana@acme.example" });
  });

  it("no lee lo que mande el navegador: un formulario con otro correo o id no cambia a quién se avisa", async () => {
    conSesion(verificada);
    const formulario = new FormData();
    formulario.set("email", "otra@acme.example");
    formulario.set("userId", "99999999-9999-4999-8999-999999999999");

    expect(await correr(formulario)).toBe("/alta");
    await h.pendientes[0]();

    expect(h.pedirAccesoAlEspacio).toHaveBeenCalledWith({ userId: USUARIO, email: "ana@acme.example" });
    // La cookie lleva el id de la sesión, nunca el del formulario.
    expect(h.cookieSet).toHaveBeenCalledWith(...COOKIE_DEL_PEDIDO);
    expect(h.cookieSet.mock.calls.flat()).not.toContain("99999999-9999-4999-8999-999999999999");
  });

  it("contesta lo mismo con un dominio público, con uno de empresa y con un espacio o sin él: la respuesta no depende de nada de eso", async () => {
    const respuestas: string[] = [];
    for (const dominio of ["gmail.com", "acme.example", "sin-espacio.example"]) {
      const email = `ana@${dominio}`;
      conSesion({ ...verificada, email });
      respuestas.push(await correr());
    }

    expect(new Set(respuestas)).toEqual(new Set(["/alta"]));
    expect(h.cookieSet.mock.calls).toEqual([COOKIE_DEL_PEDIDO, COOKIE_DEL_PEDIDO, COOKIE_DEL_PEDIDO]);
    expect(h.pendientes).toHaveLength(3);
    sinContactoConNadie();
  });
});
