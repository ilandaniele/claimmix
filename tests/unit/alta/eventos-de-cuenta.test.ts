/**
 * Lo que Meta avisa de la cuenta de un cliente (`@/server/alta/eventos-de-cuenta`):
 * que sacó la app, que la cuenta se restringió, que aprobaron o rechazaron el nombre
 * del número. Lo que importa es lo que NO pasa: una WABA no se da de baja porque lo
 * diga un evento (Graph tiene que confirmar que el token murió), un evento viejo no
 * pisa lo que el cliente ya reconectó y nada de esto tira nunca.
 *
 * La base, Graph y el aviso al operador están simulados.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EventoDeCuenta } from "@/server/whatsapp/cloud-api";

const h = vi.hoisted(() => ({
  leer: vi.fn(),
  revisarToken: vi.fn(),
  wabaRevocada: vi.fn(),
  wabaEnFalla: vi.fn(),
  nombreDelNumero: vi.fn(),
  nombreAprobado: vi.fn(),
  aviso: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/server/alta/wabas-del-cliente", () => ({ leerWabasDelCliente: h.leer }));
vi.mock("@/server/whatsapp/embedded-signup", () => ({ revisarToken: h.revisarToken }));
vi.mock("@/server/alta/panel-operador", () => ({
  wabaRevocada: h.wabaRevocada,
  wabaEnFalla: h.wabaEnFalla,
  nombreDelNumero: h.nombreDelNumero,
}));
vi.mock("@/server/alta/app-propia", () => ({ nombreAprobado: h.nombreAprobado }));
vi.mock("@/server/alta/aviso-operador", () => ({ avisarNumeroEnRevision: h.aviso }));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: h.info, warn: h.warn, error: h.error } }));

import { atenderEventosDeCuenta } from "@/server/alta/eventos-de-cuenta";

const TENANT = "10000000-0000-4000-8000-000000000001";
const WABA = "555000111222";
const TOKEN = "test-waba-token";
const AHORA_MS = 1_790_000_000_000;

const waba = (cambios: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  wabaId: WABA,
  estado: "conectada",
  actualizadoEn: AHORA_MS,
  plantillaEnviada: true,
  origen: "embedded_signup",
  token: TOKEN,
  ...cambios,
});

const evento = (cambios: Partial<EventoDeCuenta> = {}): EventoDeCuenta => ({
  campo: "account_update",
  wabaId: WABA,
  evento: "PARTNER_APP_UNINSTALLED",
  phoneNumberId: null,
  nombreEstado: null,
  hora: AHORA_MS / 1000 + 60,
  ...cambios,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.leer.mockResolvedValue([waba()]);
  h.revisarToken.mockResolvedValue({ ok: false, falla: "rechazo", codigo: 190 });
  h.wabaRevocada.mockResolvedValue(undefined);
  h.wabaEnFalla.mockResolvedValue(undefined);
  h.nombreDelNumero.mockResolvedValue(undefined);
  h.nombreAprobado.mockResolvedValue(undefined);
  h.aviso.mockResolvedValue(undefined);
});

describe("revocación", () => {
  it.each(["PARTNER_APP_UNINSTALLED", "PARTNER_REMOVED", "ACCOUNT_DELETED"])(
    "%s: da de baja la WABA solo cuando Graph dice que el token murió",
    async (nombre) => {
      await atenderEventosDeCuenta([evento({ evento: nombre })]);

      expect(h.revisarToken).toHaveBeenCalledWith(TOKEN);
      expect(h.wabaRevocada).toHaveBeenCalledWith(WABA);
      expect(h.aviso).toHaveBeenCalledWith("revocada", TENANT, { appPropia: false });
    }
  );

  it("no revoca si el token sigue sirviendo, aunque el evento lo diga", async () => {
    h.revisarToken.mockResolvedValue({ ok: true, valor: { wabaIds: [WABA], fbUserId: "1" } });

    await atenderEventosDeCuenta([evento()]);

    expect(h.wabaRevocada).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ motivo: "token_vigente" }), "whatsapp.cuenta_sin_confirmar");
  });

  it("revoca si el token vive pero ya no autoriza esta WABA (se sacó la app o el permiso de ella)", async () => {
    h.revisarToken.mockResolvedValue({ ok: true, valor: { wabaIds: ["999000111222"], fbUserId: "1" } });

    await atenderEventosDeCuenta([evento({ evento: "PARTNER_REMOVED" })]);

    expect(h.wabaRevocada).toHaveBeenCalledWith(WABA);
    expect(h.aviso).toHaveBeenCalledWith("revocada", TENANT, { appPropia: false });
  });

  it("un token vivo sin ninguna WABA tampoco la sostiene", async () => {
    h.revisarToken.mockResolvedValue({ ok: true, valor: { wabaIds: [], fbUserId: null } });

    await atenderEventosDeCuenta([evento()]);

    expect(h.wabaRevocada).toHaveBeenCalledWith(WABA);
  });

  it("no revoca con un error de Graph que no es el 190 (Meta caído no es token muerto)", async () => {
    h.revisarToken.mockResolvedValue({ ok: false, falla: "meta", codigo: null });

    await atenderEventosDeCuenta([evento()]);

    expect(h.wabaRevocada).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("sin token que preguntar no revoca ni llama a Graph", async () => {
    h.leer.mockResolvedValue([waba({ token: null })]);

    await atenderEventosDeCuenta([evento()]);

    expect(h.revisarToken).not.toHaveBeenCalled();
    expect(h.wabaRevocada).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ motivo: "sin_token" }), "whatsapp.cuenta_sin_confirmar");
  });

  it("dos avisos de revocación de la misma WABA en un pedido dan una sola baja", async () => {
    await atenderEventosDeCuenta([evento(), evento({ evento: "PARTNER_REMOVED" })]);

    expect(h.revisarToken).toHaveBeenCalledTimes(1);
    expect(h.wabaRevocada).toHaveBeenCalledTimes(1);
    expect(h.aviso).toHaveBeenCalledTimes(1);
  });
});

describe("eventos que no se atienden", () => {
  it("un aviso de restricción anterior al último cambio de la fila se descarta (el cliente ya reconectó)", async () => {
    await atenderEventosDeCuenta([evento({ evento: "ACCOUNT_RESTRICTION", hora: AHORA_MS / 1000 - 3600 })]);

    expect(h.aviso).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }), "whatsapp.cuenta_evento_viejo");
  });

  it("un nombre anterior al último cambio de la fila se descarta", async () => {
    await atenderEventosDeCuenta([
      evento({ campo: "phone_number_name_update", evento: null, nombreEstado: "DECLINED", hora: AHORA_MS / 1000 - 3600 }),
    ]);

    expect(h.nombreDelNumero).not.toHaveBeenCalled();
    expect(h.wabaEnFalla).not.toHaveBeenCalled();
  });

  it("una revocación se confirma con Graph aunque sea anterior al último cambio de la fila: si el token murió, la baja es cierta", async () => {
    // `wabaEnFalla` también toca `actualizado_en`: filtrarla por hora dejaba sin baja a una cuenta que Graph ya dio por muerta.
    await atenderEventosDeCuenta([evento({ hora: AHORA_MS / 1000 - 3600 })]);

    expect(h.revisarToken).toHaveBeenCalledWith(TOKEN);
    expect(h.wabaRevocada).toHaveBeenCalledWith(WABA);
  });

  it("una revocación vieja con el token ya reconectado y vivo no toca nada", async () => {
    h.revisarToken.mockResolvedValue({ ok: true, valor: { wabaIds: [WABA], fbUserId: "1" } });

    await atenderEventosDeCuenta([evento({ hora: AHORA_MS / 1000 - 3600 })]);

    expect(h.wabaRevocada).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("un evento sin hora se atiende: no hay con qué descartarlo", async () => {
    await atenderEventosDeCuenta([evento({ hora: null })]);

    expect(h.wabaRevocada).toHaveBeenCalledWith(WABA);
  });

  it("una WABA que la base no conoce (la de la plataforma) solo se anota", async () => {
    h.leer.mockResolvedValue([]);

    await atenderEventosDeCuenta([evento({ wabaId: "999" })]);

    expect(h.revisarToken).not.toHaveBeenCalled();
    expect(h.wabaRevocada).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ wabaId: "999" }), "whatsapp.cuenta_desconocida");
  });

  it("sin eventos no toca la base", async () => {
    await atenderEventosDeCuenta([]);

    expect(h.leer).not.toHaveBeenCalled();
  });

  it("un evento que no conoce solo queda en el registro", async () => {
    await atenderEventosDeCuenta([evento({ evento: "ALGO_NUEVO_DE_META" })]);

    expect(h.wabaRevocada).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ evento: "ALGO_NUEVO_DE_META" }), "whatsapp.cuenta_evento");
  });
});

describe("restricciones", () => {
  it.each(["DISABLED_UPDATE", "ACCOUNT_RESTRICTION", "ACCOUNT_VIOLATION"])("%s: avisa y no toca el estado", async (nombre) => {
    await atenderEventosDeCuenta([evento({ evento: nombre })]);

    expect(h.aviso).toHaveBeenCalledWith("cuenta_restringida", TENANT);
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, evento: nombre }), "whatsapp.cuenta_restringida");
    expect(h.wabaRevocada).not.toHaveBeenCalled();
    expect(h.wabaEnFalla).not.toHaveBeenCalled();
  });
});

describe("nombre del número", () => {
  const nombre = (nombreEstado: string | null) =>
    evento({ campo: "phone_number_name_update", evento: null, phoneNumberId: "777", nombreEstado });

  it("APPROVED: guarda el estado del nombre y no avisa", async () => {
    await atenderEventosDeCuenta([nombre("APPROVED")]);

    expect(h.nombreDelNumero).toHaveBeenCalledWith(WABA, "APPROVED");
    expect(h.wabaEnFalla).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
  });

  it("DECLINED: lo guarda, deja la WABA en falla y avisa", async () => {
    await atenderEventosDeCuenta([nombre("DECLINED")]);

    expect(h.nombreDelNumero).toHaveBeenCalledWith(WABA, "DECLINED");
    expect(h.wabaEnFalla).toHaveBeenCalledWith(TENANT, "nombre_rechazado");
    expect(h.aviso).toHaveBeenCalledWith("nombre_rechazado", TENANT);
  });

  it("un evento sin estado de nombre no escribe nada", async () => {
    await atenderEventosDeCuenta([nombre(null)]);

    expect(h.nombreDelNumero).not.toHaveBeenCalled();
  });
});

describe("app propia del cliente (por la ruta de su webhook)", () => {
  const contexto = (revisar: () => Promise<unknown>, actualizadoEn: number | null = null) =>
    ({ tenantId: TENANT, wabaId: WABA, actualizadoEn, revisar }) as never;
  const vencido = () => Promise.resolve({ ok: false, motivo: "token_vencido" });

  it("no lee la base: la ruta ya dijo de quién es la WABA", async () => {
    await atenderEventosDeCuenta([evento({ evento: "ACCOUNT_RESTRICTION" })], contexto(vencido));

    expect(h.leer).not.toHaveBeenCalled();
    expect(h.aviso).toHaveBeenCalledWith("waba_restringida", TENANT);
  });

  it("la lectura de la plataforma sólo trae las de Embedded Signup: la app propia no entra por ahí", async () => {
    await atenderEventosDeCuenta([evento()]);

    expect(JSON.stringify(h.leer.mock.calls[0][0])).toContain("origen = 'embedded_signup'");
  });

  it("PARTNER_APP_UNINSTALLED: revoca sólo cuando debug_token dice que el token venció", async () => {
    const revisar = vi.fn(vencido);

    await atenderEventosDeCuenta([evento()], contexto(revisar));

    expect(revisar).toHaveBeenCalledTimes(1);
    expect(h.revisarToken).not.toHaveBeenCalled();
    expect(h.wabaRevocada).toHaveBeenCalledWith(WABA);
    expect(h.aviso).toHaveBeenCalledWith("revocada", TENANT, { appPropia: true });
  });

  it.each([
    ["token_vigente", { ok: true, usuarioId: "1", wabaIds: [WABA] }],
    ["token_vigente sin la WABA en su lista", { ok: true, usuarioId: "1", wabaIds: [] }],
    ["token_de_otra_app", { ok: false, motivo: "token_de_otra_app" }],
    ["app_invalida", { ok: false, motivo: "app_invalida" }],
    ["falta_permiso", { ok: false, motivo: "falta_permiso" }],
    ["Graph caído", { ok: false, motivo: "meta", codigo: null }],
  ])("%s no revoca: sólo un token vencido da de baja la cuenta", async (_nombre, respuesta) => {
    await atenderEventosDeCuenta([evento()], contexto(() => Promise.resolve(respuesta)));

    expect(h.wabaRevocada).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }), "whatsapp.cuenta_sin_confirmar");
  });

  it("una fila de app propia que llegara sin contexto no se revoca: no hay con qué confirmar", async () => {
    h.leer.mockResolvedValue([waba({ origen: "app_propia" })]);

    await atenderEventosDeCuenta([evento()]);

    expect(h.wabaRevocada).not.toHaveBeenCalled();
    expect(h.revisarToken).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(expect.objectContaining({ motivo: "sin_revision" }), "whatsapp.cuenta_sin_confirmar");
  });

  it("dos avisos de baja en un pedido preguntan una vez y dan una sola baja", async () => {
    const revisar = vi.fn(vencido);

    await atenderEventosDeCuenta([evento(), evento({ evento: "PARTNER_REMOVED" })], contexto(revisar));

    expect(revisar).toHaveBeenCalledTimes(1);
    expect(h.wabaRevocada).toHaveBeenCalledTimes(1);
  });

  it("un aviso de otra WABA no se atiende aunque llegue por esta ruta", async () => {
    const revisar = vi.fn(vencido);

    await atenderEventosDeCuenta([evento({ wabaId: "999000111222" })], contexto(revisar));

    expect(revisar).not.toHaveBeenCalled();
    expect(h.wabaRevocada).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ wabaId: "999000111222" }), "whatsapp.cuenta_desconocida");
  });

  it("si la ruta no pudo fechar la fila (actualizadoEn nulo), un aviso viejo igual se atiende", async () => {
    await atenderEventosDeCuenta([evento({ evento: "ACCOUNT_VIOLATION", hora: 1 })], contexto(vencido, null));

    expect(h.wabaEnFalla).toHaveBeenCalledWith(TENANT, "waba_restringida");
  });

  it("con la fecha de la fila, un aviso anterior a su último cambio se descarta: no pisa lo que ya se arregló", async () => {
    await atenderEventosDeCuenta([evento({ evento: "ACCOUNT_RESTRICTION", hora: AHORA_MS / 1000 - 60 })], contexto(vencido, AHORA_MS));

    expect(h.wabaEnFalla).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ evento: "ACCOUNT_RESTRICTION" }), "whatsapp.cuenta_evento_viejo");
  });

  it("el nombre rechazado que Meta mandó antes del último cambio tampoco vuelve a dejar la WABA en falla", async () => {
    await atenderEventosDeCuenta(
      [evento({ campo: "phone_number_name_update", evento: null, nombreEstado: "DECLINED", hora: AHORA_MS / 1000 - 60 })],
      contexto(vencido, AHORA_MS)
    );

    expect(h.wabaEnFalla).not.toHaveBeenCalled();
    expect(h.nombreDelNumero).not.toHaveBeenCalled();
  });

  it("un aviso posterior al último cambio sí se atiende", async () => {
    await atenderEventosDeCuenta([evento({ evento: "ACCOUNT_RESTRICTION", hora: AHORA_MS / 1000 + 60 })], contexto(vencido, AHORA_MS));

    expect(h.wabaEnFalla).toHaveBeenCalledWith(TENANT, "waba_restringida");
  });

  it("una baja anterior a la fecha de la fila igual se confirma con Graph: revocar nunca se descarta por viejo", async () => {
    const revisar = vi.fn().mockResolvedValue({ ok: false, motivo: "token_vencido" });

    await atenderEventosDeCuenta([evento({ hora: AHORA_MS / 1000 - 60 })], contexto(revisar, AHORA_MS));

    expect(revisar).toHaveBeenCalled();
  });

  it.each(["DISABLED_UPDATE", "ACCOUNT_RESTRICTION", "ACCOUNT_VIOLATION"])(
    "%s: deja la WABA en falla con la restricción y avisa al operador",
    async (nombre) => {
      await atenderEventosDeCuenta([evento({ evento: nombre })], contexto(vencido));

      expect(h.wabaEnFalla).toHaveBeenCalledWith(TENANT, "waba_restringida");
      expect(h.aviso).toHaveBeenCalledWith("waba_restringida", TENANT);
      expect(h.wabaRevocada).not.toHaveBeenCalled();
    }
  );

  it("account_review_update REJECTED: es una restricción de la cuenta", async () => {
    await atenderEventosDeCuenta([evento({ campo: "account_review_update", evento: "REJECTED" })], contexto(vencido));

    expect(h.wabaEnFalla).toHaveBeenCalledWith(TENANT, "waba_restringida");
    expect(h.aviso).toHaveBeenCalledWith("waba_restringida", TENANT);
  });

  it.each(["APPROVED", "PENDING", "DEFERRED"])("account_review_update %s: sólo queda en el registro", async (decision) => {
    await atenderEventosDeCuenta([evento({ campo: "account_review_update", evento: decision })], contexto(vencido));

    expect(h.wabaEnFalla).not.toHaveBeenCalled();
    expect(h.aviso).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith(expect.objectContaining({ campo: "account_review_update", evento: decision }), "whatsapp.cuenta_evento");
  });

  it("phone_number_name_update APPROVED: guarda el estado y avanza el alta", async () => {
    await atenderEventosDeCuenta(
      [evento({ campo: "phone_number_name_update", evento: null, phoneNumberId: "777", nombreEstado: "APPROVED" })],
      contexto(vencido)
    );

    expect(h.nombreDelNumero).toHaveBeenCalledWith(WABA, "APPROVED");
    expect(h.nombreAprobado).toHaveBeenCalledWith(TENANT, WABA);
    expect(h.wabaEnFalla).not.toHaveBeenCalled();
  });

  it("phone_number_name_update rechazado: falla con nombre_rechazado y no avanza el alta", async () => {
    await atenderEventosDeCuenta(
      [evento({ campo: "phone_number_name_update", evento: null, phoneNumberId: "777", nombreEstado: "DECLINED" })],
      contexto(vencido)
    );

    expect(h.wabaEnFalla).toHaveBeenCalledWith(TENANT, "nombre_rechazado");
    expect(h.aviso).toHaveBeenCalledWith("nombre_rechazado", TENANT);
    expect(h.nombreAprobado).not.toHaveBeenCalled();
  });

  it("si avanzar el alta falla se anota y no tira", async () => {
    h.nombreAprobado.mockRejectedValue(new Error("neon caído"));

    await expect(
      atenderEventosDeCuenta(
        [evento({ campo: "phone_number_name_update", evento: null, nombreEstado: "APPROVED" })],
        contexto(vencido)
      )
    ).resolves.toBeUndefined();

    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ campo: "phone_number_name_update" }), "whatsapp.cuenta_evento_fallo");
  });
});

describe("Embedded Signup no cambia", () => {
  it("un nombre aprobado guarda el estado pero no avanza ningún alta propia", async () => {
    await atenderEventosDeCuenta([evento({ campo: "phone_number_name_update", evento: null, nombreEstado: "APPROVED" })]);

    expect(h.nombreDelNumero).toHaveBeenCalledWith(WABA, "APPROVED");
    expect(h.nombreAprobado).not.toHaveBeenCalled();
  });

  it("account_review_update REJECTED avisa la restricción sin dejar la WABA en falla", async () => {
    await atenderEventosDeCuenta([evento({ campo: "account_review_update", evento: "REJECTED" })]);

    expect(h.aviso).toHaveBeenCalledWith("cuenta_restringida", TENANT);
    expect(h.wabaEnFalla).not.toHaveBeenCalled();
  });
});

describe("campos que no se suscriben", () => {
  it.each(["business_capability_update", "template_category_update", "message_template_quality_update"] as const)(
    "%s se anota y se deja, sin ninguna lectura",
    async (campo) => {
      await atenderEventosDeCuenta([evento({ campo, evento: "ALGO" })]);

      expect(h.leer).not.toHaveBeenCalled();
      expect(h.aviso).not.toHaveBeenCalled();
      expect(h.wabaRevocada).not.toHaveBeenCalled();
      expect(h.info).toHaveBeenCalledWith({ wabaId: WABA, campo }, "whatsapp.cuenta_campo_ignorado");
    }
  );

  it("mezclados con los que sí, sólo se atienden los que sí", async () => {
    await atenderEventosDeCuenta([
      evento({ campo: "template_category_update", evento: "X" }),
      evento({ evento: "ACCOUNT_RESTRICTION" }),
    ]);

    expect(h.aviso).toHaveBeenCalledTimes(1);
    expect(h.aviso).toHaveBeenCalledWith("cuenta_restringida", TENANT);
  });
});

describe("no tira nunca", () => {
  it("si falla la consulta de arranque lo anota y sigue", async () => {
    h.leer.mockRejectedValue(new Error("42P01"));

    await expect(atenderEventosDeCuenta([evento()])).resolves.toBeUndefined();

    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "whatsapp.cuenta_eventos_fallo");
    expect(h.wabaRevocada).not.toHaveBeenCalled();
  });

  it("sin la 0051 (falta la tabla, 42P01) no hay WABAs propias: termina sin dejar un error por cada evento de la plataforma", async () => {
    h.leer.mockRejectedValue(Object.assign(new Error("relation does not exist"), { code: "42P01" }));

    await expect(atenderEventosDeCuenta([evento()])).resolves.toBeUndefined();

    expect(h.error).not.toHaveBeenCalled();
  });

  it("un código de Postgres que no es la falta de la tabla sí se anota", async () => {
    h.leer.mockRejectedValue(Object.assign(new Error("timeout"), { code: "57014" }));

    await atenderEventosDeCuenta([evento()]);

    expect(h.error).toHaveBeenCalledWith({ error: "Error" }, "whatsapp.cuenta_eventos_fallo");
  });

  it("si falla un evento, el siguiente igual se atiende", async () => {
    h.leer.mockResolvedValue([waba(), waba({ tenantId: "20000000-0000-4000-8000-000000000002", wabaId: "666" })]);
    h.revisarToken.mockRejectedValueOnce(new Error("red"));

    await atenderEventosDeCuenta([evento(), evento({ wabaId: "666" })]);

    expect(h.error).toHaveBeenCalledWith(expect.objectContaining({ error: "Error" }), "whatsapp.cuenta_evento_fallo");
    expect(h.wabaRevocada).toHaveBeenCalledWith("666");
  });

  it("el error que se anota lleva el nombre y no el mensaje (puede traer un token)", async () => {
    h.revisarToken.mockRejectedValue(new Error(`token ${TOKEN} inválido`));

    await atenderEventosDeCuenta([evento()]);

    const anotado = JSON.stringify(h.error.mock.calls);
    expect(anotado).not.toContain(TOKEN);
  });
});
