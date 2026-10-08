// @vitest-environment node
/**
 * Una derivación, un evento, un mensaje: contra la base de verdad.
 *
 * `escalate()` puede correr dos veces sobre el mismo caso —dos ramas de la
 * misma vuelta, una vuelta que repite— y `setStatus` acepta que el estado ya
 * sea `requiere_especialista`. Cada pasada dejaba su `claim.specialist_required`
 * y el asegurado leía el mismo aviso dos veces.
 *
 * Acá no hay simulacro del lote: el lock por caso y el NOT EXISTS son SQL, y
 * lo que prueban es cómo se comporta Postgres cuando las dos llegan a la vez.
 * Los unit tests ya prueban lo que el orquestador hace con cada respuesta de la
 * guarda; esto prueba la guarda.
 *
 * Corre en CI contra la base de ensayo, después de `pnpm sembrar`. No borra
 * nada: cada caso es nuevo, así que no necesita limpiar para no pisarse. No se
 * corre en local con INTEGRATION_ENABLED: el .env.local apunta a producción.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { enTenant } from "@/data/scope";
import { auditLog, cases } from "@/lib/db/schema";
import { AuditEvent, filaDeAuditoria } from "@/lib/audit/log";
import { escalate } from "@/server/confirmations/orchestrate";
import type { AgentMessenger } from "@/server/confirmations/messenger";

vi.mock("@/server/notify/specialist-alert", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/notify/specialist-alert")>()),
  alertSpecialists: vi.fn().mockResolvedValue(undefined),
}));

import { alertSpecialists } from "@/server/notify/specialist-alert";

const INQUILINO = "10000000-0000-0000-0000-000000000001";
const CTX = { tenantId: INQUILINO };

async function casoNuevo(): Promise<string> {
  const [fila] = await enTenant(CTX, (db) =>
    db
      .insert(cases)
      .values({ tenant_id: INQUILINO, status: "recibido", channel: "email_sim", claim_type: "choque" })
      .returning({ id: cases.id })
  );
  return fila.id;
}

async function derivaciones(caseId: string): Promise<number> {
  const [fila] = await enTenant(CTX, (db) =>
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.target_type, "case"),
          eq(auditLog.target_id, caseId),
          eq(auditLog.event_type, AuditEvent.SPECIALIST_REQUIRED)
        )
      )
  );
  return fila.n;
}

function derivar(caseId: string, messenger: AgentMessenger) {
  return escalate({
    caseId,
    tenantId: INQUILINO,
    senderEmail: "asegurado@example.com",
    messenger,
    severity: "high",
    claimTypeValue: "choque",
    reason: "severidad high",
  });
}

const mensajeroFalso = () => ({ send: vi.fn<AgentMessenger["send"]>().mockResolvedValue(true) });
const escalaciones = (m: ReturnType<typeof mensajeroFalso>) =>
  m.send.mock.calls.filter((c) => c[0].template === "specialist_escalation");

describe.skipIf(!process.env.INTEGRATION_ENABLED)("una derivación, un evento", () => {
  beforeEach(() => {
    vi.mocked(alertSpecialists).mockClear();
  });

  it("dos derivaciones seguidas del mismo caso dejan un evento y un mensaje", async () => {
    const caseId = await casoNuevo();
    const messenger = mensajeroFalso();

    await derivar(caseId, messenger);
    await derivar(caseId, messenger);

    expect(await derivaciones(caseId)).toBe(1);
    expect(escalaciones(messenger)).toHaveLength(1);
    // El aviso al especialista no depende de la guarda: su idempotencia es
    // `alreadyAlerted`, y la prueba tests/unit/specialist-alert.test.ts.
    expect(alertSpecialists).toHaveBeenCalledTimes(2);
    expect(vi.mocked(alertSpecialists).mock.calls.map((c) => c[0].caseId)).toEqual([caseId, caseId]);
  });

  it("la extracción que el worker anota después de derivar no reinicia el episodio", async () => {
    const caseId = await casoNuevo();
    const messenger = mensajeroFalso();

    await derivar(caseId, messenger);
    // El worker escribe el EXTRACTION_COMPLETE DESPUÉS de orchestrate, con el
    // estado intermedio que calculó antes de derivar.
    await enTenant(CTX, (db) =>
      db.insert(auditLog).values(
        filaDeAuditoria({
          tenant_id: INQUILINO,
          event_type: AuditEvent.EXTRACTION_COMPLETE,
          target_type: "case",
          target_id: caseId,
          payload: { is_claim: true, new_status: "info_faltante" },
        })
      )
    );
    await derivar(caseId, messenger);

    expect(await derivaciones(caseId)).toBe(1);
    expect(escalaciones(messenger)).toHaveLength(1);
  });

  it("dos derivaciones a la vez del mismo caso también", async () => {
    const caseId = await casoNuevo();
    const messenger = mensajeroFalso();

    await Promise.all([derivar(caseId, messenger), derivar(caseId, messenger)]);

    expect(await derivaciones(caseId)).toBe(1);
    expect(escalaciones(messenger)).toHaveLength(1);
    expect(alertSpecialists).toHaveBeenCalledTimes(2);
  });
});
