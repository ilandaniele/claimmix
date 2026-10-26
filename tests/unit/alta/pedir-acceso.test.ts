/**
 * `pedirAccesoAlEspacio`: lo que corre en `after()` cuando alguien aprieta «pedir acceso» en /alta.
 *
 * La base es drizzle de verdad sobre un driver falso (`pg-proxy`): lo que se mira es el SQL que
 * viaja y cuántas veces. El limitador es el de memoria, el mismo que usa el resto de las
 * pruebas; lo único que se sustituye es el envío del mail y el registro. Lo que importa:
 *  - nada se consulta ni se cuenta ni se manda si el dominio es público o no hay remitente;
 *  - una persona, un pedido por día, aunque no haya espacio (si no, la segunda respuesta ya
 *    diría si lo hay);
 *  - cinco pedidos por espacio y por día, y el cupo vuelve si ningún mail salió, también con el
 *    remitente de verdad (el único límite por administrador es el del espacio);
 *  - una sola consulta, con todos los filtros dentro de ella;
 *  - el texto es fijo, sin espacio ni nombres, y el idioma es el del administrador;
 *  - nunca lanza, y lo que registra no lleva ni la dirección ni el dominio;
 *  - la cookie del pedido (`cm_pedido`) vale sólo para el id de la sesión que la trae.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Lo que viajó a la base, en orden. */
  consultas: [] as { sql: string; params: unknown[] }[],
  /** Lo que contesta la base: filas [tenant_id, email, locale]. */
  filas: [] as unknown[][],
  falla: null as Error | null,
  enviar: vi.fn(),
  /** El envío de Gmail, para la prueba que usa el remitente de verdad. */
  gmail: vi.fn(),
  /** Las cookies del navegador de la prueba y lo que se les escribió. */
  galleta: new Map<string, string>(),
  cookieSet: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: (nombre: string, valor: string, opciones: unknown) => {
      h.cookieSet(nombre, valor, opciones);
      h.galleta.set(nombre, valor);
    },
    get: (nombre: string) => (h.galleta.has(nombre) ? { name: nombre, value: h.galleta.get(nombre) } : undefined),
  }),
}));
vi.mock("@/lib/db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  return {
    db: drizzle(async (sql, params) => {
      h.consultas.push({ sql, params });
      if (h.falla) throw h.falla;
      return { rows: h.filas };
    }),
  };
});
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: h.info, warn: h.warn, error: h.error },
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...real, rateLimit: vi.fn(real.rateLimit), liberarCupo: vi.fn(real.liberarCupo) };
});
vi.mock("@/server/notify/remitente-sistema", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/notify/remitente-sistema")>()),
  enviarCorreoDelSistema: h.enviar,
}));
vi.mock("@/server/email/gmail/gmail-sender", () => ({
  GmailSender: class {
    send = h.gmail;
  },
}));

import { PgDialect } from "drizzle-orm/pg-core";

import { enUS, esAR } from "@/lib/i18n";
import { clearAllRateLimits, liberarCupo, rateLimit } from "@/lib/rate-limit";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import {
  COOKIE_DE_PEDIDO,
  consultaDeAdministradores,
  pedidoDeLaSesion,
  pedirAccesoAlEspacio,
  ponerCookieDePedido,
} from "@/server/alta/pedir-acceso";
import { huellaDeLaDireccion } from "@/server/notify/remitente-sistema";

const DIA_MS = 24 * 60 * 60_000;
const USER = "20000000-0000-0000-0000-000000000001";
const PEDIDOR = "Ana.Perez@acme.example";
const ESPACIO_1 = "10000000-0000-0000-0000-000000000001";
const ESPACIO_2 = "10000000-0000-0000-0000-000000000002";
const URL_DE_USUARIOS = "https://claimmix.example.com/admin/users";
const dialecto = new PgDialect();

const UN_ADMIN = [[ESPACIO_1, "admin@acme.example", "es-AR"]];
const DOS_ADMINS = [
  [ESPACIO_1, "admin@acme.example", "es-AR"],
  [ESPACIO_1, "owner@acme.example", "en-US"],
];

const pedir = (email = PEDIDOR, userId = USER) => pedirAccesoAlEspacio({ userId, email });
const claves = () => vi.mocked(rateLimit).mock.calls.map(([clave]) => clave);
const registros = () => JSON.stringify([...h.info.mock.calls, ...h.warn.mock.calls, ...h.error.mock.calls]);

