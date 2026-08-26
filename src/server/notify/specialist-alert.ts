/**
 * Telling a person that a case is waiting for them.
 *
 * The escalation message promises the claimant that "un especialista se va a
 * comunicar con vos a la brevedad", and nothing on our side made that true.
 * The case changed status and sat in the inbox until somebody happened to
 * look. For a fire reported at midnight that is not a queue, it is a hope.
 *
 * Deliberately separate from the claimant conversation. This does not go
 * through dispatchOutboundEmail: that writes claim_messages and threads into
 * the claimant's own exchange, and an internal alert must never appear there —
 * nor risk being sent to them by a mistake in the recipient.
 *
 * Never throws. A claim that escalated correctly must not be undone because
 * the mail server was down; the audit log records whether anyone was told.
 */

import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { enTenant, type TenantContext } from "@/data/scope";
import { authUsers, cases, users } from "@/lib/db/schema";
import { getGmailAccountForTenant } from "@/server/email/gmail/accounts";
import { GmailSender } from "@/server/email/gmail/gmail-sender";
import { isSendSuccess } from "@/server/email/provider";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

/**
 * Quién se entera, y en qué orden.
 *
 *   1. `SPECIALIST_ALERT_EMAILS`, si está. Una lista explícita gana sobre
 *      cualquier deducción: es la única forma de decir "a estas direcciones y
 *      a ninguna otra" sin tener que tocarle el rol a nadie.
 *   2. Los usuarios con rol `specialist`. El caso está dirigido a ellos.
 *   3. UN owner, y no todos los admins.
 *
 * El tercer punto cambió después de que pasara. El respaldo eran `owner` Y
 * `admin`, con el argumento de que un aviso de más es mejor que un siniestro
 * que nadie mira. El argumento sigue siendo cierto y la implementación no:
 * ninguna aseguradora tenía usuarios `specialist`, así que TODAS las alertas
 * caían al respaldo, y el resumen de cada siniestro —con el enlace al caso, que
 * abre todo— se repartía a las cuatro direcciones con rol de admin. Entre ellas,
 * cuentas personales de Gmail que nadie eligió para eso.
 *
 * "Mejor de más que ninguno" justifica UN destinatario, no una lista que crece
 * cada vez que alguien suma un admin. Y avisa en los registros, para que la
 * ausencia de especialistas se note en vez de convertirse en la normalidad.
 */
type TenantRole = "owner" | "admin" | "specialist" | "analyst" | "viewer";

const PREFERRED_ROLES: TenantRole[] = ["specialist"];
const FALLBACK_ROLES: TenantRole[] = ["owner"];

/** La lista explícita, si el despliegue la fijó. */
function listaExplicita(): string[] {
  return (process.env.SPECIALIST_ALERT_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.includes("@"));
}

export interface SpecialistAlertInput {
  caseId: string;
  tenantId: string;
  severity: string | null | undefined;
  claimTypeLabel?: string | null;
  /** One line of what happened, already scrubbed of PII by extraction. */
  summary?: string | null;
}

/**
 * Is this case a simulation?
 *
 * Read here rather than passed in, deliberately. A batch simulation escalated
 * thirty-five invented claims in four minutes and seventeen real emails
 * reached a real inbox — "[Urgente] Siniestro de incendio derivado a
 * especialista", seventeen times, about fires that never happened.
 *
 * The rest of the product already knows not to do this: the messenger refuses
 * to WhatsApp an invented number, the dispatcher refuses to email an
 * @example.com address. This was the one path that had never been told, and it
 * is the one that reaches a person directly. Asking the database means no
 * caller can forget to mention it, which is precisely how it went wrong.
 *
 * On failure: treated as simulated. A missed alert on a real claim shows up as
 * a case sitting in `requiere_especialista` that someone will find; a flood of
 * urgent emails about fires that did not happen is how an insurer stops
 * trusting the product.
 */
async function isSimulatedCase(tenantId: string, caseId: string): Promise<boolean> {
  try {
    const rows = await enTenant({ tenantId }, (db) =>
      db
        .select({ channel: cases.channel })
        .from(cases)
        .where(eq(cases.id, caseId))
        .limit(1)
    );
    const channel = rows[0]?.channel;
    return channel === "email_sim" || channel === "whatsapp_sim";
  } catch {
    return true;
  }
}

