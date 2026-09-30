// @vitest-environment node
/**
 * La purga diferida de adjuntos (B19): borra de R2 lo que el borrado de un caso
 * dejó anotado en `adjuntos_por_purgar`.
 *
 * Drizzle va de verdad sobre un driver falso (pg-proxy): lo que se afirma es el
 * SQL que saldría hacia la base. R2 es un doble: lo que importa es a quién se le
 * pide borrar, cuántas veces y qué se marca después.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Pendiente = { id: string; tenant_id: string; case_id: string; storage_path: string };

const m = vi.hoisted(() => ({
  consultas: [] as { sql: string; params: unknown[] }[],
  /** Lo que devuelve el SELECT de vencidos. */
  pendientes: [] as Array<{ id: string; tenant_id: string; case_id: string; storage_path: string }>,
  falla: { enElUpdate: false },
  borrarDeR2: vi.fn(),
  auditar: vi.fn(),
  info: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: m.info, warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: m.auditar,
  AuditEvent: { ADJUNTOS_PURGADOS: "adjuntos.purgados" },
}));
vi.mock("@/server/storage/claim-attachments-bucket", () => ({ deleteAttachment: m.borrarDeR2 }));
vi.mock("@/lib/db", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const db = drizzle(async (texto, params) => {
    // El UPDATE se escribe en varias líneas: se compara con los espacios colapsados.
    const sql = texto.replace(/\s+/g, " ").trim();
    m.consultas.push({ sql, params });
    if (sql.startsWith("select")) {
      return { rows: m.pendientes.map((p) => [p.id, p.tenant_id, p.case_id, p.storage_path]) };
    }
    if (m.falla.enElUpdate) throw new Error("falló el update");
    return { rows: [] };
  });
  return { db };
});

import { purgarAdjuntos } from "@/server/storage/purgar-adjuntos";

const T = "aaaaaaaa-0000-0000-0000-00000000000a";
const fila = (n: number, caso = `caso-${n}`): Pendiente => ({
  id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
  tenant_id: T,
  case_id: caso,
  storage_path: `${T}/${caso}/archivo-${n}.pdf`,
});

const seleccion = () => m.consultas.find((c) => c.sql.startsWith("select"))!;
const actualizaciones = () => m.consultas.filter((c) => c.sql.startsWith("update"));
const enUnaHora = () => Date.now() + 60 * 60 * 1000;

beforeEach(() => {
  vi.clearAllMocks();
  m.consultas.length = 0;
  m.pendientes = [];
  m.falla.enElUpdate = false;
  m.borrarDeR2.mockResolvedValue(true);
  m.auditar.mockResolvedValue(undefined);
  process.env.PURGA_ADJUNTOS_MODO = "borrar";
});

afterEach(() => {
  delete process.env.PURGA_ADJUNTOS_MODO;
  vi.useRealTimers();
});

describe("purgarAdjuntos: el interruptor", () => {
  it.each([undefined, "", "apagado", "si", "true", "BORRAR!", "1"])(
    "con PURGA_ADJUNTOS_MODO=%j no consulta la base, ni toca R2, ni audita",
    async (valor) => {
      if (valor === undefined) delete process.env.PURGA_ADJUNTOS_MODO;
      else process.env.PURGA_ADJUNTOS_MODO = valor;

      await expect(purgarAdjuntos({ hasta: enUnaHora() })).resolves.toBeNull();

      expect(m.consultas).toEqual([]);
      expect(m.borrarDeR2).not.toHaveBeenCalled();
      expect(m.auditar).not.toHaveBeenCalled();
    }
  );

  it("`simular` cuenta lo vencido pero no llama a R2, no actualiza y no audita", async () => {
    process.env.PURGA_ADJUNTOS_MODO = "simular";
    m.pendientes = [fila(1), fila(2)];

    const r = await purgarAdjuntos({ hasta: enUnaHora() });

    expect(r).toEqual({ modo: "simular", candidatos: 2, purgados: 0, fallidos: 0 });
    expect(m.borrarDeR2).not.toHaveBeenCalled();
    expect(actualizaciones()).toEqual([]);
    expect(m.consultas).toHaveLength(1);
    expect(m.auditar).not.toHaveBeenCalled();
    expect(m.info).toHaveBeenCalledWith({ candidatos: 2 }, "purga_adjuntos.simulada");
  });

  it("el modo se lee sin distinguir mayúsculas ni espacios", async () => {
    process.env.PURGA_ADJUNTOS_MODO = "  Simular ";

    await expect(purgarAdjuntos({ hasta: enUnaHora() })).resolves.toMatchObject({ modo: "simular" });
  });
});