beforeEach(() => {
  vi.clearAllMocks();
  clearAllRateLimits();
  h.consultas.length = 0;
  h.galleta.clear();
  h.filas = UN_ADMIN;
  h.falla = null;
  h.enviar.mockResolvedValue({ enviado: true });
  vi.stubEnv("ALTA_REMITENTE_CORREO", "sistema@example.com");
  vi.stubEnv("ALTA_REMITENTE_REFRESH_TOKEN", "test-refresh-key");
  vi.stubEnv("GMAIL_CLIENT_ID", "fake-client-id");
  vi.stubEnv("GMAIL_CLIENT_SECRET", "fake-client-secret");
  vi.stubEnv("ADMIN_EMAILS", "ops@example.com, Dueno@Example.com");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://claimmix.example.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("el aviso a los administradores", () => {
  it("manda un mail por administrador, del tipo «acceso», sin IP, con la dirección de quien pide y nuestro enlace", async () => {
    h.filas = DOS_ADMINS;

    await pedir();

    expect(h.enviar).toHaveBeenCalledTimes(2);
    expect(h.enviar.mock.calls.map(([correo]) => correo.to)).toEqual(["admin@acme.example", "owner@acme.example"]);
    for (const [, opciones] of h.enviar.mock.calls) expect(opciones).toEqual({ tipo: "acceso" });
    const [correo] = h.enviar.mock.calls[0];
    expect(correo.texto.split("\n")).toEqual([
      esAR["correo.saludo"],
      "",
      esAR["correo.acceso.intro"],
      "",
      PEDIDOR,
      "",
      esAR["correo.acceso.invitar"],
      "",
      URL_DE_USUARIOS,
      "",
      esAR["correo.acceso.noFuiste"],
    ]);
  });

  it("el texto es fijo: la única parte variable es la dirección de quien pide, y no lleva HTML", async () => {
    h.filas = UN_ADMIN;
    await pedir("ana@acme.example");
    await pedir("luis@acme.example", "20000000-0000-0000-0000-000000000002");

    const [uno, otro] = h.enviar.mock.calls.map(([correo]) => correo.texto as string);
    expect(uno.replace("ana@acme.example", "{correo}")).toBe(otro.replace("luis@acme.example", "{correo}"));
    expect(uno).not.toMatch(/<[a-z]/i);
  });

  it("cada administrador lo recibe en su idioma, no en el de quien pide; sin idioma o con uno raro, el de por omisión", async () => {
    h.filas = [
      [ESPACIO_1, "uno@acme.example", "en-US"],
      [ESPACIO_1, "dos@acme.example", "es-AR"],
      [ESPACIO_1, "tres@acme.example", null],
      [ESPACIO_1, "cuatro@acme.example", "xx"],
    ];

    await pedir();

    expect(h.enviar.mock.calls.map(([correo]) => correo.asunto)).toEqual([
      enUS["correo.acceso.asunto"],
      esAR["correo.acceso.asunto"],
      esAR["correo.acceso.asunto"],
      esAR["correo.acceso.asunto"],
    ]);
    expect(enUS["correo.acceso.asunto"]).not.toBe(esAR["correo.acceso.asunto"]);
  });

  it("una dirección con «$&» o «$1» en la parte local aparece tal cual en el mail", async () => {
    await pedir("a$&b$1@acme.example");

    expect(h.enviar.mock.calls[0][0].texto.split("\n")).toContain("a$&b$1@acme.example");
  });

  it("sin ningún administrador en el dominio no manda nada ni registra un fallo", async () => {
    h.filas = [];

    await pedir();

    expect(h.enviar).not.toHaveBeenCalled();
    expect(h.error).not.toHaveBeenCalled();
    expect(h.consultas).toHaveLength(1);
  });

  it("cuenta cuántos administradores había y a cuántos les salió, y nada más", async () => {
    h.filas = DOS_ADMINS;
    h.enviar.mockResolvedValueOnce({ enviado: true }).mockResolvedValueOnce({ enviado: false, motivo: "sin_cupo" });

    await pedir();

    expect(h.info).toHaveBeenCalledWith({ administradores: 2, enviados: 1 }, "alta.pedir_acceso");
  });
});

