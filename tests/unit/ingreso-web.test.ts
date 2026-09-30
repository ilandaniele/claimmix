/**
 * El ingreso del formulario web (B17): caso + mensaje + auditoría en un solo
 * lote, con el remitente marcado como no verificado, y sin buscar hilos.
 */

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  lotes: [] as { tenantId: string; consultas: { sql: string; params: unknown[] }[] }[],
  falla: null as Error | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", async () => {
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  const db = drizzle(async () => ({ rows: [] }));
  return {
    enTenantVarias: (
      ctx: { tenantId: string },
      armar: (d: unknown) => { toSQL: () => { sql: string; params: unknown[] } }[]
    ) => {
      m.lotes.push({ tenantId: ctx.tenantId, consultas: armar(db).map((q) => q.toSQL()) });
      return m.falla ? Promise.reject(m.falla) : Promise.resolve([]);
    },
  };
});

import { ORIGEN_WEB } from "@/core/email/autenticacion";
import {
  ASUNTO_DE_LA_DENUNCIA_WEB,
  cuerpoDeLaDenuncia,
  huellaDelEnvio,
  ingresarDenunciaWeb,
} from "@/server/web/ingreso";

const TENANT_ID = "10000000-0000-0000-0000-000000000001";
const DENUNCIA = {
  tenantId: TENANT_ID,
  nombre: "Ana Pérez",
  email: "ana@ejemplo.com",
  telefono: "+54 291 555-1234",
  relato: "Me chocaron el auto ayer.",
  envio: "1780000000000.firma-de-la-pagina",
  ip: "203.0.113.7",
};

/** El `provider_message_id` del mensaje del lote número `n`: el que lleva el índice único. */
const idDelMensaje = (n: number) =>
  m.lotes[n]!.consultas[1]!.params.find((p) => typeof p === "string" && p.startsWith("web:"));

beforeEach(() => {
  m.lotes.length = 0;
  m.falla = null;
});

describe("ingresarDenunciaWeb", () => {
  it("abre caso, mensaje y auditoría en un solo lote del inquilino", async () => {
    const { caseId } = (await ingresarDenunciaWeb(DENUNCIA))!;

    expect(caseId).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.lotes).toHaveLength(1);
    expect(m.lotes[0]!.tenantId).toBe(TENANT_ID);
    const [caso, mensaje, auditoria] = m.lotes[0]!.consultas;
    expect(caso!.sql).toMatch(/^insert into "cases"/);
    expect(mensaje!.sql).toMatch(/^insert into "claim_messages"/);
    expect(auditoria!.sql).toMatch(/^insert into "audit_log"/);
  });

  it("el caso nace en el canal web, sin decidir si es un reclamo ni el ramo", async () => {
    const { caseId } = (await ingresarDenunciaWeb(DENUNCIA))!;
    const { params } = m.lotes[0]!.consultas[0]!;
    expect(params).toContain(caseId);
    expect(params).toContain("web");
    expect(params).toContain("recibido");
    expect(params).toContain(TENANT_ID);
  });

  it("el mensaje trae el correo de quien denuncia y lo marca como no verificado", async () => {
    await ingresarDenunciaWeb(DENUNCIA);
    const { params } = m.lotes[0]!.consultas[1]!;
    expect(params).toContain("ana@ejemplo.com");
    expect(params).toContain(ASUNTO_DE_LA_DENUNCIA_WEB);
    expect(params.some((p) => typeof p === "string" && p.includes(ORIGEN_WEB.name))).toBe(true);
    expect(params.some((p) => typeof p === "string" && p.includes("Ana Pérez"))).toBe(true);
  });

  it("dos envíos distintos con el mismo relato abren dos casos", async () => {
    const a = await ingresarDenunciaWeb(DENUNCIA);
    const b = await ingresarDenunciaWeb({ ...DENUNCIA, envio: "otra-carga-de-la-pagina" });
    expect(a!.caseId).not.toBe(b!.caseId);
    expect(idDelMensaje(0)).not.toBe(idDelMensaje(1));
  });

  it("el mismo envío repetido lleva la misma huella en el índice único del mensaje", async () => {
    await ingresarDenunciaWeb(DENUNCIA);
    await ingresarDenunciaWeb({ ...DENUNCIA, email: "ANA@ejemplo.com" });
    const huella = huellaDelEnvio(DENUNCIA);
    expect(idDelMensaje(0)).toBe(`web:${huella}`);
    expect(idDelMensaje(1)).toBe(`web:${huella}`);
  });

  it("un relato o un correo distintos dentro del mismo envío no se confunden con el repetido", () => {
    const base = huellaDelEnvio(DENUNCIA);
    expect(huellaDelEnvio({ ...DENUNCIA, relato: "Otro relato distinto." })).not.toBe(base);
    expect(huellaDelEnvio({ ...DENUNCIA, email: "luis@ejemplo.com" })).not.toBe(base);
  });

  it("si la base rebota por el índice único (doble clic simultáneo) devuelve null y no falla", async () => {
    m.falla = Object.assign(new Error("duplicate key"), { code: "23505" });
    await expect(ingresarDenunciaWeb(DENUNCIA)).resolves.toBeNull();
  });

  it("el 23505 puede venir en la causa del error, como lo entrega el driver", async () => {
    m.falla = Object.assign(new Error("failed query"), { cause: { code: "23505" } });
    await expect(ingresarDenunciaWeb(DENUNCIA)).resolves.toBeNull();
  });

  it("cualquier otra falla se propaga", async () => {
    m.falla = Object.assign(new Error("se cayó la base"), { code: "08006" });
    await expect(ingresarDenunciaWeb(DENUNCIA)).rejects.toThrow("se cayó la base");
  });

  it("no mira hilos ni casos existentes", () => {
    const fuente = readFileSync("src/server/web/ingreso.ts", "utf8");
    expect(fuente).not.toMatch(/threadLookup|thread-lookup/);
  });
});

describe("cuerpoDeLaDenuncia", () => {
  it("lleva nombre, correo, teléfono y relato", () => {
    const cuerpo = cuerpoDeLaDenuncia(DENUNCIA);
    expect(cuerpo).toContain("Nombre: Ana Pérez");
    expect(cuerpo).toContain("Correo: ana@ejemplo.com");
    expect(cuerpo).toContain("Teléfono: +54 291 555-1234");
    expect(cuerpo.endsWith("Me chocaron el auto ayer.")).toBe(true);
  });

  it("sin teléfono no deja la línea", () => {
    expect(cuerpoDeLaDenuncia({ ...DENUNCIA, telefono: null })).not.toContain("Teléfono");
  });
});
