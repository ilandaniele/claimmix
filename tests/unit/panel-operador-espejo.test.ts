// @vitest-environment node
/**
 * El panel del operador y el espejo a la base del cliente.
 *
 * Cada cambio sobre `tenants` o `whatsapp_numeros` se escribe en control (el rol
 * dueño) y recién entonces se espeja al inquilino que cambió. Si la copia no entra
 * la acción NO falla: el cambio ya está, y el panel avisa `espejo_pendiente` para
 * que el operador sepa que la base del cliente se pone al día con el barrido.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  orden: [] as string[],
  execute: vi.fn(),
  espejar: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  db: {
    execute: async (...args: unknown[]) => {
      h.orden.push("escribe");
      return h.execute(...args);
    },
  },
}));
vi.mock("@/data/scope", () => ({ enTenant: vi.fn() }));
vi.mock("@/server/alta/crear-inquilino", () => ({ topeGlobalDelDia: () => 20 }));
vi.mock("@/server/bases/espejo", () => ({ espejar: h.espejar }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() },
}));

import { enUSServidor } from "@/lib/i18n/en-US.servidor";
import { esARServidor } from "@/lib/i18n/es-AR.servidor";
import {
  RESULTADOS_DEL_PANEL,
  activarInquilino,
  conectarNumero,
  darDeBajaNumero,
  extenderPrueba,
  reactivarInquilino,
  reactivarNumero,
  resultadoDelPanel,
  suspenderInquilino,
  suspenderNumero,
  terminosDeActivacion,
  type Operador,
} from "@/server/alta/panel-operador";

const dialecto = new PgDialect();
const SAVED = { ...process.env };

const OP: Operador = { userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ip: "203.0.113.9" };
const CLIENTE = "22222222-2222-4222-8222-222222222222";
const PLATAFORMA = "33333333-3333-4333-8333-333333333333";
const NUMERO = "44444444-4444-4444-8444-444444444444";
const ID_PLATAFORMA = "100000000000001";
const WABA = "200000000000001";
const ID_DEL_CLIENTE = "100000000000777";

const filas = (...rows: Array<Record<string, unknown>>) => ({ rows });

/** La copia del cliente no entra: el error lleva una dirección adentro, como el del driver. */
const espejoCaido = () =>
  h.espejar.mockRejectedValue(Object.assign(new Error("falló la fila de ana@example.com"), { code: "08006" }));

/** Un Graph de juguete que confirma el número y su lugar en la WABA. */
function graphConfirma() {
  const respuesta = (cuerpo: unknown) => ({ ok: true, status: 200, json: async () => cuerpo }) as Response;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("/phone_numbers")
        ? respuesta({ data: [{ id: ID_DEL_CLIENTE }] })
        : respuesta({ display_phone_number: "+54 9 11 0000-0000", verified_name: "Seguros Fake" })
    )
  );
}

beforeEach(() => {
  h.orden.length = 0;
  h.execute.mockReset();
  h.warn.mockReset();
  h.espejar.mockReset();
  h.espejar.mockImplementation(async (tenantId: string) => void h.orden.push(`espejar:${tenantId}`));
  process.env.WHATSAPP_ACCESS_TOKEN = "fake-access-token";
  process.env.WHATSAPP_PHONE_NUMBER_ID = ID_PLATAFORMA;
  process.env.WHATSAPP_BUSINESS_ACCOUNT_ID = WABA;
  process.env.WHATSAPP_TENANT_ID = PLATAFORMA;
});

afterEach(() => {
  process.env = { ...SAVED };
  vi.unstubAllGlobals();
});

const ACCIONES = [
  { nombre: "suspenderNumero", correr: () => suspenderNumero(NUMERO, OP) },
  { nombre: "reactivarNumero", correr: () => reactivarNumero(NUMERO, OP) },
  { nombre: "darDeBajaNumero", correr: () => darDeBajaNumero(NUMERO, OP) },
  { nombre: "suspenderInquilino", correr: () => suspenderInquilino(CLIENTE, OP) },
  { nombre: "reactivarInquilino", correr: () => reactivarInquilino(CLIENTE, OP) },
  { nombre: "extenderPrueba", correr: () => extenderPrueba(CLIENTE, 14, OP) },
  { nombre: "activarInquilino", correr: () => activarInquilino(CLIENTE, terminosDeActivacion("piloto")!, OP) },
];

