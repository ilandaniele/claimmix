/**
 * Dos mensajes de la misma persona, un solo caso.
 *
 * `createWhatsAppIntake` busca un caso abierto para ese teléfono y, si no hay,
 * crea uno. Son dos transacciones distintas y en el medio hay una ventana:
 *
 *     mensaje A → busca → no hay → crea el caso 1
 *     mensaje B → busca → no hay → crea el caso 2
 *
 * No hace falta nada raro: alguien escribe «choqué» y manda la foto un segundo
 * después. Meta entrega los dos eventos en pedidos separados y no promete orden.
 *
 * Lo que quedaba era la conversación partida en dos casos, y el agente
 * contestándole dos veces por el mismo choque — el lease de extracción
 * serializa las corridas de UN caso, no las de dos.
 *
 * El índice único de la 0029 hace que el segundo insert falle con 23505 en vez
 * de pasar. Esto prueba qué se hace con ese error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockEnTenant, espiaDeArmado } = vi.hoisted(() => ({
  mockEnTenant: vi.fn(),
  espiaDeArmado: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/data/scope", () => ({
  enTenant: mockEnTenant,
  enTenantVarias: vi.fn().mockResolvedValue([[], []]),
}));
vi.mock("@/lib/audit/log", () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
  AuditEvent: { EMAIL_RECEIVED: "email.received" },
}));

import { createWhatsAppIntake } from "@/server/agents/intake-agent";

const TENANT = "11111111-0000-4000-8000-000000000001";
const TELEFONO = "5492916426930";

/**
 * Simula la base por turnos: cada llamada a `enTenant` devuelve lo que diga el
 * guion, y `"choque"` tira el error de clave duplicada que tiraría Postgres.
 */
function guion(pasos: Array<unknown[] | "choque">) {
  let i = 0;
  mockEnTenant.mockImplementation(async (_ctx: unknown, armar: unknown) => {
    espiaDeArmado(armar);
    const paso = pasos[i++] ?? [];
    if (paso === "choque") {
      const e = new Error("duplicate key value violates unique constraint");
      (e as unknown as { code: string }).code = "23505";
      throw e;
    }
    return paso;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("createWhatsAppIntake — dos mensajes a la vez", () => {
  it("el que pierde la carrera se suma al caso del que ganó", async () => {
    guion([
      [],                        // busca un caso abierto: no hay
      "choque",                  // inserta: el otro llegó primero
      [{ id: "caso-del-ganador" }], // busca el recién abierto
      [{ id: "msg-1", duplicado: false }], // guarda el mensaje
    ]);

    const r = await createWhatsAppIntake({ tenantId: TENANT, from: TELEFONO, body: "y la foto" });

    expect(r.caseId).toBe("caso-del-ganador");
    // Y no dice haberlo creado. `created` decide si la auditoría anota
    // `new_case` o `thread_update`, y el que pierde no abrió ningún caso.
    expect(r.created).toBe(false);
  });

  it("sin choque, el caso nuevo es el que se creó", async () => {
    // El control. Si la recuperación se disparara siempre, el camino normal
    // devolvería el id equivocado y este test lo ve.
    guion([
      [],
      [{ id: "caso-nuevo" }],
      [{ id: "msg-1", duplicado: false }],
    ]);

    const r = await createWhatsAppIntake({ tenantId: TENANT, from: TELEFONO, body: "choqué" });

    expect(r.caseId).toBe("caso-nuevo");
    expect(r.created).toBe(true);
  });

  it("un error que NO es de clave duplicada sigue siendo un error", async () => {
    // La recuperación es para la carrera, no para tapar cualquier falla de
    // base: un mensaje que no se guarda tiene que hacer ruido.
    let i = 0;
    mockEnTenant.mockImplementation(async () => {
      if (i++ === 1) {
        const e = new Error("no hay conexión");
        (e as unknown as { code: string }).code = "53300";
        throw e;
      }
      return [];
    });

    await expect(
      createWhatsAppIntake({ tenantId: TENANT, from: TELEFONO, body: "choqué" })
    ).rejects.toThrow(/53300/);
  });
});