describe("purgarAdjuntos: qué se elige", () => {
  it("sólo lo vencido, no purgado, con menos de 5 intentos y sin un adjunto vivo con el mismo path", async () => {
    await purgarAdjuntos({ hasta: enUnaHora() });

    const { sql, params } = seleccion();
    expect(sql).toContain('from "adjuntos_por_purgar"');
    expect(sql).toContain('"adjuntos_por_purgar"."purgar_despues" < now()');
    expect(sql).toContain('"adjuntos_por_purgar"."purgado_en" is null');
    expect(sql).toContain('"adjuntos_por_purgar"."intentos" < $');
    expect(params).toContain(5);
    expect(sql).toContain(
      'not exists (select 1 from "claim_attachments" where "claim_attachments"."storage_path" = "adjuntos_por_purgar"."storage_path")'
    );
  });

  it("si el mismo objeto se anotó otra vez, sólo manda la fila MÁS NUEVA: una vieja, cancelada o ya vencida, no gana", async () => {
    // La cola no tiene UNIQUE en el path y la aplicación no puede actualizar una fila:
    // un segundo borrado del mismo objeto agrega otra, y la vieja no puede pisarla.
    await purgarAdjuntos({ hasta: enUnaHora() });

    expect(seleccion().sql).toContain(
      'not exists (select 1 from "adjuntos_por_purgar" "mas_nueva" where ("mas_nueva"."storage_path" = "adjuntos_por_purgar"."storage_path" and "mas_nueva"."encolado_en" > "adjuntos_por_purgar"."encolado_en"))'
    );
  });

  it("una purga cancelada (`purgar_despues` nulo) no entra: la comparación con now() da nulo", async () => {
    await purgarAdjuntos({ hasta: enUnaHora() });

    expect(seleccion().sql).not.toContain("coalesce");
    expect(seleccion().sql).not.toContain("purgar_despues\" is null");
  });

  it("los más viejos primero y con tope de 50 por corrida", async () => {
    await purgarAdjuntos({ hasta: enUnaHora() });

    expect(seleccion().sql).toContain('order by "adjuntos_por_purgar"."purgar_despues" asc limit $');
    expect(seleccion().params).toContain(50);
  });

  it("sólo trae las columnas que usa, y ninguna es el contenido de un archivo", async () => {
    await purgarAdjuntos({ hasta: enUnaHora() });

    const columnas = seleccion().sql.slice("select ".length, seleccion().sql.indexOf(" from "));
    expect(columnas).toBe('"id", "tenant_id", "case_id", "storage_path"');
  });
});

describe("purgarAdjuntos: borrar", () => {
  it("pide borrar a R2 una vez por path, en el orden en que vinieron", async () => {
    m.pendientes = [fila(1), fila(2), fila(3)];

    await purgarAdjuntos({ hasta: enUnaHora() });

    expect(m.borrarDeR2.mock.calls.map((c) => c[0])).toEqual(m.pendientes.map((p) => p.storage_path));
  });

  it("marca todo con UNA sola sentencia UPDATE ... FROM (VALUES ...)", async () => {
    m.pendientes = [fila(1), fila(2), fila(3)];

    await purgarAdjuntos({ hasta: enUnaHora() });

    expect(actualizaciones()).toHaveLength(1);
    const { sql, params } = actualizaciones()[0]!;
    expect(sql).toContain('update "adjuntos_por_purgar" as a set');
    expect(sql).toContain("from (values ($");
    expect(sql).toContain("::uuid, $");
    expect(sql).toContain("from (values ($");
    expect(sql).toContain("::text)");
    expect(sql).toContain("where a.purgado_en is null and (a.id = v.id or (v.ok and a.storage_path = v.storage_path))");
    expect(params.filter((p) => typeof p === "string" && p.startsWith("00000000"))).toEqual(m.pendientes.map((p) => p.id));
  });

  it("lo borrado cierra también las filas viejas del mismo path; lo que falló sólo suma un intento a la suya", async () => {
    m.pendientes = [fila(1), fila(2)];
    m.borrarDeR2.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await purgarAdjuntos({ hasta: enUnaHora() });

    const { sql, params } = actualizaciones()[0]!;
    // El path viaja en la sentencia para poder cerrar a las hermanas, y sólo las cierra `v.ok`.
    expect(params).toContain(m.pendientes[0]!.storage_path);
    expect(params).toContain(m.pendientes[1]!.storage_path);
    expect(sql).toContain("(v.ok and a.storage_path = v.storage_path)");
  });

  it("lo borrado se marca purgado: `purgado_en = now()`, sin tocar los intentos ni dejar error", async () => {
    m.pendientes = [fila(1)];

    const r = await purgarAdjuntos({ hasta: enUnaHora() });

    const { sql, params } = actualizaciones()[0]!;
    expect(sql).toContain("purgado_en = case when v.ok then now() else a.purgado_en end");
    expect(sql).toContain("ultimo_error = case when v.ok then null else");
    expect(params).toContain(true);
    expect(params).not.toContain(false);
    expect(r).toEqual({ modo: "borrar", candidatos: 1, purgados: 1, fallidos: 0 });
  });

  it("que R2 conteste que la clave ya no está cuenta como purgado: `deleteAttachment` da true", async () => {
    // DeleteObject de una clave inexistente contesta 204 en S3 y en R2: el doble lo refleja.
    m.pendientes = [fila(1)];
    m.borrarDeR2.mockResolvedValue(true);

    await expect(purgarAdjuntos({ hasta: enUnaHora() })).resolves.toMatchObject({ purgados: 1, fallidos: 0 });
  });

  it("un fallo suma un intento y deja una causa fija, sin el error del SDK", async () => {
    m.pendientes = [fila(1), fila(2)];
    m.borrarDeR2.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const r = await purgarAdjuntos({ hasta: enUnaHora() });

    const { sql, params } = actualizaciones()[0]!;
    expect(sql).toContain("intentos = case when v.ok then a.intentos else a.intentos + 1 end");
    expect(params).toContain("no se pudo borrar el objeto en R2");
    expect(params).toContain(false);
    expect(params).toContain(true);
    expect(r).toEqual({ modo: "borrar", candidatos: 2, purgados: 1, fallidos: 1 });
  });

  it("si el UPDATE falla el error sube y no se audita un borrado que no quedó marcado", async () => {
    m.pendientes = [fila(1)];
    m.falla.enElUpdate = true;

    await expect(purgarAdjuntos({ hasta: enUnaHora() })).rejects.toThrow(/update/);
    expect(m.auditar).not.toHaveBeenCalled();
  });

  it("sin nada vencido no hay R2, ni UPDATE, ni auditoría", async () => {
    const r = await purgarAdjuntos({ hasta: enUnaHora() });

    expect(r).toEqual({ modo: "borrar", candidatos: 0, purgados: 0, fallidos: 0 });
    expect(m.borrarDeR2).not.toHaveBeenCalled();
    expect(actualizaciones()).toEqual([]);
    expect(m.auditar).not.toHaveBeenCalled();
  });
});

