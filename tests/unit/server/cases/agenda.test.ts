/**
 * La agenda: la ventana de WhatsApp y el cierre por abandono, en un solo
 * viaje, con el titular tapado para quien no puede ver el padrón.
 *
 * Las consultas se arman con un cliente drizzle de verdad —que no se conecta
 * hasta ejecutar— para poder leer su SQL; lo que devuelven es de mentira.
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

const CTX = { tenantId: "tenant-1" };
const AHORA = new Date("2026-09-27T12:00:00.000Z");
const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;
const cliente = drizzle(neon("postgres://u:p@h/db"), { schema });

type Sql = { sql: string; params: unknown[] };
let armadas: Sql[] = [];

/** Arma el lote con el cliente de verdad y contesta lo que se le pase. */
function responder(filas: [unknown[], unknown[]]) {
  enTenantVarias.mockImplementation(async (_ctx, armar: (db: unknown) => Array<{ toSQL(): Sql }>) => {
    armadas = armar(cliente).map((q) => q.toSQL());
    return filas;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  armadas = [];
  delete process.env.CONVERSATION_ABANDON_AFTER_DAYS;
});

afterEach(() => {
  delete process.env.CONVERSATION_ABANDON_AFTER_DAYS;
});

describe("leerAgenda", () => {
  it("va una sola vez a la base, con las dos consultas en el mismo lote", async () => {
    responder([[], []]);

    await leerAgenda(CTX, AHORA, "owner");

    expect(enTenantVarias).toHaveBeenCalledTimes(1);
    expect(enTenantVarias.mock.calls[0]![0]).toBe(CTX);
    expect(armadas).toHaveLength(2);
  });

  it("no filtra por inquilino a mano: eso lo pone la base", async () => {
    responder([[], []]);
    await leerAgenda(CTX, AHORA, "owner");
    for (const q of armadas) expect(q.sql).not.toMatch(/tenant_id/);
  });

  it("sin nada pendiente, la agenda queda vacía", async () => {
    responder([[], []]);
    expect(await leerAgenda(CTX, AHORA, "owner")).toEqual([]);
  });

  it("una ventana vencida no aparece", async () => {
    responder([
      [{ id: "caso-vieja", titular: "Ana", ultimoEntrante: new Date(AHORA.getTime() - 25 * HORA).toISOString() }],
      [],
    ]);

    expect(await leerAgenda(CTX, AHORA, "owner")).toEqual([]);
  });

  it("la ventana viva vence a las 24 h del último entrante", async () => {
    const ultimoEntrante = new Date(AHORA.getTime() - 1 * HORA).toISOString();
    responder([[{ id: "caso-1", titular: "Ana", ultimoEntrante }], []]);

    const [v] = await leerAgenda(CTX, AHORA, "owner");

    expect(v).toMatchObject({ caseId: "caso-1", numero: "SIN-CASO-1", tipo: "ventana_whatsapp" });
    expect(v!.vence).toBe(new Date(new Date(ultimoEntrante).getTime() + 24 * HORA).toISOString());
  });

  it("con CONVERSATION_ABANDON_AFTER_DAYS=14, vence es exactamente updated_at más 14 días", async () => {
    process.env.CONVERSATION_ABANDON_AFTER_DAYS = "14";
    const desde = "2026-09-01T00:00:00.000Z";
    responder([[], [{ id: "caso-2", titular: "Beto", desde }]]);

    const [v] = await leerAgenda(CTX, AHORA, "owner");

    expect(v).toMatchObject({ caseId: "caso-2", tipo: "cierre_por_abandono" });
    expect(v!.vence).toBe(new Date(new Date(desde).getTime() + 14 * DIA).toISOString());
  });

  it("con otro CONVERSATION_ABANDON_AFTER_DAYS, la cuenta lo sigue a él y no a un número fijo", async () => {
    process.env.CONVERSATION_ABANDON_AFTER_DAYS = "5";
    const desde = "2026-09-01T00:00:00.000Z";
    responder([[], [{ id: "caso-2", titular: null, desde }]]);

    const [v] = await leerAgenda(CTX, AHORA, "owner");

    expect(v!.vence).toBe(new Date(new Date(desde).getTime() + 5 * DIA).toISOString());
  });

  it("el titular se tapa con OCULTO para quien no puede ver el padrón", async () => {
    const ultimoEntrante = new Date(AHORA.getTime() - 1 * HORA).toISOString();
    responder([[{ id: "caso-1", titular: "Ana", ultimoEntrante }], []]);
    const [conPii] = await leerAgenda(CTX, AHORA, "owner");

    responder([[{ id: "caso-1", titular: "Ana", ultimoEntrante }], []]);
    const [sinPii] = await leerAgenda(CTX, AHORA, "analyst");

    expect(conPii!.titular).toBe("Ana");
    expect(sinPii!.titular).toBe(OCULTO);
  });

  it("viewer tampoco ve el titular: no es sólo cosa de analyst", async () => {
    const ultimoEntrante = new Date(AHORA.getTime() - 1 * HORA).toISOString();
    responder([[{ id: "caso-1", titular: "Ana", ultimoEntrante }], []]);

    const [v] = await leerAgenda(CTX, AHORA, "viewer");

    expect(v!.titular).toBe(OCULTO);
  });

  it("specialist sí puede verlo: está en CUSTOMER_PII_ROLES", async () => {
    const ultimoEntrante = new Date(AHORA.getTime() - 1 * HORA).toISOString();
    responder([[{ id: "caso-1", titular: "Ana", ultimoEntrante }], []]);

    const [v] = await leerAgenda(CTX, AHORA, "specialist");

    expect(v!.titular).toBe("Ana");
  });

  it("sin nombre cargado, no hay nada que tapar", async () => {
    const ultimoEntrante = new Date(AHORA.getTime() - 1 * HORA).toISOString();
    responder([[{ id: "caso-1", titular: null, ultimoEntrante }], []]);

    const [v] = await leerAgenda(CTX, AHORA, "analyst");

    expect(v!.titular).toBeNull();
  });

  it("ordena por vencimiento ascendente, sin importar el tipo", async () => {
    responder([
      // vence en 23h
      [{ id: "ventana-lejos", titular: null, ultimoEntrante: new Date(AHORA.getTime() - 1 * HORA).toISOString() }],
      // con 14 días por defecto, vence en 1h
      [{ id: "abandono-cerca", titular: null, desde: new Date(AHORA.getTime() - 14 * DIA + 1 * HORA).toISOString() }],
    ]);

    const agenda = await leerAgenda(CTX, AHORA, "owner");

    expect(agenda.map((v) => v.caseId)).toEqual(["abandono-cerca", "ventana-lejos"]);
  });

  describe("el SQL del lote", () => {
    beforeEach(async () => {
      responder([[], []]);
      await leerAgenda(CTX, AHORA, "owner");
    });

    it("la ventana: sólo casos para responder por WhatsApp", () => {
      const [ventana] = armadas;
      expect(ventana!.sql).toMatch(/from "cases"/);
      expect(ventana!.sql).toMatch(/"para_responder_desde" is not null/);
      expect(ventana!.sql).toMatch(/"channel" in/);
      expect(ventana!.params).toContain("whatsapp");
      expect(ventana!.params).toContain("whatsapp_sim");
    });

    it("la ventana: acota en SQL a las últimas 24 h, no sólo en JS", () => {
      // Si no, un tenant con más de 100 ventanas ya vencidas le gana el LIMIT
      // a las vivas y la agenda no llega a verlas.
      const [ventana] = armadas;
      expect(ventana!.params).toContain(new Date(AHORA.getTime() - 24 * HORA).toISOString());
    });

    it("el abandono: los mismos estados y la misma pregunta que el barrido", () => {
      const [, abandono] = armadas;
      expect(abandono!.sql).toMatch(/"status" in/);
      expect(abandono!.params).toContain("info_faltante");
      expect(abandono!.params).toContain("confirmacion_pendiente");
      // La misma subconsulta de close-abandoned.ts, importada y no reescrita.
      expect(abandono!.sql).toMatch(/coalesce\(\(/);
      expect(abandono!.sql).toMatch(/"outbound_messages"/);
    });
  });
});
