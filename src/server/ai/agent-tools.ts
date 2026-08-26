/**
 * What the agent can go and find out for itself.
 *
 * Until now it could only talk. Everything it knew arrived in the prompt,
 * assembled by code that decided in advance what might be relevant — so when a
 * claimant wrote "soy Roberto Paz, DNI 25.888.101" the only possible next move
 * was to ask for a policy number that is sitting in our own database under
 * that DNI. An agent that cannot look anything up is a very well-spoken form.
 *
 * Every tool here is read-only, and that is the whole safety argument rather
 * than an accident of what was easy. The agent can find things out; it cannot
 * change anything. Every side effect — escalating, asking, closing, writing a
 * note — still travels through the plan it returns, which is validated in one
 * place before anything happens. So a model that reasons badly wastes a
 * lookup; it cannot act badly.
 *
 * The second rule is about what comes back. A policy number is guessable and a
 * DNI is not secret, so a lookup keyed on either must never return somebody
 * else's details. `verificar_poliza` confirms a policy exists and is in force
 * without naming who holds it, and only describes the insured vehicle once the
 * DNI given matches the one on file. Getting this wrong would turn the claims
 * line into a lookup service for anyone with a plausible policy number.
 */

import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { customers, insuredAssets, policies } from "@/lib/db/schema";

export interface ToolContext {
  tenantId: string;
  caseId: string;
}

