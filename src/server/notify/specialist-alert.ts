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

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { enTenant, type ClienteDatos, type TenantContext } from "@/data/scope";
import { auditLog, authUsers, cases, claimMessages, tenants, users } from "@/lib/db/schema";
import { isReservedTestAddress, vedadaParaAlertas } from "@/lib/email/reserved";
import { isReservedTestNumber } from "@/core/phone/reserved";
import { nombraCulpaOLey } from "@/core/ai/nombra-culpa";
import { EMAIL_RE } from "@/core/text/contacto";
import { DOMINIO_RE } from "@/core/case/mensaje-tardio";
import { REGLAS, TITULO_DE_REGLA, type Regla } from "@/core/desvios/reglas";
import { resolveDefaultTenantId } from "@/lib/auth/provision";
import { getGmailAccountForTenant } from "@/server/email/gmail/accounts";
import { GmailSender } from "@/server/email/gmail/gmail-sender";
import { isSendSuccess } from "@/server/email/provider";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { logger } from "@/lib/observability/logger";
import { t, type TranslationKey } from "@/lib/i18n";
import { liberarCupo, rateLimit, RATE_LIMIT_CONFIGS } from "@/lib/rate-limit/index";
import { claveDeCupo } from "@/lib/rate-limit/clave";
import { ZONA_ARGENTINA } from "@/core/fecha/dia-argentino";
import type { MotivoDelTope } from "@/server/ai/budget";
import type { TipoMensajeTardio } from "@/core/case/mensaje-tardio";

/**
 * Quién se entera, y en qué orden.
 *
 *   1. La lista que cargó un admin en /configuracion
 *      (`tenants.specialist_alert_emails`). Cada aseguradora tiene la suya, y
 *      gana sobre cualquier deducción.
 *   2. `SPECIALIST_ALERT_EMAILS`, y sólo para el tenant principal: es una
 *      única variable de entorno, así que no hay forma de que otra aseguradora
 *      cargue la suya ahí, y no se le filtra.
 *   3. Los usuarios con rol `specialist`. El caso está dirigido a ellos.
 *   4. UN owner, y no todos los admins.
 *
 * El cuarto punto cambió después de que pasara. El respaldo eran `owner` Y
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
 *
 * La dirección vedada (`vedadaParaAlertas`) no recibe nunca, en ninguno de
 * los cuatro pasos.
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
    if (channel === "email_sim" || channel === "whatsapp_sim") return true;

    /*
     * El canal no alcanza, y ésta es la parte que costó una bandeja llena.
     *
     * El ensayo de conversaciones entra a propósito por los canales de verdad
     * —`email` y `whatsapp`, no `_sim`— porque su razón de ser es ejercitar
     * el camino que recorre producción. Uno de sus escenarios es un incendio
     * con heridos, que se deriva a especialista por diseño. Así que cada
     * `pnpm check` mandaba un "[Urgente] Siniestro derivado a especialista" de
     * verdad, sobre un siniestro inventado, a la casilla de una persona. Y
     * como el ensayo borra sus casos al terminar, el que abría el enlace del
     * mail se encontraba con que el caso no existía.
     *
     * Lo que sí distingue a un denunciante inventado es cómo se lo contacta:
     * el ensayo usa direcciones `example.*` —reservadas por la IANA, no le
     * pertenecen a nadie— y el bloque telefónico `5490000`. El despachador y
     * el mensajero ya se niegan a escribirles; esta ruta era la única que no
     * lo preguntaba, y es la única que le escribe a un empleado en vez de al
     * asegurado.
     */
    const contacto = await enTenant({ tenantId }, (db) =>
      db
        .select({ from_addr: claimMessages.from_addr })
        .from(claimMessages)
        .where(
          and(
            eq(claimMessages.case_id, caseId),
            eq(claimMessages.direction, "inbound")
          )
        )
        .orderBy(asc(claimMessages.received_at))
        .limit(1)
    );

    const remitente = contacto[0]?.from_addr;
    return isReservedTestAddress(remitente) || isReservedTestNumber(remitente);
  } catch {
    return true;
  }
}

