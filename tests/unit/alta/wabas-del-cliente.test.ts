/**
 * Las WABAs de los clientes que lee la revisión nocturna y las altas de la app propia que quedaron a
 * medias, para el recordatorio de las 24 horas.
 *
 * La base es un doble: lo que se prueba es qué se pregunta (sólo `armando`, de la app propia, sin
 * recordatorio previo, las más viejas primero, con tope) y cómo se arma cada fila a partir de lo
 * que la base devuelve, sobre todo cuando viene incompleto.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({ execute: vi.fn(), abrir: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { execute: h.execute } }));
// Qué sobre abre con qué AAD se prueba en su propio test: acá importa a quién se le pide cada uno.
vi.mock("@/server/whatsapp/sobres-del-cliente", () => ({
  abrirSobre: h.abrir,
  aadDelToken: (tenantId: string, wabaId: string) => `token:${tenantId}:${wabaId}`,
  aadDelSecreto: (tenantId: string, appId: string) => `secreto:${tenantId}:${appId}`,
}));

import { sql, type SQL } from "drizzle-orm";
import { leerAltasAMedias, leerWabasDelCliente } from "@/server/alta/wabas-del-cliente";

const dialecto = new PgDialect();

const TENANT = "11111111-1111-4111-8111-111111111111";
const OTRO_TENANT = "22222222-2222-4222-8222-222222222222";
const APP_ID = "500000000000001";
const WABA = "555000111222";
const NUMERO = "109876543210";

const filas = (...rows: Array<Record<string, unknown>>) => ({ rows });
const consulta = () => dialecto.sqlToQuery(h.execute.mock.calls[0][0]);

beforeEach(() => {
  h.execute.mockReset();
});

describe("leerAltasAMedias", () => {
  it("pregunta en una sola consulta por las altas de la app propia que siguen en `armando`, sin recordatorio, las más viejas primero", async () => {
    h.execute.mockResolvedValue(filas());

    expect(await leerAltasAMedias(24, 50)).toEqual([]);

    expect(h.execute).toHaveBeenCalledTimes(1);
    const q = consulta();
    expect(q.sql).toContain("b.origen = 'app_propia'");
    expect(q.sql).toContain("b.estado = 'armando'");
    expect(q.sql).toContain("b.recordatorio_en is null");
    expect(q.sql).toContain("b.actualizado_en < now() - make_interval(hours =>");
    expect(q.sql).toContain("order by b.actualizado_en asc");
    expect(q.sql).toContain("join public.tenants t on t.id = b.tenant_id");
  });

  it("las horas y el tope van por parámetro, nunca pegados al texto", async () => {
    h.execute.mockResolvedValue(filas());

    await leerAltasAMedias(24, 50);

    const q = consulta();
    expect(q.params).toEqual([24, 50]);
    expect(q.sql).toMatch(/\$1::int/);
    expect(q.sql).toMatch(/limit \$2::int/);
  });

  it("no trae nada que sea secreto: ni el secreto de la app, ni el token, ni el PIN, ni la ruta", async () => {
    h.execute.mockResolvedValue(filas());

    await leerAltasAMedias(24, 50);

    const { sql } = consulta();
    for (const columna of ["secreto", "token_cifrado", "pin_cifrado", "ruta"]) expect(sql).not.toContain(columna);
  });

  it("arma cada fila: el espacio, la app, si el webhook está verificado y el correo de contacto", async () => {
    h.execute.mockResolvedValue(
      filas(
        { tenant_id: TENANT, app_id: APP_ID, verificado: true, contact_email: "dueno@example.com" },
        { tenant_id: OTRO_TENANT, app_id: null, verificado: false, contact_email: "otro@example.com" }
      )
    );

    expect(await leerAltasAMedias(24, 50)).toEqual([
      { tenantId: TENANT, appId: APP_ID, webhookVerificado: true, correo: "dueno@example.com", locale: "es-AR" },
      { tenantId: OTRO_TENANT, appId: null, webhookVerificado: false, correo: "otro@example.com", locale: "es-AR" },
    ]);
  });

  it("trae el idioma del dueño en la misma consulta; sin idioma o con uno desconocido, español", async () => {
    h.execute.mockResolvedValue(
      filas(
        { tenant_id: TENANT, verificado: false, contact_email: "a@example.com", locale: "en-US" },
        { tenant_id: OTRO_TENANT, verificado: false, contact_email: "b@example.com", locale: "fr-FR" },
        { tenant_id: "33333333-3333-4333-8333-333333333333", verificado: false, contact_email: "c@example.com", locale: null }
      )
    );

    expect((await leerAltasAMedias(24, 50)).map((a) => a.locale)).toEqual(["en-US", "es-AR", "es-AR"]);

    expect(h.execute).toHaveBeenCalledTimes(1);
    const { sql } = consulta();
    expect(sql).toContain("from public.users u where u.tenant_id = b.tenant_id and u.role = 'owner'");
  });

  it("conserva el orden en que la base devolvió las filas", async () => {
    h.execute.mockResolvedValue(
      filas({ tenant_id: OTRO_TENANT, verificado: false, contact_email: "a@example.com" }, { tenant_id: TENANT, verificado: false, contact_email: "b@example.com" })
    );

    expect((await leerAltasAMedias(24, 50)).map((a) => a.tenantId)).toEqual([OTRO_TENANT, TENANT]);
  });

  it.each([
    ["no hay correo", null],
    ["el correo no es texto", 42],
    ["el correo está vacío", ""],
    ["el correo es sólo espacios", "   "],
  ])("si %s la fila vuelve con el correo en null (para marcarla sin mandar nada)", async (_nombre, correo) => {
    h.execute.mockResolvedValue(filas({ tenant_id: TENANT, app_id: APP_ID, verificado: false, contact_email: correo }));

    expect(await leerAltasAMedias(24, 50)).toEqual([{ tenantId: TENANT, appId: APP_ID, webhookVerificado: false, correo: null, locale: "es-AR" }]);
  });

  it("recorta los bordes del correo", async () => {
    h.execute.mockResolvedValue(filas({ tenant_id: TENANT, app_id: APP_ID, verificado: false, contact_email: "  dueno@example.com \n" }));

    expect((await leerAltasAMedias(24, 50))[0].correo).toBe("dueno@example.com");
  });

  it.each([
    ["no hay app", undefined],
    ["la app no es texto", 500000000000001],
    ["la app es null", null],
  ])("si %s la fila vuelve con appId en null (todavía no cargó la app)", async (_nombre, appId) => {
    h.execute.mockResolvedValue(filas({ tenant_id: TENANT, app_id: appId, verificado: false, contact_email: "dueno@example.com" }));

    expect((await leerAltasAMedias(24, 50))[0].appId).toBeNull();
  });

  it.each([
    ["verdadero", true, true],
    ["falso", false, false],
    ["null", null, false],
    ["la cadena «true»", "true", false],
    ["un 1", 1, false],
    ["ausente", undefined, false],
  ])("«verificado» %s: el webhook sólo cuenta como verificado con un booleano verdadero", async (_nombre, verificado, esperado) => {
    h.execute.mockResolvedValue(filas({ tenant_id: TENANT, app_id: APP_ID, verificado, contact_email: "dueno@example.com" }));

    expect((await leerAltasAMedias(24, 50))[0].webhookVerificado).toBe(esperado);
  });

  it("descarta una fila sin espacio en vez de armarla a medias", async () => {
    h.execute.mockResolvedValue(
      filas(
        { tenant_id: null, app_id: APP_ID, verificado: true, contact_email: "dueno@example.com" },
        { app_id: APP_ID, verificado: true, contact_email: "dueno@example.com" },
        { tenant_id: 7, app_id: APP_ID, verificado: true, contact_email: "dueno@example.com" },
        { tenant_id: TENANT, app_id: APP_ID, verificado: true, contact_email: "dueno@example.com" }
      )
    );

    expect((await leerAltasAMedias(24, 50)).map((a) => a.tenantId)).toEqual([TENANT]);
  });

  it("si la base tira, el error sube: quien llama (`recordarAltasAMedias`) es el que no deja que reviente el cron", async () => {
    h.execute.mockRejectedValue(new Error("sin base"));

    await expect(leerAltasAMedias(24, 50)).rejects.toThrow("sin base");
  });
});

describe("leerWabasDelCliente", () => {
  const fila = (cambios: Record<string, unknown> = {}) => ({
    tenant_id: TENANT,
    waba_id: WABA,
    estado: "conectada",
    origen: "embedded_signup",
    actualizado_en: "2026-10-09T04:00:00Z",
    plantilla_enviada: true,
    falla: null,
    app_id: null,
    app_secreto_cifrado: null,
    token_cifrado: "sobre-token",
    phone_number_id: NUMERO,
    ...cambios,
  });
  const de = (donde = sql`b.estado = 'conectada'`, limite = 50, orden?: SQL) => leerWabasDelCliente(donde, limite, orden);

  beforeEach(() => {
    h.abrir.mockReset();
    h.abrir.mockImplementation((sobre: string) => `abierto(${sobre})`);
  });

  it("pregunta en una sola consulta, con el filtro de quien llama y el tope por parámetro", async () => {
    h.execute.mockResolvedValue(filas());

    expect(await de(sql`b.estado = 'conectada'`, 50)).toEqual([]);

    expect(h.execute).toHaveBeenCalledTimes(1);
    const q = consulta();
    expect(q.sql).toContain("where b.waba_id is not null and b.estado = 'conectada'");
    expect(q.sql).toContain("order by b.actualizado_en asc");
    expect(q.sql).toMatch(/limit \$1::int/);
    expect(q.params).toEqual([50]);
  });

  it("trae el App ID, el secreto cifrado, la falla y el número de la fila, y cruza el número por la WABA", async () => {
    h.execute.mockResolvedValue(filas());

    await de();

    const { sql: texto } = consulta();
    for (const columna of ["b.falla", "b.app_id", "b.app_secreto_cifrado", "n.phone_number_id", "n.token_cifrado"]) {
      expect(texto).toContain(columna);
    }
    expect(texto).toContain("n.waba_id = b.waba_id");
    expect(texto).toContain("n.estado <> 'baja'");
  });

  it("acepta otro orden", async () => {
    h.execute.mockResolvedValue(filas());

    await de(undefined, 10, sql`random()`);

    expect(consulta().sql).toContain("order by random()");
  });

  it("una fila de Embedded Signup: el token abierto con el AAD de su número, sin app ni secreto", async () => {
    h.execute.mockResolvedValue(filas(fila()));

    expect(await de()).toEqual([
      {
        tenantId: TENANT,
        wabaId: WABA,
        estado: "conectada",
        origen: "embedded_signup",
        actualizadoEn: Date.parse("2026-10-09T04:00:00Z"),
        plantillaEnviada: true,
        token: "abierto(sobre-token)",
        falla: null,
        appId: null,
        secreto: null,
        phoneNumberId: NUMERO,
      },
    ]);
    expect(h.abrir).toHaveBeenCalledTimes(1);
    expect(h.abrir).toHaveBeenCalledWith("sobre-token", `token:${TENANT}:${WABA}`);
  });

  it("una fila de la app propia: abre también el secreto, con el AAD del espacio y la app", async () => {
    h.execute.mockResolvedValue(filas(fila({ origen: "app_propia", app_id: APP_ID, app_secreto_cifrado: "sobre-secreto" })));

    const [w] = await de();

    expect(w).toMatchObject({ origen: "app_propia", appId: APP_ID, secreto: "abierto(sobre-secreto)", token: "abierto(sobre-token)" });
    expect(h.abrir).toHaveBeenCalledWith("sobre-secreto", `secreto:${TENANT}:${APP_ID}`);
  });

  it("el secreto no se abre sin App ID: el AAD lo necesita", async () => {
    h.execute.mockResolvedValue(filas(fila({ origen: "app_propia", app_id: null, app_secreto_cifrado: "sobre-secreto" })));

    const [w] = await de();

    expect(w.secreto).toBeNull();
    expect(h.abrir).not.toHaveBeenCalledWith("sobre-secreto", expect.anything());
  });

  it("si el sobre no abre el secreto vuelve en null y la fila se conserva", async () => {
    h.abrir.mockImplementation((sobre: string) => (sobre === "sobre-secreto" ? null : `abierto(${sobre})`));
    h.execute.mockResolvedValue(filas(fila({ origen: "app_propia", app_id: APP_ID, app_secreto_cifrado: "sobre-secreto" })));

    const [w] = await de();

    expect(w.secreto).toBeNull();
    expect(w.token).toBe("abierto(sobre-token)");
  });

  it("una fila en falla trae el motivo; lo que no es texto es null", async () => {
    h.execute.mockResolvedValue(
      filas(fila({ estado: "falla", falla: "nombre_rechazado" }), fila({ tenant_id: OTRO_TENANT, falla: 7 }))
    );

    const r = await de();

    expect(r.map((w) => w.falla)).toEqual(["nombre_rechazado", null]);
  });

  it("sin número en la base (o dado de baja) el token y el número vuelven en null", async () => {
    h.execute.mockResolvedValue(filas(fila({ token_cifrado: null, phone_number_id: null })));

    const [w] = await de();

    expect(w.token).toBeNull();
    expect(w.phoneNumberId).toBeNull();
    expect(h.abrir).not.toHaveBeenCalled();
  });

  it.each([
    ["origen desconocido", "otra"],
    ["sin origen", undefined],
  ])("%s: se trata como Embedded Signup, la vía que ya existía", async (_nombre, origen) => {
    h.execute.mockResolvedValue(filas(fila({ origen })));

    expect((await de())[0].origen).toBe("embedded_signup");
  });

  it("descarta la fila que no trae espacio, WABA o estado en vez de armarla a medias", async () => {
    h.execute.mockResolvedValue(
      filas(fila({ tenant_id: null }), fila({ waba_id: 7 }), fila({ estado: undefined }), fila({ tenant_id: OTRO_TENANT }))
    );

    expect((await de()).map((w) => w.tenantId)).toEqual([OTRO_TENANT]);
  });

  it("si la base tira, el error sube: quien llama decide (42P01 sin la 0051)", async () => {
    h.execute.mockRejectedValue(Object.assign(new Error("relation does not exist"), { code: "42P01" }));

    await expect(de()).rejects.toThrow("relation does not exist");
  });
});