describe("purgarAdjuntos: el reloj", () => {
  it("con `hasta` ya vencido no borra nada ni marca nada", async () => {
    m.pendientes = [fila(1), fila(2)];

    const r = await purgarAdjuntos({ hasta: Date.now() - 1 });

    expect(m.borrarDeR2).not.toHaveBeenCalled();
    expect(actualizaciones()).toEqual([]);
    expect(r).toEqual({ modo: "borrar", candidatos: 2, purgados: 0, fallidos: 0 });
  });

  it("corta al pasar `hasta` y marca sólo lo que alcanzó a borrar", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T04:00:00Z"));
    m.pendientes = [fila(1), fila(2), fila(3)];
    const hasta = Date.now() + 10_000;
    // Cada borrado tarda 6 segundos: el segundo entra, el tercero ya no.
    m.borrarDeR2.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 6_000);
      return true;
    });

    const r = await purgarAdjuntos({ hasta });

    expect(m.borrarDeR2).toHaveBeenCalledTimes(2);
    expect(actualizaciones()[0]!.params.filter((p) => typeof p === "string" && p.startsWith("00000000"))).toEqual([
      m.pendientes[0]!.id,
      m.pendientes[1]!.id,
    ]);
    expect(r).toEqual({ modo: "borrar", candidatos: 3, purgados: 2, fallidos: 0 });
  });
});

describe("purgarAdjuntos: el rastro", () => {
  it("deja un evento por caso, sin actor y con sólo los conteos", async () => {
    m.pendientes = [fila(1, "caso-a"), fila(2, "caso-a"), fila(3, "caso-b")];
    m.borrarDeR2.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await purgarAdjuntos({ hasta: enUnaHora() });

    expect(m.auditar).toHaveBeenCalledTimes(2);
    expect(m.auditar).toHaveBeenCalledWith({
      tenant_id: T,
      actor_id: null,
      event_type: "adjuntos.purgados",
      target_type: "case",
      target_id: "caso-a",
      payload: { purgados: 1, fallidos: 1 },
    });
    expect(m.auditar).toHaveBeenCalledWith({
      tenant_id: T,
      actor_id: null,
      event_type: "adjuntos.purgados",
      target_type: "case",
      target_id: "caso-b",
      payload: { purgados: 1, fallidos: 0 },
    });
  });

  it("ninguna auditoría lleva el path ni el nombre de un archivo", async () => {
    m.pendientes = [fila(1), fila(2)];

    await purgarAdjuntos({ hasta: enUnaHora() });

    const rastro = JSON.stringify(m.auditar.mock.calls);
    expect(rastro).not.toContain("archivo-");
    expect(rastro).not.toContain(".pdf");
    expect(rastro).not.toContain("storage_path");
  });

  it("la auditoría de cada caso lleva el inquilino de SU fila", async () => {
    const otro = "bbbbbbbb-0000-0000-0000-00000000000b";
    m.pendientes = [fila(1, "caso-a"), { ...fila(2, "caso-b"), tenant_id: otro }];

    await purgarAdjuntos({ hasta: enUnaHora() });

    const porCaso = Object.fromEntries(m.auditar.mock.calls.map(([e]) => [e.target_id, e.tenant_id]));
    expect(porCaso).toEqual({ "caso-a": T, "caso-b": otro });
  });
});