async function recipientsFor(tenantId: string): Promise<string[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId: tenantId };
  const byRoles = async (roles: TenantRole[]) => {
    const rows = await enTenant(tenantCtx, (db) =>
      db
        .select({ email: authUsers.email })
        .from(users)
        .innerJoin(authUsers, eq(authUsers.id, users.id))
        .where(and( inArray(users.role, roles)))
    );
    return rows.map((r) => r.email).filter(Boolean);
  };

  const explicita = listaExplicita();
  if (explicita.length > 0) return explicita;

  const specialists = await byRoles(PREFERRED_ROLES);
  if (specialists.length > 0) return specialists;

  // Sin especialistas: UNO solo, y que se sepa.
  const respaldo = (await byRoles(FALLBACK_ROLES)).slice(0, 1);
  console.warn(
    JSON.stringify({
      level: "warn",
      service: "claimmix",
      msg: "specialist_alert.sin_especialistas",
      tenant_id: tenantId,
      // Cuántos, no quiénes: es un registro, y una dirección es un dato personal.
      destinatarios_de_respaldo: respaldo.length,
      nota: "Nadie tiene rol specialist. El aviso va a un owner. Asigná el rol, o fijá SPECIALIST_ALERT_EMAILS.",
    })
  );
  return respaldo;
}

function renderAlert(input: SpecialistAlertInput, caseUrl: string) {
  const kind = input.claimTypeLabel ? ` de ${input.claimTypeLabel}` : "";
  const subject = `[Urgente] Siniestro${kind} derivado a especialista`;

  const lines = [
    `Un siniestro${kind} fue clasificado como severidad ${input.severity ?? "alta"} y derivado a un especialista.`,
    "",
    input.summary ? `Resumen: ${input.summary}` : "",
    `Caso: ${input.caseId}`,
    caseUrl ? `Abrir: ${caseUrl}` : "",
    "",
    "Al denunciante ya se le avisó que un especialista se va a comunicar a la brevedad.",
    "No se le pidió ninguna documentación: pedila vos en el contacto.",
  ].filter(Boolean);

  return { subject, text: lines.join("\n") };
}

/**
 * Alert the tenant's specialists that a case escalated.
 *
 * Idempotent per case: the audit log is checked first, so a re-extraction that
 * escalates again does not re-alert. Somebody is already looking.
 */
export async function alertSpecialists(input: SpecialistAlertInput): Promise<void> {
  const { caseId, tenantId } = input;
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  // Este contexto es lo único que le dice de quién son los datos.
  const tenantCtx: TenantContext = { tenantId: tenantId };

  try {
    if (await isSimulatedCase(input.tenantId, caseId)) {
      // Logged rather than passed over: an operator watching a rehearsal
      // should be able to see the alert was deliberately withheld, not
      // wonder whether it silently failed.
      console.info(
        JSON.stringify({
          level: "info",
          service: "claimmix",
          msg: "specialist_alert.skipped_simulated",
          case_id: caseId,
        })
      );
      return;
    }

    if (await alreadyAlerted(caseId, tenantId)) return;

    const recipients = await recipientsFor(tenantId);
    if (recipients.length === 0) {
      // Worth an error, not a shrug: the promise made to the claimant has no
      // owner, and the only way to find that out is to look for this line.
      console.error(
        JSON.stringify({
          level: "error",
          service: "claimmix",
          msg: "specialist_alert.no_recipients",
          case_id: caseId,
          tenant_id: tenantId,
        })
      );
      return;
    }

    const account = await getGmailAccountForTenant(tenantId);
    if (!account) {
      console.error(
        JSON.stringify({
          level: "error",
          service: "claimmix",
          msg: "specialist_alert.no_mailbox",
          case_id: caseId,
        })
      );
      return;
    }

    const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";
    const { subject, text } = renderAlert(input, base ? `${base}/casos/${caseId}` : "");

    const sender = new GmailSender(account.refreshToken);
    const result = await sender.send({
      to: recipients.join(", "),
      from: account.email,
      subject,
      textBody: text,
    });

    const delivered = isSendSuccess(result);

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.SPECIALIST_ALERTED,
      target_type: "case",
      target_id: caseId,
      // Recipient count, not addresses: an audit trail should prove someone
      // was told without becoming a list of staff emails.
      payload: { recipients: recipients.length, delivered },
    });

    console.info(
      JSON.stringify({
        level: delivered ? "info" : "error",
        service: "claimmix",
        msg: delivered ? "specialist_alert.sent" : "specialist_alert.send_failed",
        case_id: caseId,
        recipients: recipients.length,
      })
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "claimmix",
        msg: "specialist_alert.error",
        case_id: caseId,
        error: err instanceof Error ? err.name : "UnknownError",
      })
    );
  }
}

/** Has anyone already been told about this case? */
async function alreadyAlerted(caseId: string, tenantId: string): Promise<boolean> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const { auditLog } = await import("@/lib/db/schema");
    const rows = await enTenant(tenantCtx, (db) =>
      db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.target_id, caseId),
            eq(auditLog.event_type, AuditEvent.SPECIALIST_ALERTED)
          )
        )
        .limit(1)
    );
    return rows.length > 0;
  } catch {
    // Unknown means send: a duplicate alert is noise, a missing one is a claim
    // nobody picks up.
    return false;
  }
}