describe("las salidas tempranas: no se consulta, no se cuenta, no se manda", () => {
  const NADA = () => {
    expect(h.consultas).toHaveLength(0);
    expect(vi.mocked(rateLimit)).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
  };

  it.each(["gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "GMAIL.com", "fibertel.com.ar", "speedy.com.ar", "arnet.com.ar"])(
    "el dominio público %s",
    async (dominio) => {
      await pedir(`ana@${dominio}`);

      NADA();
    }
  );

  it("sin remitente del sistema no hay nada que mandar, así que tampoco se gasta el cupo de la persona", async () => {
    vi.stubEnv("ALTA_REMITENTE_REFRESH_TOKEN", "");

    await pedir();

    NADA();
  });

  it.each(["", "sin-arroba", "ana@", "ana@acme.example, otra@acme.example"])("%j no es una dirección", async (email) => {
    await pedir(email);

    NADA();
  });
});

describe("una persona, un pedido por día", () => {
  it("el segundo pedido del día no consulta ni manda, aunque el primero no haya encontrado espacio", async () => {
    h.filas = [];
    await pedir();
    h.filas = UN_ADMIN;

    await pedir();

    expect(h.consultas).toHaveLength(1);
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("el cupo se cuenta sobre la dirección canónica: las mayúsculas no estrenan otro", async () => {
    await pedir("Ana.Perez@Acme.example");
    await pedir("ana.perez@acme.example");

    expect(h.enviar).toHaveBeenCalledTimes(1);
  });

  it("la clave lleva la huella de la dirección, no la dirección: el limitador no guarda mails", async () => {
    await pedir();

    const clave = claves()[0];
    expect(clave).toBe(claveDeCupo("alta:acceso-persona", huellaDeLaDireccion(PEDIDOR) as string));
    expect(clave).not.toMatch(/ana|perez|acme|@/i);
    expect(vi.mocked(rateLimit).mock.calls[0][1]).toEqual({ limit: 1, windowMs: DIA_MS, fallaCerrada: true });
  });

  it("otra persona del mismo dominio tiene su propio cupo", async () => {
    await pedir("ana@acme.example");
    await pedir("luis@acme.example", "20000000-0000-0000-0000-000000000002");

    expect(h.enviar).toHaveBeenCalledTimes(2);
  });

  it("el intento que el contador rechazó se devuelve, en la misma ventana en que se contó", async () => {
    vi.mocked(rateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: 0,
      retryAfterSeconds: 0,
      ventana: 1_700_000_000_000,
    });

    await pedir();

    expect(vi.mocked(liberarCupo)).toHaveBeenCalledWith(claves()[0], DIA_MS, 1_700_000_000_000);
    expect(h.consultas).toHaveLength(0);
  });

  it("si el contador no contesta, cierra: no consulta ni manda", async () => {
    vi.mocked(rateLimit).mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      resetAt: 0,
      retryAfterSeconds: 60,
      ventana: 0,
    });

    await pedir();

    expect(h.consultas).toHaveLength(0);
    expect(h.enviar).not.toHaveBeenCalled();
  });
});