export interface AgentTool {
  name: string;
  /** Shown to the model. Says what it answers and when it is worth calling. */
  description: string;
  /** Argument names and what they mean, for the prompt. */
  args: Record<string, string>;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

/** Digits only: people write 30.145.882, 30145882, and "DNI 30 145 882". */
function normalizeDni(raw: string): string {
  return raw.replace(/\D/g, "");
}

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Policy numbers are typed by people: spacing and case vary, the rest does not. */
function normalizePolicyNumber(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

/**
 * Does this insurer have a book of business loaded at all?
 *
 * "That policy does not exist" and "we have not been given any policies yet"
 * look identical to a query and mean opposite things to the agent. A tenant
 * mid-onboarding — which every pilot is on day one — has an empty `policies`
 * table, so every lookup would come back as a policy that does not exist, the
 * agent would correctly treat each one as something a person should look at,
 * and the first morning of the pilot would escalate every claim that arrived.
 *
 * Only asked when a lookup finds nothing, so it costs a count on the miss and
 * nothing on the hit.
 */
async function hasPolicyData(tenantId: string): Promise<boolean> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const [row] = await enTenant(tenantCtx, (db) =>
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(policies)
      
  );
  return (row?.n ?? 0) > 0;
}

/** The answer when there is nothing to look in. */
const NO_BOOK = {
  sin_datos: true,
  nota:
    "Esta aseguradora todavía no cargó su padrón de pólizas, así que no se " +
    "puede verificar nada. No trates esto como una póliza inexistente ni " +
    "derives el caso por eso.",
} as const;

// ── verificar_poliza ─────────────────────────────────────────────────────────

const verificarPoliza: AgentTool = {
  name: "verificar_poliza",
  description:
    "Confirma si un número de póliza existe y está vigente. Si además pasás el " +
    "DNI, dice si coincide con el titular y, sólo en ese caso, qué vehículo " +
    "está asegurado. Usalo apenas alguien te da un número de póliza: si está " +
    "vencida o no existe, pedirle documentación no sirve de nada.",
  args: {
    numero_poliza: "El número tal como lo escribió la persona.",
    dni: "El DNI que dijo, si lo dijo. Opcional.",
  },

  async run(args, ctx) {
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    const tenantCtx: TenantContext = { tenantId: ctx.tenantId };
    const raw = str(args, "numero_poliza");
    if (!raw) return { error: "falta numero_poliza" };

    const number = normalizePolicyNumber(raw);

    const rows = await enTenant(tenantCtx, (db) =>
      db
        .select({
          id: policies.id,
          status: policies.status,
          type: policies.policy_type,
          endDate: policies.end_date,
          holderDni: customers.dni,
        })
        .from(policies)
        .leftJoin(customers, eq(policies.customer_id, customers.id))
        .where(
          and(
            sql`upper(replace(${policies.policy_number}, ' ', '')) = ${number}`
          )
        )
        .limit(1)
    );

    const policy = rows[0];
    if (!policy) {
      if (!(await hasPolicyData(ctx.tenantId))) return NO_BOOK;
      return {
        existe: false,
        // Said plainly so the agent does not invent a reason. A number that
        // does not exist is usually a typo, occasionally another insurer's.
        nota: "No hay ninguna póliza con ese número en esta aseguradora.",
      };
    }

    const expired =
      policy.status !== "active" ||
      (policy.endDate !== null && policy.endDate < today());

    const givenDni = str(args, "dni");
    const dniMatches =
      givenDni && policy.holderDni
        ? normalizeDni(givenDni) === normalizeDni(policy.holderDni)
        : null;

    // The insured vehicle is only described to someone who proved they are the
    // holder. A policy number is guessable; this is the line between a claims
    // line and a lookup service.
    const vehicles =
      dniMatches === true ? await vehiclesFor(policy.id, ctx.tenantId) : undefined;

    return {
      existe: true,
      vigente: !expired,
      vencio_el: expired ? policy.endDate : undefined,
      tipo: policy.type,
      titular_coincide: dniMatches,
      vehiculos: vehicles,
    };
  },
};

async function vehiclesFor(policyId: string, tenantId: string): Promise<string[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const rows = await enTenant(tenantCtx, (db) =>
    db
      .select({
        make: insuredAssets.make,
        model: insuredAssets.model,
        year: insuredAssets.year,
        plate: insuredAssets.plate,
      })
      .from(insuredAssets)
      .where(
        eq(insuredAssets.policy_id, policyId)
      )
  );

  return rows
    .map((r) =>
      [r.make, r.model, r.year, r.plate ? `patente ${r.plate}` : null]
        .filter(Boolean)
        .join(" ")
        .trim()
    )
    .filter((s) => s.length > 0);
}

// ── polizas_por_dni ──────────────────────────────────────────────────────────

const polizasPorDni: AgentTool = {
  name: "polizas_por_dni",
  description:
    "Busca las pólizas de una persona por su DNI. Usalo cuando te dieron el " +
    "DNI pero no el número de póliza: no tiene sentido pedirle un dato que " +
    "está en nuestra propia base.",
  args: { dni: "El DNI de la persona, como lo escribió." },

  async run(args, ctx) {
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    const tenantCtx: TenantContext = { tenantId: ctx.tenantId };
    const given = str(args, "dni");
    if (!given) return { error: "falta dni" };

    const dni = normalizeDni(given);
    if (!dni) return { error: "el DNI no tiene un formato reconocible" };

    const rows = await enTenant(tenantCtx, (db) =>
      db
        .select({
          number: policies.policy_number,
          status: policies.status,
          type: policies.policy_type,
          endDate: policies.end_date,
        })
        .from(policies)
        .innerJoin(customers, eq(policies.customer_id, customers.id))
        .where(
          and(
            sql`regexp_replace(coalesce(${customers.dni}, ''), '[^0-9]', '', 'g') = ${dni}`
          )
        )
        .limit(10)
    );

    if (rows.length === 0) {
      if (!(await hasPolicyData(ctx.tenantId))) return NO_BOOK;
      return {
        encontradas: 0,
        // An honest distinction the agent needs: we may simply not have them
        // on file, which is not the same as the DNI being wrong.
        nota: "Ese DNI no figura como titular de ninguna póliza acá.",
      };
    }

    return {
      encontradas: rows.length,
      polizas: rows.map((r) => ({
        numero: r.number,
        tipo: r.type,
        vigente: r.status === "active" && (r.endDate === null || r.endDate >= today()),
      })),
    };
  },
};

// ── historial_del_caso ───────────────────────────────────────────────────────

const historialDelCaso: AgentTool = {
  name: "historial_del_caso",
  description:
    "Muestra lo que ya sabemos de este caso: los datos cargados con su nivel " +
    "de certeza, y los documentos pedidos con su estado. Usalo cuando dudes " +
    "si algo ya lo tenemos o si la persona ya lo mandó.",
  args: {},

  async run(_args, ctx) {
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    const tenantCtx: TenantContext = { tenantId: ctx.tenantId };
    const { extractedFields, missingDocs } = await import("@/lib/db/schema");

    const fields = await enTenant(tenantCtx, (db) =>
      db
        .select({
          key: extractedFields.field_key,
          value: extractedFields.field_value,
          confidence: extractedFields.confidence,
        })
        .from(extractedFields)
        .where(
          eq(extractedFields.case_id, ctx.caseId)
        )
    );

    const docs = await enTenant(tenantCtx, (db) =>
      db
        .select({
          key: missingDocs.doc_key,
          satisfied: missingDocs.satisfied_at,
          declined: missingDocs.declined_at,
        })
        .from(missingDocs)
        .where(
          eq(missingDocs.case_id, ctx.caseId)
        )
    );

    return {
      datos: fields.map((f) => ({
        campo: f.key,
        valor: f.value,
        certeza: Number(f.confidence),
      })),
      documentos: docs.map((d) => ({
        documento: d.key,
        estado: d.satisfied ? "recibido" : d.declined ? "no lo tienen" : "pendiente",
      })),
    };
  },
};

// ── The registry ─────────────────────────────────────────────────────────────

export const AGENT_TOOLS: AgentTool[] = [
  verificarPoliza,
  polizasPorDni,
  historialDelCaso,
];

const BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.name, t]));

/**
 * Run one tool call.
 *
 * Never throws. A tool that fails answers with an error the agent can read and
 * work around — the alternative is losing the whole deliberation, and with it
 * the reply, over a database hiccup during a lookup that was optional anyway.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<unknown> {
  const tool = BY_NAME.get(name);
  if (!tool) return { error: `no existe una herramienta llamada "${name}"` };

  try {
    return await tool.run(args, ctx);
  } catch (err) {
    const code =
      (err as { code?: string })?.code ??
      (err instanceof Error ? err.name : "UnknownError");
    console.error("[agent-tools] failed:", name, code);
    return { error: "la consulta falló, seguí sin este dato" };
  }
}

/** The tool menu, as the prompt presents it. */
export function describeTools(): string {
  return AGENT_TOOLS.map((t) => {
    const args = Object.entries(t.args)
      .map(([name, what]) => `      ${name}: ${what}`)
      .join("\n");
    return `- ${t.name}\n    ${t.description}\n    argumentos:\n${args || "      (ninguno)"}`;
  }).join("\n\n");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
