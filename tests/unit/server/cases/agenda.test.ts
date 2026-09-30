/**
 * La agenda: la ventana de WhatsApp, el cierre por abandono y el plazo del
 * caso (B10), unidos en SQL, paginados y en un solo viaje, con el titular
 * tapado para quien no puede ver el padrón.
 *
 * Las consultas se arman con un cliente drizzle de verdad —que no se conecta
 * hasta ejecutar— para poder leer su SQL; lo que devuelven es de mentira.
 * Por eso el `vence` que se calcula en SQL no se puede ejecutar acá: se
 * comprueba que la cuenta lleve las mismas constantes que la de JS
 * (`vencimientoDeLaVentana`, `getAbandonAfterDays`).
 */

vi.mock("server-only", () => ({}));

const { enTenantVarias } = vi.hoisted(() => ({ enTenantVarias: vi.fn() }));
vi.mock("@/data/scope", () => ({ enTenantVarias }));

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "@/lib/db/schema";
import { leerAgenda } from "@/server/cases/agenda";
import { OCULTO } from "@/server/cases/pii";
import { vencimientoDeLaVentana, VENTANA_WHATSAPP_MS } from "@/core/whatsapp/puede-responder";

const CTX = { tenantId: "tenant-1" };
const AHORA = new Date("2026-09-27T12:00:00.000Z");
const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;
const cliente = drizzle(neon("postgres://u:p@h/db"), { schema });

type Sql = { sql: string; params: unknown[] };
type Fila = { case_id: string; titular: string | null; tipo: string; vence: string };
let armadas: Sql[] = [];

/** Arma el lote con el cliente de verdad y contesta el conteo y las filas que se le pasen. */
function responder(filas: Fila[], total = filas.length) {
  enTenantVarias.mockImplementation(async (_ctx, armar: (db: unknown) => Array<{ toSQL(): Sql }>) => {
    armadas = armar(cliente).map((q) => q.toSQL());
    return [[{ n: total }], filas];
  });
}

const fila = (extra: Partial<Fila> = {}): Fila => ({
  case_id: "caso-1",
  titular: "Ana",
  tipo: "ventana_whatsapp",
  vence: new Date(AHORA.getTime() + HORA).toISOString(),
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  armadas = [];
  delete process.env.CONVERSATION_ABANDON_AFTER_DAYS;
});

afterEach(() => {
  delete process.env.CONVERSATION_ABANDON_AFTER_DAYS;
});