describe("cinco pedidos por espacio y por día", () => {
  const pedidoNumero = (n: number) => pedir(`persona${n}@acme.example`, `20000000-0000-0000-0000-00000000010${n}`);

  it("el sexto no manda nada", async () => {
    for (let n = 1; n <= 6; n++) await pedidoNumero(n);

    expect(h.enviar).toHaveBeenCalledTimes(5);
  });

  it("la clave es la del espacio y no la del dominio, y el tope es cinco por día, con falla cerrada", async () => {
    await pedir();

    expect(claves()[1]).toBe(claveDeCupo("alta:acceso-espacio", ESPACIO_1));
    expect(vi.mocked(rateLimit).mock.calls[1][1]).toEqual({ limit: 5, windowMs: DIA_MS, fallaCerrada: true });
    expect(claves()[1]).not.toMatch(/acme|@/);
  });

  it("dos administradores del mismo espacio gastan un solo pedido", async () => {
    h.filas = DOS_ADMINS;

    for (let n = 1; n <= 5; n++) await pedidoNumero(n);

    expect(claves().filter((c) => c === claveDeCupo("alta:acceso-espacio", ESPACIO_1))).toHaveLength(5);
    expect(h.enviar).toHaveBeenCalledTimes(10);
  });

  it("un espacio lleno no frena a otro del mismo dominio", async () => {
    for (let n = 1; n <= 5; n++) await pedidoNumero(n);
    h.filas = [
      [ESPACIO_1, "admin@acme.example", "es-AR"],
      [ESPACIO_2, "otro@acme.example", "es-AR"],
    ];
    h.enviar.mockClear();

    await pedidoNumero(6);

    expect(h.enviar.mock.calls.map(([correo]) => correo.to)).toEqual(["otro@acme.example"]);
  });

  it("si no salió ningún mail el cupo del espacio vuelve: el pedido no se dio", async () => {
    h.enviar.mockResolvedValue({ enviado: false, motivo: "no_salio" });

    for (let n = 1; n <= 6; n++) await pedidoNumero(n);

    expect(h.enviar).toHaveBeenCalledTimes(6);
    expect(vi.mocked(liberarCupo).mock.calls.filter(([clave]) => clave === claveDeCupo("alta:acceso-espacio", ESPACIO_1))).toHaveLength(6);
  });

  it("con el remitente de verdad un espacio con un solo administrador recibe los cinco y no el sexto: ningún otro tope lo corta antes", async () => {
    const real = await vi.importActual<typeof import("@/server/notify/remitente-sistema")>("@/server/notify/remitente-sistema");
    h.enviar.mockImplementation(real.enviarCorreoDelSistema);
    h.gmail.mockResolvedValue({ providerMessageId: "sent-1" });

    for (let n = 1; n <= 6; n++) await pedidoNumero(n);

    expect(h.gmail).toHaveBeenCalledTimes(5);
    expect(vi.mocked(liberarCupo).mock.calls.filter(([clave]) => clave === claveDeCupo("alta:acceso-espacio", ESPACIO_1))).toHaveLength(1);
    expect(claves().some((c) => c.startsWith("alta:destinatario"))).toBe(false);
  });

  it("si salió al menos uno el cupo se queda gastado", async () => {
    h.filas = DOS_ADMINS;
    h.enviar.mockResolvedValueOnce({ enviado: true }).mockResolvedValueOnce({ enviado: false, motivo: "sin_cupo" });

    await pedir();

    expect(vi.mocked(liberarCupo).mock.calls.filter(([clave]) => clave === claveDeCupo("alta:acceso-espacio", ESPACIO_1))).toHaveLength(0);
  });
});

describe("la consulta de administradores", () => {
  it("es una sola por pedido", async () => {
    h.filas = DOS_ADMINS;

    await pedir();

    expect(h.consultas).toHaveLength(1);
  });

  it("lleva todos los filtros adentro: rol, baja, verificado, bloqueo, dominio exacto, operación, quien pide, espacio con servicio y su perfil", () => {
    const { sql, params } = consultaDeAdministradores("acme.example", USER, PEDIDOR).toSQL();
    const normalizado = sql.replace(/\s+/g, " ");

    expect(normalizado).toMatch(/"role" in \(\$\d+, \$\d+\)/);
    expect(normalizado).toMatch(/"dado_de_baja_en" is null/);
    expect(normalizado).toMatch(/"email_verified" = \$\d+/);
    expect(normalizado).toMatch(/coalesce\("[a-z_]*"\."banned", false\) = false/);
    expect(normalizado).toMatch(/lower\(split_part\("[a-z_]*"\."email", '@', 2\)\) = \$\d+/);
    expect(normalizado).toMatch(/lower\("[a-z_]*"\."email"\) not in \(\$\d+, \$\d+, \$\d+\)/);
    expect(normalizado).toMatch(/inner join "tenants" on "tenants"\."id" = "users"\."tenant_id"/);
    expect(normalizado).toMatch(/"tenants"\."billing_status" not in \(\$\d+, \$\d+\)/);
    expect(normalizado).toMatch(/not exists \(select 1 from "users" "pedidor_con_perfil" where "pedidor_con_perfil"\."id" = \$\d+\)/);
    expect(normalizado).toMatch(/order by .*"tenant_id", .*"email" limit \$\d+$/);
    expect(params).toEqual([
      "owner",
      "admin",
      true,
      "acme.example",
      "ops@example.com",
      "dueno@example.com",
      "ana.perez@acme.example",
      "suspended",
      "churned",
      USER,
      20,
    ]);
  });

  it("devuelve a lo sumo veinte filas", () => {
    expect(consultaDeAdministradores("acme.example", USER, PEDIDOR).toSQL().params.at(-1)).toBe(20);
  });

  it("lee `tenants` sólo para dejar afuera los espacios sin servicio y no acota por un inquilino: el dominio puede estar en varios espacios", () => {
    const { sql, params } = consultaDeAdministradores("acme.example", USER, PEDIDOR).toSQL();

    expect(sql).not.toMatch(/"tenant_id" = /);
    expect(params).not.toContain(ESPACIO_1);
  });

  it("pide sólo las tres columnas que se usan: ni el nombre ni nada más de la persona", async () => {
    await pedir();

    const consulta = dialecto.sqlToQuery(consultaDeAdministradores("acme.example", USER, PEDIDOR).getSQL());
    expect(consulta.sql).toMatch(/^select "users"\."tenant_id", "[a-z_]+"\."email", "users"\."locale" from/);
    expect(consulta.sql).not.toMatch(/full_name|"name"/);
  });

  it("lo que viaja a la base es la consulta de arriba: dominio en minúsculas, operación y quien pide", async () => {
    await pedir("Ana@ACME.example");

    expect(h.consultas).toHaveLength(1);
    expect(h.consultas[0].params).toEqual([
      "owner",
      "admin",
      true,
      "acme.example",
      "ops@example.com",
      "dueno@example.com",
      "ana@acme.example",
      "suspended",
      "churned",
      USER,
      20,
    ]);
  });
});

