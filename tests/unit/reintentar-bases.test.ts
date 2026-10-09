/**
 * Los reintentos de las bases de cliente (P10).
 *
 * Se sustituye lo que habla con Neon (`db`, el dueño contra control) y `iniciarBase`,
 * que registra la fila y lanza el workflow. Lo que se prueba es lo que importa sin
 * una base de verdad: que una sola consulta busque las tres maneras de quedar a
 * medias —sin fila, fallida con intentos, creando con el lease vencido— desde
 * `tenants` con un `LEFT JOIN`, que cada inquilino encontrado vuelva a arrancar, y
 * que nada de lo que falle tire el cron. Que el SQL ande contra Postgres no lo prueba
 * este archivo.
 */

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** La lectura a control: `db.execute`. */
  leer: vi.fn(),
  iniciar: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { execute: h.leer } }));
vi.mock("@/server/bases/iniciar", () => ({ iniciarBase: h.iniciar }));
vi.mock("@/lib/observability/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: h.warn, error: vi.fn() },
}));

import { MINUTOS_PARA_REINTENTAR } from "@/server/bases/espera";
import { reintentarBases } from "@/server/bases/reintentar";

const dialecto = new PgDialect();
const SAVED = process.env.BASE_POR_CLIENTE;

const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTRO = "11111111-2222-3333-4444-555555555555";
const TERCERO = "99999999-8888-7777-6666-555555555555";

/** Los inquilinos que devuelve la consulta de control. */
function conPendientes(...ids: string[]) {
  h.leer.mockResolvedValue({ rows: ids.map((tenant_id) => ({ tenant_id })) });
}

const consulta = () => dialecto.sqlToQuery(h.leer.mock.calls[0]![0] as SQL);

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BASE_POR_CLIENTE = "1";
  h.iniciar.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  if (SAVED === undefined) delete process.env.BASE_POR_CLIENTE;
  else process.env.BASE_POR_CLIENTE = SAVED;
});

describe("reintentarBases", () => {
  it("con el flag apagado no hace nada: ni consulta ni arranca", async () => {
    delete process.env.BASE_POR_CLIENTE;

    await expect(reintentarBases(Date.now() + 60_000)).resolves.toEqual({ lanzadas: 0 });

    expect(h.leer).not.toHaveBeenCalled();
    expect(h.iniciar).not.toHaveBeenCalled();
  });

  it("busca desde `tenants` con un LEFT JOIN: el inquilino sin fila en `tenant_bases` también entra", async () => {
    conPendientes();

    await reintentarBases(Date.now() + 60_000);

    expect(h.leer).toHaveBeenCalledOnce();
    const { sql } = consulta();
    expect(sql).toContain("from public.tenants t");
    expect(sql).toContain("left join public.tenant_bases b on b.tenant_id = t.id");
    expect(sql).toContain("b.tenant_id is null");
  });

  it("toma las fallidas con intentos por gastar y las que están creando con el lease vencido", async () => {
    conPendientes();

    await reintentarBases(Date.now() + 60_000);

    const { sql, params } = consulta();
    expect(sql).toContain("b.estado = 'fallida' and b.intentos < $1::int");
    expect(sql).toContain("b.estado = 'creando'");
    // Sin lease (la fila recién registrada) cuenta desde que se creó, no como vencida desde siempre.
    expect(sql).toContain("coalesce(b.tomada_at, b.creada_at) < now() - make_interval(mins => $2::int)");
    expect(params).toEqual([5, MINUTOS_PARA_REINTENTAR, 20]);
  });

  it("no mira las `lista` ni las `borrada`: sólo las tres condiciones", async () => {
    conPendientes();

    await reintentarBases(Date.now() + 60_000);

    const { sql } = consulta();
    expect(sql).not.toContain("'lista'");
    expect(sql).not.toContain("'borrada'");
    expect(sql).toContain("limit $3::int");
  });

  it("vuelve a arrancar cada inquilino que encontró, de a uno, y cuenta las lanzadas", async () => {
    conPendientes(TENANT, OTRO, TERCERO);

    await expect(reintentarBases(Date.now() + 60_000)).resolves.toEqual({ lanzadas: 3 });

    expect(h.iniciar.mock.calls).toEqual([[TENANT], [OTRO], [TERCERO]]);
  });

  it("sin nada a medias no arranca nada", async () => {
    conPendientes();

    await expect(reintentarBases(Date.now() + 60_000)).resolves.toEqual({ lanzadas: 0 });

    expect(h.iniciar).not.toHaveBeenCalled();
  });

  it("corta en `hasta`: las que no alcanzó salen en la próxima corrida", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    conPendientes(TENANT, OTRO, TERCERO);
    // La primera consume todo el tiempo que había.
    h.iniciar.mockImplementationOnce(async () => {
      vi.setSystemTime(61_000);
    });

    await expect(reintentarBases(60_000)).resolves.toEqual({ lanzadas: 1 });

    expect(h.iniciar).toHaveBeenCalledTimes(1);
  });

  it("con `hasta` vencido no arranca ninguna", async () => {
    conPendientes(TENANT);

    await expect(reintentarBases(Date.now() - 1)).resolves.toEqual({ lanzadas: 0 });

    expect(h.iniciar).not.toHaveBeenCalled();
  });

  it("si una no arranca la cuenta en el log, no la suma y sigue con las demás", async () => {
    conPendientes(TENANT, OTRO, TERCERO);
    h.iniciar
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error("falló"), { code: "57P01" }))
      .mockResolvedValueOnce(undefined);

    await expect(reintentarBases(Date.now() + 60_000)).resolves.toEqual({ lanzadas: 2 });

    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith({ tenantId: OTRO, detalle: "57P01" }, "bases.reintento_fallo");
  });

  it("no deja correos en el log: sólo el código del error", async () => {
    conPendientes(TENANT);
    h.iniciar.mockRejectedValue(
      Object.assign(new Error('Failed query: insert … params: [{"email":"ana@example.com"}]'), { code: "23505" })
    );

    await reintentarBases(Date.now() + 60_000);

    expect(JSON.stringify(h.warn.mock.calls)).not.toContain("ana@example.com");
  });

  it("si no puede leer control devuelve cero y no tira", async () => {
    h.leer.mockRejectedValue(Object.assign(new Error("se cayó"), { code: "08006" }));

    await expect(reintentarBases(Date.now() + 60_000)).resolves.toEqual({ lanzadas: 0 });

    expect(h.iniciar).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith({ detalle: "08006" }, "bases.reintento_sin_lista");
  });
});