function consultaDeLaLista(db: ClienteDatos, tenantId: string) {
  return db
    .select({ emails: tenants.specialist_alert_emails })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
}

/** La lista que cargó un admin en /configuracion. Vacía si no hay o si no se pudo leer. */
export async function listaDelTenant(tenantId: string): Promise<string[]> {
  try {
    const [fila] = await enTenant({ tenantId }, (db) => consultaDeLaLista(db, tenantId));
    return fila?.emails ?? [];
  } catch {
    return [];
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
  const permitida = (e: string) => !vedadaParaAlertas(e);

  const delTenant = (await listaDelTenant(tenantId)).filter(permitida);
  if (delTenant.length > 0) return delTenant;

  if (tenantId === resolveDefaultTenantId()) {
    const explicita = listaExplicita().filter(permitida);
    if (explicita.length > 0) return explicita;
  }

  const specialists = (await byRoles(PREFERRED_ROLES)).filter(permitida);
  if (specialists.length > 0) return specialists;

  // Sin especialistas: UNO solo, y que se sepa.
  const respaldo = (await byRoles(FALLBACK_ROLES)).filter(permitida).slice(0, 1);
  logger.warn({
        tenant_id: tenantId,
        // Cuántos, no quiénes: es un registro, y una dirección es un dato personal.
      destinatarios_de_respaldo: respaldo.length,
        nota: "Nadie tiene rol specialist. El aviso va a un owner. Asigná el rol, o cargá la lista de avisos en /configuracion.",
      }, "specialist_alert.sin_especialistas");
  return respaldo;
}

/**
 * El resumen lo escribió el modelo con lo que dijo el denunciante: si nombra la
 * culpa o cita la ley de tránsito, adelanta una opinión que sólo la ficha
 * muestra, rotulada como orientativa (B18). Un renglón nuevo, un enlace o un
 * correo adentro del resumen arman una línea «Abrir:» ajena en el aviso, y
 * también un dominio suelto, que Gmail vuelve enlace. Se omite la línea, no se
 * corrige.
 */
const resumenSinOpinion = (resumen: string | null | undefined) =>
  resumen &&
  !nombraCulpaOLey(resumen) &&
  !/[\r\n]|https?:\/\/|www\./i.test(resumen) &&
  resumen.search(EMAIL_RE) < 0 &&
  !DOMINIO_RE.test(resumen)
    ? resumen
    : null;

function renderAlert(input: SpecialistAlertInput, caseUrl: string) {
  const kind = input.claimTypeLabel ? ` de ${input.claimTypeLabel}` : "";
  const subject = `[Urgente] Siniestro${kind} derivado a especialista`;

  const resumen = resumenSinOpinion(input.summary);
  const lines = [
    `Un siniestro${kind} fue clasificado como severidad ${input.severity ?? "alta"} y derivado a un especialista.`,
    "",
    resumen ? `Resumen: ${resumen}` : "",
    `Caso: ${input.caseId}`,
    caseUrl ? `Abrir: ${caseUrl}` : "",
    "",
    "Al denunciante ya se le avisó que un especialista se va a comunicar a la brevedad.",
    "No se le pidió ninguna documentación: pedila vos en el contacto.",
  ].filter(Boolean);

  return { subject, text: lines.join("\n") };
}

/** Un aviso a los especialistas: a quién, cómo se audita y qué dice. */
interface Aviso {
  /** El caso del que se avisa. Sin él el aviso es del inquilino entero (el presupuesto, los desvíos): no hay simulado ni marca previa, y el enlace es el de `ruta`. */
  caseId?: string;
  tenantId: string;
  evento:
    | typeof AuditEvent.SPECIALIST_ALERTED
    | typeof AuditEvent.LATE_MESSAGE_ALERTED
    | typeof AuditEvent.AI_BUDGET_ALERTED
    | typeof AuditEvent.DESVIOS_ALERTED;
  /** Lo que distingue a este aviso de otro del mismo caso: el mensaje, en el tardío. */
  marca?: { message_id: string };
  /** Adónde lleva el enlace de un aviso sin caso. */
  ruta?: string;
  /** Datos que van a la auditoría junto a la marca. */
  payload?: Record<string, string | number>;
  /** Prefijo de los registros. */
  log: string;
  /** Tope de correos, contado sólo cuando el aviso de verdad iba a salir y devuelto si no salió. */
  cupo?: { clave: string; config: { limit: number; windowMs: number } };
  render: (enlace: string) => { subject: string; text: string };
}

/**
 * Alert the tenant's specialists that a case escalated.
 *
 * Idempotent per case: the audit log is checked first, so a re-extraction that
 * escalates again does not re-alert. Somebody is already looking.
 */
export async function alertSpecialists(input: SpecialistAlertInput): Promise<void> {
  await avisar({
    caseId: input.caseId,
    tenantId: input.tenantId,
    evento: AuditEvent.SPECIALIST_ALERTED,
    log: "specialist_alert",
    render: (caseUrl) => renderAlert(input, caseUrl),
  });
}

export interface MensajeTardioInput {
  tenantId: string;
  caseId: string;
  messageId: string;
  /** null = sin clasificar. */
  tipo: TipoMensajeTardio | null;
  /** Ya filtrado por `esResumenSeguro`; nunca el texto crudo del mensaje. */
  resumen: string | null;
}

/**
 * Avisa que llegó un mensaje a un caso que atiende una persona (B3).
 *
 * Idempotente por mensaje, con su propio evento: el de la derivación es uno por
 * caso y ya está gastado cuando llega esto.
 */
export async function avisarMensajeTardio(input: MensajeTardioInput): Promise<void> {
  const clase = t(`tardio.tipo.${input.tipo ?? "sin_clasificar"}` as TranslationKey);
  const resumen = resumenSinOpinion(input.resumen);
  await avisar({
    caseId: input.caseId,
    tenantId: input.tenantId,
    evento: AuditEvent.LATE_MESSAGE_ALERTED,
    marca: { message_id: input.messageId },
    log: "late_message_alert",
    cupo: {
      clave: claveDeCupo("aviso-tardio", input.tenantId, input.caseId),
      config: RATE_LIMIT_CONFIGS.AVISO_TARDIO_POR_CASO,
    },
    render: (caseUrl) => ({
      subject: t("tardio.aviso.asunto").replace("{tipo}", clase),
      text: [
        t("tardio.aviso.cuerpo"),
        "",
        t("tardio.aviso.quePide").replace("{tipo}", clase),
        resumen ? t("tardio.aviso.resumen").replace("{resumen}", resumen) : null,
        t("tardio.aviso.caso").replace("{caso}", input.caseId),
        caseUrl ? t("tardio.aviso.abrir").replace("{link}", caseUrl) : null,
      ]
        .filter((linea) => linea !== null)
        .join("\n"),
    }),
  });
}

export interface PresupuestoAgotadoInput {
  tenantId: string;
  /** El cupo de una persona no frena al intake: no es motivo de aviso. */
  motivo: Exclude<MotivoDelTope, "persona">;
}

/**
 * Avisa que el presupuesto de IA se agotó y las denuncias dejaron de analizarse.
 *
 * No es de un caso: el worker deja sin analizar cada mensaje que llega, y sin
 * aviso la única huella es un warn por mensaje. Un correo por día y por
 * inquilino. El cupo se gasta sólo si hay a quién y desde dónde mandar, y se
 * devuelve si el correo no salió: un día sin destinatarios o con Gmail caído no
 * puede dejar sin aviso a las 24 horas siguientes.
 */
export async function avisarPresupuestoAgotado(input: PresupuestoAgotadoInput): Promise<void> {
  const { tenantId, motivo } = input;

  await avisar({
    tenantId,
    evento: AuditEvent.AI_BUDGET_ALERTED,
    payload: { motivo },
    log: "presupuesto_alert",
    cupo: {
      clave: claveDeCupo("aviso-presupuesto", tenantId),
      config: RATE_LIMIT_CONFIGS.AVISO_PRESUPUESTO_POR_INQUILINO,
    },
    render: () => ({
      subject: t("presupuesto.aviso.asunto"),
      text: t("presupuesto.aviso.cuerpo")
        .replace(
          "{hora}",
          new Date().toLocaleTimeString("es-AR", {
            timeZone: ZONA_ARGENTINA,
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23",
          })
        )
        .replace("{plazo}", t(`presupuesto.aviso.plazo.${motivo}` as TranslationKey))
        .replace("{motivo}", t(`presupuesto.aviso.motivo.${motivo}` as TranslationKey)),
    }),
  });
}

export interface DesviosNuevosInput {
  tenantId: string;
  /** Cuántos desvíos nuevos dejó la revisión de anoche en cada regla: sólo conteos, nunca un caso. */
  porRegla: Partial<Record<Regla, number>>;
}

/**
 * Avisa que la revisión nocturna encontró desvíos nuevos (B22).
 *
 * Sin él la lista de /desvios es la única huella y nadie la abre. Es un aviso
 * de inquilino, como el del presupuesto: un correo por día, con los conteos por
 * regla y el enlace a la pantalla, nunca nombres, pólizas ni números de caso.
 * Les llega a los mismos que el resto de los avisos (`recipientsFor`, sin lista
 * ni rol propios) y nunca a un analista por tener casos asignados.
 *
 * Devuelve si el correo salió, para que el barrido cuente avisos y no llamadas.
 */
export async function avisarDesvios(input: DesviosNuevosInput): Promise<boolean> {
  const { tenantId, porRegla } = input;
  const reglas = REGLAS.filter((r) => (porRegla[r] ?? 0) > 0);
  const total = reglas.reduce((suma, r) => suma + (porRegla[r] ?? 0), 0);
  if (total === 0) return false;

  return avisar({
    tenantId,
    evento: AuditEvent.DESVIOS_ALERTED,
    ruta: "/desvios",
    payload: { nuevos: total, ...Object.fromEntries(reglas.map((r) => [r, porRegla[r] ?? 0])) },
    log: "desvios_alert",
    cupo: {
      clave: claveDeCupo("aviso-desvios", tenantId),
      config: RATE_LIMIT_CONFIGS.AVISO_DESVIOS_POR_INQUILINO,
    },
    render: (enlace) => ({
      subject: t("desvios.aviso.asunto").replace("{n}", String(total)),
      text: [
        t("desvios.aviso.cuerpo"),
        "",
        ...reglas.map((r) =>
          t("desvios.aviso.linea").replace("{regla}", t(TITULO_DE_REGLA[r])).replace("{n}", String(porRegla[r]))
        ),
        ...(enlace ? ["", t("desvios.aviso.abrir").replace("{link}", enlace)] : []),
      ].join("\n"),
    }),
  });
}

/** Devuelve si el correo salió: sin destinatarios, sin casilla, sin cupo o con el envío caído, no. */
async function avisar(aviso: Aviso): Promise<boolean> {
  const { caseId, tenantId } = aviso;
  const contexto = caseId ? { case_id: caseId } : { tenant_id: tenantId };
  let cupoGastado: Aviso["cupo"];
  let entregado = false;

  try {
    if (caseId) {
      if (await isSimulatedCase(tenantId, caseId)) {
        // Logged rather than passed over: an operator watching a rehearsal
        // should be able to see the alert was deliberately withheld, not
        // wonder whether it silently failed.
        logger.info(contexto, `${aviso.log}.skipped_simulated`);
        return false;
      }

      if (await alreadyAlerted({ ...aviso, caseId })) return false;
    }

    const recipients = await recipientsFor(tenantId);
    if (recipients.length === 0) {
      // Worth an error, not a shrug: the promise made to the claimant has no
      // owner, and the only way to find that out is to look for this line.
      logger.error({ ...contexto, tenant_id: tenantId }, `${aviso.log}.no_recipients`);
      return false;
    }

    const account = await getGmailAccountForTenant(tenantId);
    if (!account) {
      logger.error(contexto, `${aviso.log}.no_mailbox`);
      return false;
    }

    // El cupo se gasta sólo si hay a quién y desde dónde mandar.
    if (aviso.cupo) {
      if (!(await rateLimit(aviso.cupo.clave, aviso.cupo.config)).allowed) {
        logger.warn(contexto, `${aviso.log}.tope`);
        return false;
      }
      cupoGastado = aviso.cupo;
    }

    const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "";
    const ruta = caseId ? `/casos/${caseId}` : aviso.ruta;
    const { subject, text } = aviso.render(ruta && base ? `${base}${ruta}` : "");

    const sender = new GmailSender(account.refreshToken);
    const result = await sender.send({
      to: recipients.join(", "),
      from: account.email,
      subject,
      textBody: text,
    });

    const delivered = isSendSuccess(result);
    entregado = delivered;

    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: aviso.evento,
      target_type: caseId ? "case" : "tenant",
      target_id: caseId ?? tenantId,
      // Recipient count, not addresses: an audit trail should prove someone
      // was told without becoming a list of staff emails.
      payload: { ...aviso.marca, ...aviso.payload, recipients: recipients.length, delivered },
    });

    logger.info(
      { ...contexto, recipients: recipients.length },
      delivered ? `${aviso.log}.sent` : `${aviso.log}.send_failed`
    );
  } catch (err) {
    logger.error({
        ...contexto,
        error: err instanceof Error ? err.name : "UnknownError",
      }, `${aviso.log}.error`);
  } finally {
    // Un correo que no salió no gasta el tope: con uno por día, el siguiente intento es el único que hay.
    // `liberarCupo` ya anota y traga la falla de la base: no hace falta un catch acá.
    if (cupoGastado && !entregado) await liberarCupo(cupoGastado.clave, cupoGastado.config.windowMs);
  }
  return entregado;
}