describe("nunca lanza y no registra datos de nadie", () => {
  it("si la base falla, no lanza y deja sólo el nombre del error", async () => {
    h.falla = new Error("connect ECONNREFUSED ana.perez@acme.example acme.example");

    await expect(pedir()).resolves.toBeUndefined();

    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "alta.pedir_acceso_fallo");
    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("si el envío tira, no lanza", async () => {
    h.enviar.mockRejectedValue(new TypeError("boom"));

    await expect(pedir()).resolves.toBeUndefined();

    expect(h.error).toHaveBeenCalledWith({ error: "TypeError" }, "alta.pedir_acceso_fallo");
  });

  it("si el contador tira, no lanza", async () => {
    vi.mocked(rateLimit).mockRejectedValueOnce(new Error("sin contador"));

    await expect(pedir()).resolves.toBeUndefined();

    expect(h.enviar).not.toHaveBeenCalled();
  });

  it("ni los registros de un pedido que sale ni los de uno que falla llevan la dirección, el dominio o el espacio", async () => {
    h.filas = DOS_ADMINS;
    await pedir();
    h.falla = new Error("ana.perez@acme.example");
    await pedir("otra@acme.example", "20000000-0000-0000-0000-000000000002");

    const todo = registros();
    expect(todo).toContain("alta.pedir_acceso");
    expect(todo).toContain("alta.pedir_acceso_fallo");
    expect(todo).not.toMatch(/ana\.perez|otra@|acme|admin@|owner@/i);
    expect(todo).not.toContain(ESPACIO_1);
    expect(todo).not.toContain(USER);
  });
});

describe("la cookie del pedido", () => {
  it("se llama cm_pedido y se escribe sólo para /alta, 2 minutos, sin JavaScript y sólo por HTTPS", async () => {
    await ponerCookieDePedido(USER);

    expect(COOKIE_DE_PEDIDO).toBe("cm_pedido");
    expect(h.cookieSet).toHaveBeenCalledTimes(1);
    expect(h.cookieSet).toHaveBeenCalledWith("cm_pedido", USER, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/alta",
      maxAge: 120,
    });
  });

  it("sin la cookie no hay pedido", async () => {
    expect(await pedidoDeLaSesion(USER)).toBe(false);
  });

  it("con la cookie de esta sesión hay pedido", async () => {
    await ponerCookieDePedido(USER);

    expect(await pedidoDeLaSesion(USER)).toBe(true);
  });

  it("con la cookie de otra sesión no hay pedido: vale sólo para el id que la puso", async () => {
    await ponerCookieDePedido("20000000-0000-0000-0000-000000000002");

    expect(await pedidoDeLaSesion(USER)).toBe(false);
  });

  it.each(["", "1", "true", ` ${USER}`, `${USER}x`, `${USER.slice(0, -1)}2`])(
    "un valor que no es exactamente el id (%j) no cuenta",
    async (valor) => {
      h.galleta.set("cm_pedido", valor);

      expect(await pedidoDeLaSesion(USER)).toBe(false);
    }
  );

  it("no consulta la base ni cuenta nada: lee sólo la cookie", async () => {
    await ponerCookieDePedido(USER);
    await pedidoDeLaSesion(USER);

    expect(h.consultas).toHaveLength(0);
    expect(rateLimit).not.toHaveBeenCalled();
    expect(h.enviar).not.toHaveBeenCalled();
  });
});