describe.each(ACCIONES)("$nombre", (a) => {
  it("escribe en control y después espeja el inquilino que cambió", async () => {
    h.execute.mockResolvedValue(filas({ n: 1, tenant_id: CLIENTE }));

    expect(await a.correr()).toBe("ok");

    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.orden).toEqual(["escribe", `espejar:${CLIENTE}`]);
  });

  it("la sentencia devuelve también el inquilino, que es lo que se espeja", async () => {
    h.execute.mockResolvedValue(filas({ n: 1, tenant_id: CLIENTE }));

    await a.correr();

    const { sql } = dialecto.sqlToQuery(h.execute.mock.calls[0][0]);
    expect(sql).toContain("min(u.tenant_id::text) as tenant_id");
  });

  it("si la copia no entra responde espejo_pendiente, no un error, y anota sólo el código", async () => {
    espejoCaido();
    h.execute.mockResolvedValue(filas({ n: 1, tenant_id: CLIENTE }));

    expect(await a.correr()).toBe("espejo_pendiente");

    expect(h.warn).toHaveBeenCalledWith({ tenantId: CLIENTE, detalle: "08006" }, "bases.espejo_pendiente");
    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("ana@example.com");
  });

  it("si no cambió ninguna fila no hay nada que espejar", async () => {
    h.execute.mockResolvedValue(filas({ n: 0, tenant_id: null }));

    expect(await a.correr()).toBe("no_aplica");

    expect(h.espejar).not.toHaveBeenCalled();
  });

  it("si la escritura falla no espeja y el error sigue su camino", async () => {
    h.execute.mockRejectedValue(Object.assign(new Error("pg"), { code: "57014" }));

    await expect(a.correr()).rejects.toMatchObject({ code: "57014" });

    expect(h.espejar).not.toHaveBeenCalled();
  });

  it("sin la 0048 es migracion_pendiente y tampoco espeja", async () => {
    h.execute.mockRejectedValue(Object.assign(new Error("pg"), { code: "42P01" }));

    expect(await a.correr()).toBe("migracion_pendiente");

    expect(h.espejar).not.toHaveBeenCalled();
  });
});

describe("conectarNumero", () => {
  const pedir = () =>
    conectarNumero({ numeroId: NUMERO, phoneNumberId: ID_DEL_CLIENTE, wabaId: WABA, pruebaDeControl: true }, OP);

  /** La base: primero el número pedido, y después lo que diga la sentencia que escribe. */
  const base = (resultado: string) => {
    h.execute.mockResolvedValueOnce(filas({ tenant_id: CLIENTE, numero_e164: "+5491100000000" }));
    h.execute.mockResolvedValueOnce(filas({ resultado }));
  };

  it("conecta en control y después espeja el inquilino del número", async () => {
    graphConfirma();
    base("ok");

    expect(await pedir()).toBe("ok");

    expect(h.orden).toEqual(["escribe", "escribe", `espejar:${CLIENTE}`]);
  });

  it("si la copia no entra responde espejo_pendiente: el número ya quedó conectado", async () => {
    espejoCaido();
    graphConfirma();
    base("ok");

    expect(await pedir()).toBe("espejo_pendiente");

    expect(h.warn).toHaveBeenCalledWith({ tenantId: CLIENTE, detalle: "08006" }, "bases.espejo_pendiente");
  });

  it.each(["en_cuarentena", "numero_duplicado", "no_aplica"])("con %s no se escribió nada y no se espeja", async (resultado) => {
    graphConfirma();
    base(resultado);

    expect(await pedir()).toBe(resultado);

    expect(h.espejar).not.toHaveBeenCalled();
  });
});

describe("espejo_pendiente en la pantalla", () => {
  it("está en la lista cerrada que acepta ?r=", () => {
    expect(resultadoDelPanel("espejo_pendiente")).toBe("espejo_pendiente");
    expect(RESULTADOS_DEL_PANEL).toContain("espejo_pendiente");
  });

  it("tiene su mensaje en los dos idiomas", () => {
    expect(esARServidor["altas.r.espejo_pendiente"]).toBeTruthy();
    expect(enUSServidor["altas.r.espejo_pendiente"]).toBeTruthy();
  });
});