/**
 * ¿Ya se le avisó a alguien de este caso, DE VERDAD?
 *
 * Miraba si existía una fila de `claim.specialist_alerted` y nada más. Pero esa
 * fila se escribe pase lo que pase con el envío: lleva `delivered: false` cuando
 * Gmail no lo pudo entregar. O sea que un envío fallido dejaba una marca que
 * después se leía como «alguien ya está mirando esto», y no se volvía a intentar
 * NUNCA.
 *
 * La secuencia completa: llega un incendio con heridos, el caso pasa a
 * `requiere_especialista`, al asegurado le sale la plantilla que le promete que
 * «un especialista se va a comunicar con vos a la brevedad», el correo al
 * especialista falla, y nadie se entera. El caso queda esperando a una persona a
 * la que nunca se le avisó.
 *
 * El `catch` de acá abajo ya tenía escrita la regla correcta —«un aviso
 * duplicado es ruido, uno que falta es una denuncia que nadie levanta»— y la
 * consulta hacía lo contrario.
 *
 * Nota sobre las filas viejas: una sin `delivered` en el payload cuenta como no
 * entregada, así que un caso de esos se volvería a avisar una vez. Es el lado
 * correcto del error, y en la base de hoy no hay ninguna: los 28 avisos que hay
 * llevan `delivered: true`.
 */
async function alreadyAlerted({ caseId, tenantId, evento, marca }: Aviso & { caseId: string }): Promise<boolean> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const rows = await enTenant(tenantCtx, (db) =>
      db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.target_id, caseId),
            eq(auditLog.event_type, evento),
            sql`${auditLog.payload}->>'delivered' = 'true'`,
            marca ? sql`${auditLog.payload}->>'message_id' = ${marca.message_id}` : undefined
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