describe("leerAgenda", () => {
  it("va una sola vez a la base, con el conteo y la página en el mismo lote", async () => {
    responder([]);

    await leerAgenda(CTX, AHORA, "owner");

    expect(enTenantVarias).toHaveBeenCalledTimes(1);
    expect(enTenantVarias.mock.calls[0]![0]).toBe(CTX);
    expect(armadas).toHaveLength(2);
    expect(armadas[0]!.sql).toMatch(/^select count\(\*\)::int from \(/);
    expect(armadas[1]!.sql).toMatch(/order by vence, case_id limit \$\d+( offset \$\d+)?$/);
  });

  it("no filtra por inquilino a mano: eso lo pone la base", async () => {
    responder([]);
    await leerAgenda(CTX, AHORA, "owner");
    for (const q of armadas) expect(q.sql).not.toMatch(/tenant_id/);
  });

  it("sin nada pendiente, la agenda queda vacía", async () => {
    responder([]);
    expect(await leerAgenda(CTX, AHORA, "owner")).toEqual({
      data: [],
      meta: { total: 0, page: 1, per_page: 25, pages: 0 },
    });
  });

  it("devuelve las tres clases de vencimiento, con el número y el vence en ISO", async () => {
    const vence = new Date(AHORA.getTime() + 2 * DIA).toISOString();
    responder([
      fila({ case_id: "caso-1", tipo: "ventana_whatsapp" }),
      fila({ case_id: "caso-2", tipo: "cierre_por_abandono" }),
      fila({ case_id: "caso-3", tipo: "plazo", vence }),
    ]);

    const { data } = await leerAgenda(CTX, AHORA, "owner");

    expect(data.map((v) => [v.caseId, v.numero, v.tipo])).toEqual([
      ["caso-1", "SIN-CASO-1", "ventana_whatsapp"],
      ["caso-2", "SIN-CASO-2", "cierre_por_abandono"],
      ["caso-3", "SIN-CASO-3", "plazo"],
    ]);
    expect(data[2]!.vence).toBe(vence);
  });

  it("el vence que devuelve Postgres como texto (sin la T) sale en ISO igual", async () => {
    responder([fila({ tipo: "plazo", vence: "2026-09-30 02:59:59.999+00" })]);

    const { data } = await leerAgenda(CTX, AHORA, "owner");

    expect(data[0]!.vence).toBe("2026-09-30T02:59:59.999Z");
  });

  it("no corta a 100: si la base devuelve más, salen todas", async () => {
    responder(Array.from({ length: 150 }, (_, i) => fila({ case_id: `caso-${i}`, tipo: "plazo" })), 150);

    const { data, meta } = await leerAgenda(CTX, AHORA, "owner", { per_page: 100 });

    expect(data).toHaveLength(150);
    expect(meta.total).toBe(150);
  });

  describe("paginación", () => {
    it("por defecto es la página 1 de 25: LIMIT 25, y drizzle no escribe un OFFSET 0", async () => {
      responder([]);
      await leerAgenda(CTX, AHORA, "owner");
      expect(armadas[1]!.params.at(-1)).toBe(25);
      expect(armadas[1]!.sql).not.toMatch(/offset/);
    });

    it("la página 2 salta per_page filas: OFFSET = per_page", async () => {
      responder([], 60);
      await leerAgenda(CTX, AHORA, "owner", { page: 2, per_page: 25 });
      expect(armadas[1]!.params.slice(-2)).toEqual([25, 25]);
    });

    it("la página 3 de 10 en 10 es OFFSET 20", async () => {
      responder([], 60);
      await leerAgenda(CTX, AHORA, "owner", { page: 3, per_page: 10 });
      expect(armadas[1]!.params.slice(-2)).toEqual([10, 20]);
    });

    it("el total sale del conteo y las páginas se redondean para arriba", async () => {
      responder([fila()], 61);

      const { meta } = await leerAgenda(CTX, AHORA, "owner", { page: 2, per_page: 25 });

      expect(meta).toEqual({ total: 61, page: 2, per_page: 25, pages: 3 });
    });

    it("el conteo cuenta las mismas ramas que la página, sin el limit ni el offset de ella", async () => {
      responder([]);
      await leerAgenda(CTX, AHORA, "owner", { page: 2 });
      const [conteo, pagina] = armadas;
      expect(conteo!.sql).not.toMatch(/offset|limit \$/);
      expect(conteo!.params).toEqual(pagina!.params.slice(0, -2));
    });

    it.each([
      { page: 0 },
      { page: -1 },
      { page: 1001 },
      { page: 1.5 },
      { per_page: 0 },
      { per_page: 101 },
    ])("rechaza %j sin tocar la base", async (entrada) => {
      responder([]);
      await expect(leerAgenda(CTX, AHORA, "owner", entrada)).rejects.toThrow();
      expect(enTenantVarias).not.toHaveBeenCalled();
    });
  });

  describe("el titular", () => {
    it("se tapa con OCULTO para quien no puede ver el padrón", async () => {
      responder([fila()]);
      const { data: conPii } = await leerAgenda(CTX, AHORA, "owner");

      responder([fila()]);
      const { data: sinPii } = await leerAgenda(CTX, AHORA, "analyst");

      expect(conPii[0]!.titular).toBe("Ana");
      expect(sinPii[0]!.titular).toBe(OCULTO);
    });

    it("el analista ve el plazo de un caso, pero no el nombre del titular", async () => {
      responder([fila({ tipo: "plazo", titular: "Ana Pérez" })]);

      const { data } = await leerAgenda(CTX, AHORA, "analyst");

      expect(data[0]).toMatchObject({ tipo: "plazo", titular: OCULTO });
    });

    it("viewer tampoco lo ve: no es sólo cosa de analyst", async () => {
      responder([fila()]);
      const { data } = await leerAgenda(CTX, AHORA, "viewer");
      expect(data[0]!.titular).toBe(OCULTO);
    });

    it("specialist sí puede verlo: está en CUSTOMER_PII_ROLES", async () => {
      responder([fila()]);
      const { data } = await leerAgenda(CTX, AHORA, "specialist");
      expect(data[0]!.titular).toBe("Ana");
    });

    it("sin nombre cargado, no hay nada que tapar", async () => {
      responder([fila({ titular: null })]);
      const { data } = await leerAgenda(CTX, AHORA, "analyst");
      expect(data[0]!.titular).toBeNull();
    });
  });

  describe("el SQL del lote", () => {
    let conteo: Sql;

    beforeEach(async () => {
      responder([]);
      await leerAgenda(CTX, AHORA, "owner");
      conteo = armadas[0]!;
    });

    it("son tres ramas unidas con union all, cada una con case_id, titular, tipo y vence", () => {
      expect(conteo.sql.match(/ union all /g)).toHaveLength(2);
      for (const tipo of ["ventana_whatsapp", "cierre_por_abandono", "plazo"]) {
        expect(conteo.sql).toContain(`'${tipo}' as tipo`);
      }
      expect(conteo.sql.match(/ as case_id/g)).toHaveLength(3);
      expect(conteo.sql.match(/ as titular/g)).toHaveLength(3);
      expect(conteo.sql.match(/ as vence/g)).toHaveLength(3);
    });

    it("la ventana: sólo casos para responder por WhatsApp", () => {
      expect(conteo.sql).toMatch(/"para_responder_desde" is not null/);
      expect(conteo.sql).toMatch(/"channel" in/);
      expect(conteo.params).toContain("whatsapp");
      expect(conteo.params).toContain("whatsapp_sim");
    });

    it("la ventana: acota en SQL a las últimas 24 h", () => {
      expect(conteo.params).toContain(new Date(AHORA.getTime() - 24 * HORA).toISOString());
    });

    it("la ventana: vence es el último entrante más lo mismo que suma vencimientoDeLaVentana", () => {
      const ultimoEntrante = new Date(AHORA.getTime() - HORA).toISOString();
      const enJs = vencimientoDeLaVentana(ultimoEntrante, AHORA)!.getTime() - new Date(ultimoEntrante).getTime();

      expect(conteo.sql).toMatch(/\) \+ make_interval\(secs => \$\d+::float8\) as vence/);
      expect(conteo.params).toContain(enJs / 1000);
      expect(enJs).toBe(VENTANA_WHATSAPP_MS);
    });

    it("el abandono: los mismos estados y la misma pregunta que el barrido", () => {
      expect(conteo.sql).toMatch(/"status" in/);
      expect(conteo.params).toContain("info_faltante");
      expect(conteo.params).toContain("confirmacion_pendiente");
      // La misma subconsulta de close-abandoned.ts, importada y no reescrita.
      expect(conteo.sql).toMatch(/coalesce\(\(/);
      expect(conteo.sql).toMatch(/"outbound_messages"/);
    });

    it("el abandono: vence es updated_at (o created_at) más 14 días por defecto", () => {
      expect(conteo.sql).toMatch(
        /coalesce\("cases"\."updated_at", "cases"\."created_at"\) \+ make_interval\(days => \$\d+::int\) as vence/
      );
      expect(conteo.params).toContain(14);
    });

    it("el plazo: vence_en de los casos que no están cerrados", () => {
      expect(conteo.sql).toMatch(/"cases"\."vence_en" as vence/);
      expect(conteo.sql).toMatch(/"vence_en" is not null/);
      expect(conteo.sql).toMatch(/"cases"\."status" not in \(/);
      for (const cerrado of ["cerrado", "pagado", "rechazado"]) expect(conteo.params).toContain(cerrado);
    });

    it("la página ordena por vence y desempata por case_id, así no se repiten filas entre páginas", () => {
      expect(armadas[1]!.sql).toMatch(/order by vence, case_id limit/);
    });
  });

  describe("con CONVERSATION_ABANDON_AFTER_DAYS", () => {
    it.each([
      ["14", 14],
      ["5", 5],
      ["", 14],
      ["no es un número", 14],
    ])("=%j suma %d días al abandono, no un número fijo", async (valor, dias) => {
      process.env.CONVERSATION_ABANDON_AFTER_DAYS = valor;
      responder([]);

      await leerAgenda(CTX, AHORA, "owner");

      expect(armadas[0]!.params).toContain(dias);
    });
  });
});
