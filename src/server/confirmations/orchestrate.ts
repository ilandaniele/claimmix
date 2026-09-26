/**
 * Post-extraction orchestrator — decides what emails to send and what
 * status transitions to apply after the extraction worker completes.
 *
 * Called by runEmailExtractionWorker after all DB persists are done.
 *
 * Decision tree:
 *   A. is_claim=false → return early (no email)
 *   B. High/critical severity → specialist_escalation, and nothing else: no
 *      gap request, no confirmation, no other status. A person is taking over
 *   C. fields_pending_confirmation → insert claim_field_confirmations rows + data_confirmation_request
 *   D. Conflict in customer matches → claim_field_confirmations conflict rows + data_confirmation_request
 *   E. Gap analysis → missing_information_request (info_faltante) OR update status
 *   F. confirmation_received — only when no other branch already wrote (AC12)
 *
 * AC7:  Medium-confidence field → claim_field_confirmations row + data_confirmation_request
 * AC9:  Conflict with stored customer → claim_field_confirmations conflict row + data_confirmation_request
 * AC10: Missing required fields → missing_information_request + status=info_faltante
 * AC11: High/critical severity → specialist_escalation + status=requiere_especialista,
 *       and no other branch writes: the escalation promised no further action
 * AC12: confirmation_received dispatched for is_claim=true, except when another
 *       branch already wrote — every one of them acknowledges receipt and
 *       carries the case number, so this would be a second, emptier email
 *
 * LLM08: This module cannot set terminal states; only sets AI_ALLOWED_STATUSES.
 * LLM06: PII (email addresses) is never logged — only case_id and field_key.
 */

import "server-only";
import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { queHacer, elPedidoQuedaEnEspera } from "@/core/case/reply-decision";
import { laPreguntaDelMensaje } from "@/core/mensajes/pregunta";
import { esSoloUnAcuse } from "@/core/mensajes/acuse";
import { esValorVacio, valorLegible } from "@/core/mensajes/valor-legible";
import { contestaSinHora, dichoRecien, esValorVago } from "@/core/mensajes/lo-dicho";
import { diaArgentino } from "@/core/fecha/dia-argentino";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import {
  cases,
  claimAttachments,
  claimFieldConfirmations,
  customers,
  extractedFields,
  missingDocs,
  outboundMessages,
  policies,
} from "@/lib/db/schema";
import { mismoNombre, normalizarDni, normalizarNumeroPoliza } from "@/core/matching/normalizar";
import { maskFullName } from "@/server/email/render";
import type { CaseRow } from "@/lib/db/types";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";
import type { PolizasDelCaso } from "@/core/case/poliza-vigente";
import type { CustomerMatch } from "@/server/matching/customer-matcher";
import { analyzeEmailClaimGaps, MEDIUM_CONFIDENCE_HIGH } from "@/server/cases/gap-analyzer";
import { alertSpecialists } from "@/server/notify/specialist-alert";
import { deliberate } from "@/server/ai/deliberate";
import {
  pendingDocKeys,
  reconcileAttachments,
  resolveDeclinedDocs,
  seedRequiredDocs,
  satisfyContactDocsWeAlreadyHave,
} from "@/server/cases/documents";
import { separarPorRespaldo } from "@/core/case/respaldado-por-busqueda";
import { hayHeridos } from "@/core/case/heridos-supuestos";
import {
  canonicalFieldKey,
  isDocument,
  confirmationRank,
  isAffirmativeReply,
  isDerivable,
  isNameable,
  isWorthConfirming,
  labelForClaimType,
} from "@/lib/labels/claim-fields";
import {
  emailMessenger,
  nombresEnElLibro,
  type AgentMessenger,
} from "@/server/confirmations/messenger";
import { yaContestamosElUltimoMensaje } from "@/server/confirmations/ya-contestado";
import { lastAskedKeys } from "@/server/confirmations/ultimo-pedido";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";
import { redactObject } from "@/lib/audit/redact";
import { logger } from "@/lib/observability/logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExtractedClaimOutput {
  extractedClaim: ExtractedClaim;
  senderEmail: string;
  inReplyToMessageId?: string;
  /**
   * Body of the newest inbound message, on its own.
   *
   * Separate from the conversation the extractor reads, because "Confirmo" is
   * answered by the fact that they said it, not by anything extraction can
   * find in it.
   */
  latestMessageText?: string;
  /** Lo que el worker vio de las pólizas encontradas. */
  polizas?: PolizasDelCaso;
  /**
   * Ni el nombre ni el DNI son los del titular de la póliza (`esTitularAjeno`):
   * se deriva después del pedido de confirmación, sin preguntarle al modelo.
   */
  titularAjeno?: boolean;
  /**
   * La reserva de extracción la heredó una corrida muerta.
   *
   * `acquireExtractionLease` puede encontrar la reserva vencida sin la marca
   * de pendiente: la corrida que la tenía murió, pero antes pudo haber llegado
   * a contestar. Retomar de cero manda lo mismo otra vez, así que acá se avisa
   * —con la hora en que se pidió la reserva— para que el orquestador pueda
   * comprobarlo contra lo que había llegado hasta entonces.
   */
  heredadaEn?: string;
  /**
   * El barrido retoma el caso si este turno vuelve a la cola.
   *
   * Sólo el worker sabe en qué estado dejó el caso, y un caso que ya no está
   * en uno de arranque no lo retoma nadie: ahí el turno sigue como pueda.
   */
  sePuedeRetomar?: boolean;
  /** `asked_keys` del último mensaje que salió, si el worker ya lo leyó. */
  preguntadas?: string[];
}

// ── Main orchestrator ─────────────────────────────────────────────────────────

/**
 * Run the post-extraction orchestration pipeline.
 *
 * Idempotent within a single extraction run — checks for existing
 * outbound_messages and claim_field_confirmations before inserting.
 *
 * @param caseId           - UUID of the case.
 * @param tenantId         - UUID of the tenant (explicit tenant scoping — RLS is gone).
 * @param extractedOutput  - Extraction result + sender info.
 * @param customerMatches  - Customer matches from the customer-matcher module.
 */
/**
 * Lo que el worker ya buscó, en una línea por dato, para que el agente no lo
 * vuelva a buscar.
 *
 * `verificar_poliza` y `polizas_por_dni` contestan exactamente esto, y cada
 * una que el modelo pide cuesta otra pasada del bucle de deliberación: otra
 * llamada a Gemini de seis segundos en la mediana, dentro de un presupuesto de
 * cuarenta.
 *
 * Sin nombres ni números: el modelo no necesita el DNI para saber que la
 * póliza existe, ni el número para saber que venció, y esto va a un prompt.
 * Lo que necesita es si hay con qué seguir.
 */
export function loQueYaAveriguamos(
  matches: CustomerMatch[],
  polizas?: PolizasDelCaso | null
): string | undefined {
  const lineas: string[] = [];

  if (polizas && polizas.vigentes === 0 && polizas.noVigentes > 0) {
    lineas.push(
      polizas.vencioEl
        ? `- La póliza no está vigente: venció el ${polizas.vencioEl}. Pedirle documentación no sirve.`
        : "- La póliza no está vigente. Pedirle documentación no sirve."
    );
  }

  if (matches.length === 0) {
    lineas.push("- El padrón no devolvió ningún cliente para los datos de este mensaje.");
    return lineas.join("\n");
  }

  const resto: string[] = [];
  const porPoliza = matches.filter((m) => m.matchType === "policy_number");
  const porDni = matches.filter((m) => m.matchType === "dni");

  if (porPoliza.length > 0) {
    resto.push(`- La póliza que dio existe en el padrón (${porPoliza.length} coincidencia(s)).`);
  }
  if (porDni.length > 0) {
    resto.push(`- El DNI que dio tiene ${porDni.length} póliza(s) en el padrón.`);
  }
  if (resto.length === 0) {
    resto.push(`- Hay ${matches.length} coincidencia(s) en el padrón, por contacto y no por póliza ni DNI.`);
  }

  const conflictos = matches.flatMap((m) => m.conflictsWithExtracted);
  if (conflictos.length > 0) {
    resto.push(`- No coincide con lo que tenemos guardado: ${[...new Set(conflictos)].join(", ")}.`);
  }

  return [...lineas, ...resto].join("\n");
}

/**
 * El mensajero de una corrida heredada que ya contestó.
 *
 * No manda nada — la corrida que murió se adelantó. Existe para que las cinco
 * salidas y `escalate()` no tengan que enterarse de por qué se callan: siguen
 * llamando a `messenger.send(...)` igual que siempre.
 */
const mudo: AgentMessenger = {
  async send(message) {
    logger.info(
      { case_id: message.caseId, template: message.template },
      "orchestrate.envio_omitido"
    );
  },
};

export async function orchestratePostExtraction(
  caseId: string,
  tenantId: string,
  extractedOutput: ExtractedClaimOutput,
  customerMatches: CustomerMatch[],
  /**
   * How to deliver what this decides. Defaults to email, which is where the
   * decision tree grew up; WhatsApp passes its own so the two channels share
   * the reasoning instead of each keeping a copy that drifts.
   */
  messengerPedido: AgentMessenger = emailMessenger
): Promise<void> {
  const { extractedClaim, senderEmail, inReplyToMessageId, latestMessageText, heredadaEn } =
    extractedOutput;

  // ── A. Non-claim email — return early ─────────────────────────────────────
  if (extractedClaim.is_claim === false) {
    // Already handled by extraction worker (status=no_relevante).
    // No email should be sent for non-claim emails (AC5).
    return;
  }

  /*
   * ¿Esto ya lo contestó la corrida que murió?
   *
   * `heredadaEn` sólo dice que la reserva estaba vencida sin la marca de
   * pendiente — la corrida anterior pudo haber muerto ANTES o DESPUÉS de
   * escribir. Sólo acá, y sólo en ese caso, vale la pena la consulta extra:
   * una corrida heredada que nunca llegó a contestar tiene que seguir de
   * largo igual que cualquier otra.
   */
  const yaContestada =
    heredadaEn !== undefined &&
    (await yaContestamosElUltimoMensaje(caseId, tenantId, heredadaEn));
  if (yaContestada) {
    logger.warn({ case_id: caseId }, "orchestrate.ya_contestado_por_la_corrida_muerta");
  }
  const messenger: AgentMessenger = yaContestada ? mudo : messengerPedido;

  let confirmationEmailDispatched = false;

  /*
   * Who we are writing to.
   *
   * The claimant said their name in the first message and the model greeted
   * them by it; the second round arrived as a photo with no caption, so the
   * only text we handed the composer was "[Imagen adjunta sin texto]" and the
   * reply opened with a bare "¡Hola!". A name we already hold should not be
   * forgotten because the last thing said was a picture.
   *
   * Se calcula acá arriba, y no más abajo con el resto, porque la derivación
   * por severidad manda su mensaje antes que nadie: alguien cuya pareja está
   * internada recibía el único mensaje del caso sin su nombre mientras el
   * siguiente sí lo usaba.
   */
  const claimantName =
    extractedClaim.fields.find((f) => canonicalFieldKey(f.field_key) === "full_name")
      ?.field_value?.trim() || null;

  // ── B. Severity escalation — AC11 ────────────────────────────────────────
  const severity = extractedClaim.severity;
  const heridos = hayHeridos(extractedClaim);
  const grave = severity === "high" || severity === "critical";
  const isHighSeverity = grave || heridos;
  const derivaSola = isHighSeverity || extractedOutput.polizas?.derivar === true;

  if (derivaSola) {
    await escalate({
      caseId,
      tenantId,
      senderEmail,
      latestMessageText,
      inReplyToMessageId,
      messenger,
      severity,
      claimantName,
      claimTypeValue: extractedClaim.fields.find(
        (f) => canonicalFieldKey(f.field_key) === "claim_type"
      )?.field_value ?? null,
      summary: extractedClaim.summary ?? null,
      heridos: isHighSeverity && hayHeridos(extractedClaim),
      reason: grave
        ? `severidad ${severity}`
        : heridos
          ? "lesiones"
          : `póliza sin vigencia${extractedOutput.polizas?.vencioEl ? ` desde ${extractedOutput.polizas.vencioEl}` : ""}`,
    });
  }

  // ── Gap analysis runs first: it is the authority on what is uncertain ─────
  //
  // It used to run at step E, after the confirmation branches had already
  // decided who to ask. That left two independent opinions about the same
  // question. The gap analyzer recomputes the medium-confidence band from the
  // extracted fields; the extractor also emits its own
  // `fields_pending_confirmation` list. In production they disagreed: a case
  // landed in `confirmacion_pendiente` because the analyzer saw claim_type at
  // 0.60, while no email went out because the extractor had left its list
  // empty. The board said "waiting on the claimant" about a question nobody
  // had been asked, and the case would have sat there forever.

  // What we have actually put in front of this person. Read before both
  // resolvers, which need it to know what could possibly have been answered.
  const lastAsked = extractedOutput.preguntadas ?? (await lastAskedKeys(caseId, tenantId));

  // Un «ok» o un «gracias» a una lista de varias cosas no contesta ninguna.
  // Ver `esSoloUnAcuse`.
  const soloAcuse = lastAsked.length > 1 && esSoloUnAcuse(latestMessageText);

  // Documents, before the gap analysis reads what is outstanding.
  //
  // Register what this kind of claim needs — required_docs_config was seeded
  // at the start of the project and read by nothing, so nobody was ever asked
  // for the photos of the damage or the fire brigade report. Then close the
  // ones whose file has arrived, or the next round asks for a photo already
  // sitting in the bucket.
  const claimTypeValue =
    extractedClaim.fields.find((f) => canonicalFieldKey(f.field_key) === "claim_type")
      ?.field_value ?? null;

  await seedRequiredDocs(caseId, tenantId, claimTypeValue);

  // Y cerrar el contacto que ya tenemos por el canal: por WhatsApp el teléfono
  // es el remitente, y pedirle a alguien el número desde el que está escribiendo
  // es de las cosas que hacen que deje de contestar.
  await satisfyContactDocsWeAlreadyHave(caseId, tenantId, extractedClaim.fields);

  // And close the ones they have just told us do not exist. Most crashes have
  // no friendly accident report — our own message says "si lo completaron" —
  // and until now "no completamos ninguno" was heard as silence: the request
  // stayed open, every round asked again, and the case died of abandonment two
  // weeks later.
  //
  // Un 429 o un TIMEOUT del reconocedor devuelven el turno a la cola: no se
  // contesta, no se delibera y no se cierra nada. Con la derivación ya hecha,
  // o con el caso en un estado que el barrido no retoma, se sigue sin él.
  const vuelveALaCola = !derivaSola && !yaContestada && extractedOutput.sePuedeRetomar === true;
  const documentosDeclinados = await resolveDeclinedDocs(
    caseId,
    tenantId,
    latestMessageText,
    lastAsked,
    vuelveALaCola
  );

  // Los adjuntos, recién después del reconocedor: cada mirada gasta una de las
  // tres que el archivo tiene de por vida, y si el turno vuelve a la cola la
  // retoma los miraría otra vez por el mismo mensaje. Lo de arriba es
  // idempotente. Un 429 al mirar la foto también vuelve a la cola, sin gastar
  // la mirada.
  await reconcileAttachments(caseId, tenantId, labelForClaimType(claimTypeValue), vuelveALaCola);

  // A field the claimant has now answered is no longer pending. Runs BEFORE
  // the gap analysis, which reads those rows straight back out.
  //
  // Y después del reconocedor de negativas y de los adjuntos, que son lo único
  // que puede devolver el turno a la cola: este UPDATE consume la señal, y la
  // retoma tiene que encontrarla intacta.
  const confirmacionesContestadas = await resolveAnsweredConfirmations(
    caseId,
    tenantId,
    extractedClaim.fields,
    soloAcuse ? undefined : latestMessageText,
    lastAsked
  );

  const gapResult = await analyzeEmailClaimGaps(caseId, extractedClaim.fields, tenantId);

  // ── C. Medium-confidence fields → confirmation rows — AC7 ─────────────────
  //
  // Union of both opinions: if either side thinks a field is uncertain, ask.
  // Conflicts are excluded — branch D owns those and has the stored value to
  // show alongside.
  //
  // Lo que ya se confirmó o corrigió no vuelve: el extractor relee toda la
  // conversación y lo lista otra vez como duda, a veces con otro nombre.
  //
  // Una franja del día entra aunque el extractor la dé por segura: «a la tarde»
  // no es una hora. Ver `esValorVago`.
  const resueltos = new Set(gapResult.camposResueltos ?? []);
  const dudasDelAnalizador = gapResult.fieldsNeedingConfirmation.filter(
    (f) => f.reason !== "conflict"
  );
  const uncertainKeys = [
    ...(extractedClaim.fields_pending_confirmation ?? []),
    ...extractedClaim.fields
      .filter((f) => esValorVago(f.field_key, f.field_value))
      .map((f) => f.field_key),
    ...dudasDelAnalizador.map((f) => f.fieldName),
  ].filter((k) => !resueltos.has(canonicalFieldKey(k)));

  const confirmables = collectConfirmableFields(
    uncertainKeys,
    extractedClaim.fields,
    new Map(
      dudasDelAnalizador
        // Heridos no: `sinHeridosSupuestos` borró el «no» que nadie dijo para
        // preguntarlo abierto, y la fila vieja lo traería de vuelta.
        .filter((f) => canonicalFieldKey(f.fieldName) !== "hay_heridos")
        .map((f) => [
          canonicalFieldKey(f.fieldName),
          { valor: f.suggestedValue, confianza: f.confidence ?? 0 },
        ])
    )
  );

  /*
   * Lo que la persona escribió en este mismo mensaje no se le devuelve como
   * «¿…, correcto?»: queda confirmado. El 23/09 a «Fue un choque, ayer a la
   * tarde» se le contestó «¿Fue a la tarde, correcto?»; el 25/09, a un primer
   * mensaje con «Choqué en Villa Mitre», se le preguntó si Villa Mitre era
   * correcto — nadie se lo había pedido, ella ya lo había dicho.
   *
   * No hace falta haberlo pedido: `dichoRecien` es literal y sabe de
   * negaciones, así que un número suelto (¿DNI, póliza, teléfono?) sigue sin
   * alcanzar. La excepción es de quién es un dato de identidad — nombre, DNI,
   * email, teléfono—: «Mi esposa es Ana Paz» dice el nombre de Ana Paz tal
   * cual, y no es el del asegurado. Ahí sólo cuenta como dicho si es la
   * respuesta a lo que le pedimos. Lo inferido, los conflictos con el padrón
   * (rama D) y los heridos también quedan afuera.
   *
   * Una franja del día es distinta: mencionarla al pasar («choqué ayer a la
   * tarde») no contesta una hora que nadie preguntó todavía, así que esa rama
   * sigue pidiendo la fila pendiente primero. Se pide como hora hasta que
   * conteste: con una hora (la extracción la trae y deja de ser vaga), con la
   * franja otra vez o con que no sabe. Un «sí» la cierra en
   * `resolveAnsweredConfirmations`.
   */
  const pedidoRecien = new Set(lastAsked.map(canonicalFieldKey));
  const enConflicto = new Set(customerMatches.flatMap((m) => m.conflictsWithExtracted));
  const loQueEscribio = soloAcuse ? undefined : latestMessageText;
  const loDijoRecien = (c: ConfirmableField) =>
    !enConflicto.has(c.fieldKey) &&
    c.fieldKey !== "hay_heridos" &&
    (esValorVago(c.fieldKey, c.proposedValue)
      ? pedidoRecien.has(c.fieldKey) && contestaSinHora(loQueEscribio)
      : (!CAMPOS_DE_IDENTIDAD.has(c.fieldKey) || pedidoRecien.has(c.fieldKey)) &&
        dichoRecien(c.proposedValue, loQueEscribio));
  const dichos = confirmables.filter(loDijoRecien);
  const pendingConfirmationFields = confirmables.filter((c) => !loDijoRecien(c));

  /*
   * Todos los campos de una, no tres viajes por campo.
   *
   * Esto era un bucle con `upsertFieldConfirmation` —que por dentro son DOS
   * `enTenant`: un SELECT del id y después UPDATE o INSERT— más un
   * `writeAuditLog`, que es un tercero. Con cinco u ocho campos dudosos, que es
   * lo normal en un primer mensaje, son quince a veinticuatro viajes de red
   * secuenciales.
   *
   * Y no bajaban entre rondas: la lista se arma con las filas que YA están
   * pendientes, así que la quinta ronda con seis campos sin responder volvía a
   * pagar dieciocho viajes reescribiendo filas idénticas.
   *
   * Corre después de CADA mensaje entrante, en el mismo tramo donde el agente
   * llama a Gemini y contra el techo de la función.
   *
   * La forma ya estaba en este archivo: `resolveAnsweredConfirmations` hace un
   * solo UPDATE con `inArray` sobre esta misma tabla.
   */
  if (confirmables.length > 0) {
    await guardarConfirmaciones(caseId, tenantId, [
      ...pendingConfirmationFields,
      ...dichos.map((d) => ({ ...d, estado: "confirmed" as const })),
    ]);
  }

  if (pendingConfirmationFields.length > 0) {
    /*
     * Un evento con todas las claves, y no uno por campo.
     *
     * Es el mismo pedido de confirmación, del mismo caso, en el mismo instante.
     * Anotarlo N veces no agrega información y multiplica las escrituras.
     */
    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.CONFIRMATION_REQUESTED,
      target_type: "case",
      target_id: caseId,
      // Sólo las claves: el valor propuesto es dato de una persona.
      payload: { field_keys: pendingConfirmationFields.map((f) => f.fieldKey) },
    });
  }

  // Lo que la persona acaba de cerrar con este mensaje. Los dos resolutores de
  // arriba escriben en la base y hasta ahora no le contaban a nadie: el pedido
  // quedaba cerrado y, al mismo tiempo, invisible como motivo para contestar.
  // Con un acuse solo, lo que se haya cerrado lo cerró la extracción al releer
  // la conversación, no la persona. Lo que dijo recién de lo pedido también
  // cuenta: la rama C lo confirma sin pasar por los resolutores.
  const nosContestoElPedido =
    !soloAcuse &&
    (documentosDeclinados.length > 0 || confirmacionesContestadas.length > 0 || dichos.length > 0);

  // ── D. Customer conflict → confirmation rows — AC9 ────────────────────────
  //
  // Tres campos en conflicto mandaban TRES mails.
  //
  // Esto era un bucle anidado —cada match, cada campo— y adentro, por campo:
  // dos viajes para escribir la fila, uno para el estado, uno a Resend o a
  // Meta, y uno más de auditoría. Que sean cinco viajes por campo es lo de
  // menos: el asegurado recibía un correo por cada dato que no coincidía.
  //
  // Y `full_name` + `email` + `dni` juntos no es un caso raro: es lo que pasa
  // cuando escribe un familiar del titular. Tres mails casi idénticos, con tres
  // «pasamos tu caso a confirmación pendiente» encima.
  //
  // Ahora es un pedido: todas las filas en un lote, un estado, un mensaje que
  // lista los datos que no coinciden, y un evento de auditoría con las claves.
  // Es la misma forma que ya tenía la rama C acá arriba.
  const conflictos: Array<{
    fieldKey: string;
    proposedValue: string;
    confidence: number;
    conflictWithValue: string;
  }> = [];
  const clavesEnConflicto = new Set<string>();

  for (const match of customerMatches) {
    for (const conflictField of match.conflictsWithExtracted) {
      // El primero gana: `findCustomerMatches` ordena por confianza
      // descendente, así que si dos clientes chocan con el mismo campo, el que
      // manda es el que mejor coincide.
      if (clavesEnConflicto.has(conflictField)) continue;
      clavesEnConflicto.add(conflictField);

      /*
       * El buscador informa el conflicto con la clave CANÓNICA, y `fields[]`
       * viene como lo nombró el modelo ese día.
       *
       * `detectConflicts` compara sobre el diccionario ya canonizado, así que
       * devuelve `dni`. Pero el extractor pudo haber emitido `dni_asegurado`, y
       * este `find` por igualdad exacta no lo encontraba: el conflicto quedaba
       * con `proposedValue: ""` y confianza 0, y el mail terminaba pidiéndole a
       * la persona el dato que acababa de escribir.
       *
       * El propio repositorio documenta que el nombre del campo cambia según el
       * día — para eso existe `canonicalFieldKey`.
       */
      const extractedEntry = extractedClaim.fields.find(
        (f) => canonicalFieldKey(f.field_key) === conflictField
      );
      conflictos.push({
        fieldKey: conflictField,
        proposedValue: extractedEntry?.field_value ?? "",
        confidence: extractedEntry?.confidence ?? 0,
        conflictWithValue: getStoredFieldValue(match, conflictField),
      });
    }
  }

  if (conflictos.length > 0) {
    await guardarConfirmaciones(caseId, tenantId, conflictos);

    /*
     * Un caso escalado se queda con su estado y con su único mensaje.
     *
     * Las filas se escriben igual —el analista las ve en la pantalla— pero no
     * se le manda nada al asegurado ni se anota el pedido, porque no se le
     * pidió nada. Era así antes de este cambio y se mantiene: agregarle ahora
     * un evento de auditoría que nunca emitió sería inventar historia.
     */
    if (!derivaSola) {
      await setStatus(caseId, tenantId, "confirmacion_pendiente");

      await messenger.send({
        caseId,
        tenantId,
        to: senderEmail,
        lastMessage: latestMessageText,
        template: "data_confirmation_request",
        data: {
          caseId,
          claimantName,
          fields: conflictos.map((c) => ({
            fieldKey: c.fieldKey,
            proposedValue: c.proposedValue,
            conflictWithValue: c.conflictWithValue,
          })),
          // Se deriva abajo en esta misma vuelta: el pedido no pregunta nada.
          titularAjeno: extractedOutput.titularAjeno === true,
        },
        inReplyToMessageId,
      });
      confirmationEmailDispatched = true;

      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: null,
        event_type: AuditEvent.CONFIRMATION_REQUESTED,
        target_type: "case",
        target_id: caseId,
        // Sólo las claves: el valor es dato de una persona, y el que teníamos
        // guardado también.
        payload: { field_keys: conflictos.map((c) => c.fieldKey), reason: "conflict" },
      });
    }
  }

  /*
   * Quien escribe no es el titular, y el worker ya lo sabía: igual que la
   * póliza vencida (#187), no se espera a que el modelo lo note. Va acá y no
   * con `derivaSola` porque el único mensaje de la vuelta es el pedido de
   * confirmación que D acaba de mandar con los dos valores; `escalate` sólo
   * suprime el segundo. Con `derivaSola` el caso ya se derivó arriba.
   */
  if (extractedOutput.titularAjeno === true && !derivaSola) {
    await escalate({
      caseId,
      tenantId,
      senderEmail,
      latestMessageText,
      inReplyToMessageId,
      messenger,
      severity,
      claimantName,
      claimTypeValue,
      summary: extractedClaim.summary ?? null,
      reason: "quien escribe no es el titular de la póliza",
      yaLeEscribimos: confirmationEmailDispatched,
    });
    return;
  }

  const missingInfoEmailComing = gapResult.missingRequiredFields.length > 0;
  let missingInfoEmailDispatched = false;
  // Un acuse de recibo también es haber hablado: la rama F no puede agregarle
  // encima un "ya tenemos todo lo necesario" que además sería falso.
  let acknowledgementDispatched = false;

  // ── E. Act on the gap analysis — AC10 ────────────────────────────────────

  // Everything we need from the claimant, in one message.
  //
  // Gaps and doubts used to go out as separate emails on separate rounds — the
  // policy number today, what kind of accident it was tomorrow. Neither
  // question depends on the other's answer, so the chain was ours to make and
  // ours to stop making. A person handling the claim writes one message
  // listing what they need.
  // Everything outstanding, uncapped and in the deterministic order. This is
  // both the fallback plan and — more importantly — the only set anything is
  // allowed to ask for.
  const everythingOutstanding = buildAskList(
    gapResult.missingRequiredFields,
    pendingConfirmationFields,
    await pendingDocKeys(caseId, tenantId),
    { cap: false, held: valuesWeHold(extractedClaim.fields) }
  );

  // Ask the agent what to do about this message.
  //
  // Until now the answer came from a table: rank the gaps, take the first
  // five, send. That is predictable and it only ever does what someone thought
  // of in advance — a person who asks "¿cuánto tarda?" gets no answer, because
  // no branch was written for a question.
  //
  // The plan is checked before it is used (see validate): it cannot invent
  // something to ask for, cannot declare the claim finished while something is
  // outstanding, and is never consulted at all on an escalation. A plan that
  // fails is discarded whole and this falls back to the table below, so the
  // worst case is the behaviour we already had.
  const plan = await deliberate({
    caseId,
    tenantId,
    outstanding: everythingOutstanding.fields,
    knownValues: everythingOutstanding.knownValues,
    lastAsked,
    latestMessage: latestMessageText ?? "",
    claimTypeLabel: labelForClaimType(claimTypeValue),
    isHighSeverity: derivaSola,
    isComplete: everythingOutstanding.fields.length === 0,
    yaAveriguado: loQueYaAveriguamos(customerMatches, extractedOutput.polizas),
  });

  if (plan) {
    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.AGENT_DELIBERATED,
      target_type: "case",
      target_id: caseId,
      /*
       * Por el mismo filtro que los demás payloads.
       *
       * Faltaba justo acá, que es el único que lleva los ARGUMENTOS de las
       * consultas: `tools: [{ tool: "polizas_por_dni", args: { dni:
       * "25.888.101" } }]`. El documento de una persona entraba crudo al
       * `audit_log` — una tabla que se exporta, se muestra y se le entrega a la
       * aseguradora — y `redactObject` estaba aplicado en otros dos payloads y
       * en éste no.
       *
       * Las claves sobreviven, así que se sigue sabiendo qué consultó y qué dio
       * por resuelto; lo que se va son los valores.
       */
      payload: redactObject({
        intent: plan.intent,
        ask_for: plan.askFor,
        question: plan.question,
        // What it went and looked up before deciding.
        tools: plan.toolCalls,
        /*
         * Qué dio por sabido sin preguntarlo. Faltaba, y es el que más pesa.
         *
         * `resolved` hace dos cosas fuertes: escribe el valor con confianza 0.95
         * y cierra el pedido correspondiente. Era el único campo del plan que no
         * quedaba anotado, así que cuando un caso aparecía con un documento dado
         * por recibido no había forma de saber si lo había cerrado el agente o
         * el reconciliador de adjuntos. Se anotan los NOMBRES y los valores, que
         * es lo mismo que ya queda en `extracted_fields`.
         */
        resolved: plan.resolved,
        // The one thing nobody could answer before: why did it say that.
        reasoning: plan.reasoning,
      }),
    });

    // What a lookup turned up goes onto the claim instead of into a question.
    // Searching by DNI, finding the policy number in our own database, and
    // then asking the claimant for it is exactly what a form does.
    const resolved = plan.resolved ?? [];
    if (resolved.length > 0) {
      await recordLookedUpFields(caseId, tenantId, resolved, plan.lookupResults ?? []);
    }

    // Something a person handling the file would write down and no column was
    // ever going to hold: the other driver left the scene, they mentioned a
    // lawyer, they say they already claimed for this in March.
    if (plan.noteForAnalyst) {
      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: null,
        event_type: AuditEvent.AGENT_NOTE,
        target_type: "case",
        target_id: caseId,
        payload: { note: plan.noteForAnalyst },
      });
    }
  }

  // The agent can also decide this is beyond a form.
  //
  // Severity classification catches the physical emergencies — fire, injuries
  // — and misses everything else that needs a person: an expired policy, a DNI
  // that is not the holder's, someone mentioning a lawyer, someone too
  // distressed to answer questions. Those are judgement, which is exactly what
  // was missing, and escalating is the conservative direction: the cost of a
  // wrong escalation is a person reading a case they did not need to.
  //
  // Routed through the same code as a severity escalation so there is one
  // place where escalation happens, one audit event, and one guarantee that a
  // specialist is actually told.
  if (plan?.intent === "escalate" && !derivaSola) {
    // Quién figura en el padrón, para que el mensaje pueda nombrarlo. Aunque
    // haya salido un conflicto: ése puede ser de otro dato, y el que explica por
    // qué pasa a una persona es éste.
    const titularIniciales = await inicialesDelTitularAjeno(
      caseId,
      tenantId,
      extractedClaim,
      claimantName,
      plan.toolCalls ?? []
    );

    await escalate({
      caseId,
      tenantId,
      senderEmail,
      latestMessageText,
      inReplyToMessageId,
      messenger,
      severity: extractedClaim.severity,
      claimantName,
      titularIniciales,
      claimTypeValue,
      reason: plan.reasoning,
      // Aunque el conflicto ya haya salido: ése le pidió que conteste por acá, y
      // en `requiere_especialista` esa respuesta no la lee nadie. Éste la anula
      // y avisa el traspaso. El del titular ajeno ya lo trae y no llega hasta acá.
      yaPreguntamos: confirmationEmailDispatched,
    });
    return;
  }

  // Anything a lookup just filled in is no longer outstanding, and must not be
  // carried back onto the list by the keep-asking rule below.
  const justResolved = new Set(
    (plan?.resolved ?? []).flatMap((r) => [r.field, canonicalFieldKey(r.field)])
  );
  const stillOutstanding = everythingOutstanding.fields.filter(
    (k) => !justResolved.has(k)
  );

  // Sin plan —la deliberación se cayó, un 429 del proveedor alcanza— nadie
  // decidió que hubiera algo nuevo que pedir, así que no se inventa: se repite
  // el pedido que ya está en pie. Un ensayo mostró lo contrario: la
  // deliberación falló, la tabla armó la lista desde cero y la persona, que
  // había escrito «gracias», recibió cinco puntos donde antes había cuatro. Un
  // problema nuestro con el proveedor se leyó como que nadie estaba leyendo.
  //
  // Sólo cuando no queda nada de aquel pedido —o cuando nunca hubo uno— se
  // arma con lo que falta: alguien que escribe por primera vez tiene que
  // recibir respuesta aunque el agente no haya podido pensar.
  const heredado = keepAskingForWhatIsStillNeeded([], lastAsked, stillOutstanding);
  const chosen = plan
    ? keepAskingForWhatIsStillNeeded(plan.askFor, lastAsked, stillOutstanding)
    : heredado.length > 0
      ? heredado
      : stillOutstanding.slice(0, MAX_ASK_ITEMS);

  const askItems = {
    fields: chosen,
    knownValues: Object.fromEntries(
      chosen
        .filter((k) => k in everythingOutstanding.knownValues)
        .map((k) => [k, everythingOutstanding.knownValues[k]])
    ),
  };

  // Not when the case escalated. A claimant whose car burned this morning was
  // told "la derivamos a un especialista, no hace falta que hagas nada" and,
  // three seconds later, asked for their DNI, the date and the address. On
  // WhatsApp the two land as adjacent bubbles contradicting each other.
  //
  // The gaps are still recorded, so the specialist opens the case and sees
  // exactly what is missing — and asks for it on the call, which is what the
  // first message promised. The cost is that an analyst starts with less
  // loaded; the person gets one coherent message and the case sits in the
  // queue it belongs to.
  // Silence when the answer would be word for word the request we already
  // made. See alreadyAskedFor: this is the difference between following up and
  // nagging, and the claimant experiences it as whether anyone is reading.
  //
  // Y tras un acuse solo, lo que queda de aquel pedido tampoco es un pedido
  // nuevo: si la lista se achicó, fue porque la extracción cambió de idea.
  const askAlreadyMade =
    askItems.fields.length > 0 &&
    ((soloAcuse && askItems.fields.every((k) => lastAsked.includes(k))) ||
      (await alreadyAskedFor(caseId, tenantId, askItems.fields)));
  // The agent can also decide there is nothing worth saying — someone who
  // wrote "ok" after being asked for a document has not moved the claim, and
  // repeating the request at them is the difference between following up and
  // nagging. Treated exactly like an ask we have already made: quiet, but
  // still waiting on them.
  const agentIsWaiting = plan?.intent === "wait";

  // Except when they asked us something. The no-repeat guard exists so an
  // unchanged request is not sent twice; a person who wrote "¿cuánto tarda?"
  // while the same two documents are still missing has changed nothing about
  // the request and everything about whether we owe them a message. Silence
  // there is the exact robot behaviour this was all meant to fix.
  //
  // Sin plan —un 429, un timeout— la pregunta sale del mensaje mismo: si no,
  // con el pedido en pie, «¿cuánto tarda?» quedaba sin respuesta. Con plan,
  // manda el plan.
  const pregunta = plan ? plan.question : laPreguntaDelMensaje(latestMessageText);
  const owesAnAnswer = Boolean(pregunta);

  // Same for a file that just arrived. They went and photographed something;
  // getting nothing back reads as nobody looking, whether or not we managed to
  // recognise what it was.
  // Una sola lectura de «cuándo hablamos» para las dos preguntas de abajo: no
  // hay ninguna escritura entre ellas. Ver `cuandoHablamosPorUltimaVez`.
  const hablamos = await cuandoHablamosPorUltimaVez(caseId, tenantId);
  const somethingArrived = await filesArrivedSinceWeLastSpoke(
    caseId,
    tenantId,
    hablamos
  );

  // La decisión se toma en el núcleo, que es puro y está probado con siete
  // booleanos: src/core/case/reply-decision.ts. Acá sólo se juntan las señales.
  //
  // El razonamiento largo que estaba en este lugar —por qué no se repite el
  // pedido, por qué callarse no es lo mismo que no tener nada que decir, y por
  // qué un «ok» no merece acuse— se mudó con la función. Está donde se puede
  // leer al lado de las reglas que describe, y donde hay un test por cada una.
  const señalesBase = {
    yaSePidio: askAlreadyMade,
    elAgenteEspera: agentIsWaiting,
    nosPreguntoAlgo: owesAnAnswer,
    llegoUnArchivo: somethingArrived,
    nosContestoElPedido,
    datosQueFaltan: askItems.fields.length,
    esGrave: derivaSola,
  } as const;

  const askOnHold = elPedidoQuedaEnEspera({ ...señalesBase, aprendimosAlgo: false });

  // La consulta de «¿aprendimos algo?» sólo se hace si puede cambiar la
  // decisión. Antes el `&&` la salteaba por corto circuito y sería una pena
  // perder eso: es una ida a la base por cada caso que no está en espera.
  //
  // Y sin plan tampoco se acusa recibo. El acuse se apoya en que el agente
  // deliberó y no dijo «espero»: eso es un juicio sobre el último mensaje. Si
  // la deliberación se cayó no hay juicio ninguno, y la extracción —que relee
  // la conversación entera en cada vuelta— alcanza para que un «gracias»
  // parezca noticia.
  const aprendimosAlgo =
    plan && askOnHold && !agentIsWaiting && !derivaSola
      ? await factsLearnedSinceWeLastSpoke(caseId, tenantId, hablamos)
      : false;

  const decision = queHacer({ ...señalesBase, aprendimosAlgo });
  const askIsNew = decision === "pedir";
  const acknowledgeOnly = decision === "acusar-recibo";

  if (askIsNew && !confirmationEmailDispatched && !derivaSola) {
    await messenger.send({
      caseId,
      tenantId,
      to: senderEmail,
      lastMessage: latestMessageText,
      template: "missing_information_request",
      data: {
        caseId,
        missingFields: askItems.fields,
        knownValues: askItems.knownValues,
        claimantName,
        // What they asked, so the reply answers it instead of talking past it.
        question: pregunta,
        // Fourth message in, the reply still opened with "gracias por
        // contactarnos". Thanking someone for getting in touch three rounds
        // after they did is the tell that nobody is really reading.
        isFollowUp: await hasPriorOutbound(caseId, tenantId),
      },
      inReplyToMessageId,
    });

    missingInfoEmailDispatched = true;

    // A genuine gap outranks a doubt: the case is blocked, not merely unsure.
    await setStatus(
      caseId,
      tenantId,
      missingInfoEmailComing ? "info_faltante" : "confirmacion_pendiente"
    );

    // Audit: MISSING_INFO_REQUESTED.
    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.MISSING_INFO_REQUESTED,
      target_type: "case",
      target_id: caseId,
      payload: { missing_fields: gapResult.missingRequiredFields },
    });
  } else if (askOnHold && !derivaSola && !confirmationEmailDispatched) {
    // We asked for exactly this and they have not answered it yet. Nothing to
    // say, but the case is still blocked on it — leaving the status alone here
    // would let the branch below mark a claim ready while a document nobody
    // has sent is still outstanding.
    await setStatus(
      caseId,
      tenantId,
      missingInfoEmailComing ? "info_faltante" : "confirmacion_pendiente"
    );
  } else if (!derivaSola && !confirmationEmailDispatched) {
    // Nothing was asked, so nothing is being waited on.
    //
    // The analyzer can return confirmacion_pendiente over doubts we decided are
    // not worth an email — a derived province, a field ranked below the cap.
    // Taking that status at face value parked a complete claim as "waiting on
    // the claimant" in the same run that sent them a message saying we had
    // everything. A doubt nobody was asked about is a note for the analyst, not
    // a block on the case.
    //
    // The branches that do send a question set their own status above, so
    // reaching here means the conversation is finished as far as we are
    // concerned.
    await setStatus(caseId, tenantId, "listo_para_core");
  }

  if (acknowledgeOnly && !confirmationEmailDispatched && !missingInfoEmailDispatched) {
    await messenger.send({
      caseId,
      tenantId,
      to: senderEmail,
      lastMessage: latestMessageText,
      template: "information_received",
      data: {
        caseId,
        claimantName,
        // Sin la lista de lo que falta, deliberadamente.
        //
        // La pasé una vez «para que el redactor sepa qué no volver a pedir» y
        // el resultado fue: «Ana, tomamos nota de lo que nos contaste. Para
        // seguir, necesitamos que nos digas el número de póliza». O sea, el
        // pedido otra vez. Una lista de campos en el prompt es una lista de
        // cosas para pedir, diga lo que diga la instrucción de al lado.
        isFollowUp: true,
      },
      inReplyToMessageId,
    });

    acknowledgementDispatched = true;
  }

  // ── F. Acknowledge receipt — but only if nothing else already did ─────────
  //
  // confirmation_received is the fallback, not a fixture: it exists so a
  // claimant is never left without an answer. Every other branch already
  // acknowledges receipt and carries the case number, so adding this one on top
  // means two emails landing in the same second, the second saying less than
  // the first. A person handling the claim would send one message.
  //
  // The escalation was the first case of this — someone reporting a fire got
  // three at once. The rule generalises: if we said anything at all, we said
  // it, and this adds nothing.
  //
  // askAlreadyMade belongs in this list for a subtler reason: the claim is not
  // complete, we simply have nothing new to say about it. Without it, choosing
  // not to repeat a question would fall through to "ya tenemos todo lo
  // necesario" — which is worse than asking twice, because it is false.
  const somethingElseWasSaid =
    derivaSola ||
    confirmationEmailDispatched ||
    missingInfoEmailDispatched ||
    acknowledgementDispatched ||
    askOnHold;

  if (!somethingElseWasSaid && !(await checkConfirmationAlreadySent(caseId, tenantId))) {
    // Have we written to this claimant before? If so this is a closing, not an
    // acknowledgement, and it should not open by thanking them for getting in
    // touch two rounds after they did.
    const isFollowUp = await hasPriorOutbound(caseId, tenantId);

    // Extract claim_type and policy_number from fields for the email template.
    const claimTypeField = extractedClaim.fields.find((f) => f.field_key === "claim_type");
    const policyField = extractedClaim.fields.find((f) => f.field_key === "policy_number");

    await messenger.send({
      caseId,
      tenantId,
      to: senderEmail,
      lastMessage: latestMessageText,
      template: "confirmation_received",
      data: {
        caseId,
        claimType: claimTypeField?.field_value ?? null,
        // policyNumber passed through; template masks it (AC24).
        policyNumber: policyField?.field_value ?? null,
        isFollowUp,
        claimantName,
        question: pregunta,
      },
      inReplyToMessageId,
    });
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Close the confirmations the claimant just answered.
 *
 * Without this the case loops. A pending row is written when a field is
 * uncertain; the gap analyzer reads pending rows straight back out as "needs
 * confirmation"; the orchestrator then re-asks and rewrites the row as pending.
 * So a claimant who replied "fue un choque" — lifting claim_type from 0.70 to
 * 0.90 — was asked to confirm "choque de vehículo", the thing they had just
 * said in their own words, and would have been asked again after answering
 * that, forever.
 *
 * `confirmed` rather than `corrected`: the value we hold now came from the
 * claimant, whether they restated it or we simply read the message better.
 */
async function resolveAnsweredConfirmations(
  caseId: string,
  tenantId: string,
  fields: ExtractedClaim["fields"],
  latestMessageText: string | undefined,
  /**
   * The keys the last message we sent actually put in front of this person.
   *
   * Only used to decide what counts as *them answering*. A row also closes
   * when the extraction re-reads the whole conversation and comes back more
   * confident about something nobody ever asked them — the province inferred
   * from an address, read twice. That is us changing our mind, not them
   * replying, and treating it as a reply made a "gracias" pull the entire
   * request list back onto the screen.
   *
   * Same guard, and the same reason, as the one `resolveDeclinedDocs` takes:
   * a question that was never asked cannot have been answered.
   */
  alreadyAsked: string[]
): Promise<string[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  // Una franja del día segura sigue sin ser una hora: la fila queda pendiente.
  const settled = new Set(
    fields
      .filter(
        (f) => f.confidence >= MEDIUM_CONFIDENCE_HIGH && !esValorVago(f.field_key, f.field_value)
      )
      .map((f) => canonicalFieldKey(f.field_key))
  );

  // "Confirmo" is an answer even though it adds no data. The email asks for
  // that exact word and nothing read it, so the claimant wrote it, extraction
  // re-ran, the inferred value came back at the same confidence it always had,
  // and the identical email went out again. Answering the way we asked left
  // them where they started.
  //
  // It closes what we asked about, not every pending row. A bare «ok» to a
  // list of several things never gets here: the caller drops the text.
  //
  // Menos heridos sin valor en esta corrida: un «ok» a «¿Hubo personas
  // lastimadas?» abierta no dice si hubo, y a una fila vieja con un «no» que la
  // persona nunca dijo no la puede confirmar. La hora sí: a «¿más o menos a qué
  // hora fue?» un «sí» es que no sabe más que la franja, y sin esto la pregunta
  // no se cerraba nunca.
  if (isAffirmativeReply(latestMessageText)) {
    const hayHeridosDicho = fields.some(
      (f) => canonicalFieldKey(f.field_key) === "hay_heridos" && !esValorVacio(f.field_value)
    );
    for (const asked of await askedPendingFields(caseId, tenantId, fields, alreadyAsked)) {
      if (canonicalFieldKey(asked) === "hay_heridos" && !hayHeridosDicho) continue;
      settled.add(asked);
    }
  }

  if (settled.size === 0) return [];

  try {
    // `returning` y no `[...settled]`: lo que devuelve esta funcion es la senal
    // de que la persona contesto lo que le pedimos, y para eso sirven las filas
    // que realmente estaban pendientes, no todos los campos que vinieron con
    // confianza alta —que en cada vuelta son casi todos.
    const cerradas = await enTenant(tenantCtx, (db) =>
      db
        .update(claimFieldConfirmations)
        .set({ status: "confirmed" })
        .where(
          and(
            eq(claimFieldConfirmations.case_id, caseId),
            eq(claimFieldConfirmations.status, "pending"),
            inArray(claimFieldConfirmations.field_name, [...settled])
          )
        )
        .returning({ campo: claimFieldConfirmations.field_name })
    );

    // Se cierran todas —si no, la vuelta siguiente las vuelve a preguntar—, y
    // cuentan como respuesta suya sólo las que le preguntamos. Ver `alreadyAsked`.
    const preguntadas = new Set(alreadyAsked);
    return cerradas.map((fila) => fila.campo).filter((campo) => preguntadas.has(campo));
  } catch (err) {
    logger.error({ code: errCode(err) }, "orchestrate.failed_to_resolve_confirmations");
    return [];
  }
}

/**
 * The pending fields the last message actually put in front of them.
 *
 * "Confirmo" agrees with what was on the page, so it must not close a doubt
 * that never made the list. This used to re-derive the subset by running the
 * same ranking again — which only held while the ranking was the only thing
 * choosing. Now that the agent picks what is worth asking, the list it chose
 * is recorded, and the caller reads it once and hands it down.
 *
 * The re-derivation stays as the fallback, for messages sent before the keys
 * were being written down.
 */
async function askedPendingFields(
  caseId: string,
  tenantId: string,
  fields: ExtractedClaim["fields"],
  recorded: string[]
): Promise<string[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  if (recorded.length > 0) return recorded;

  try {
    const rows = await enTenant(tenantCtx, (db) =>
      db
        .select({ field_name: claimFieldConfirmations.field_name })
        .from(claimFieldConfirmations)
        .where(
          and(
            eq(claimFieldConfirmations.case_id, caseId),
            eq(claimFieldConfirmations.status, "pending")
          )
        )
    );

    const ranked = collectConfirmableFields(
      rows.map((r) => r.field_name),
      fields
    );
    return buildAskList([], ranked).fields;
  } catch (err) {
    logger.error({ code: errCode(err) }, "orchestrate.failed_to_read_pending_confirmations");
    return [];
  }
}

/**
 * How many things one email may ask for.
 *
 * A real extraction flagged thirteen gaps at once. Sending someone who just
 * crashed their car thirteen demands gets no reply at all — the WhatsApp side
 * learned this first and caps at the same number.
 */
const MAX_ASK_ITEMS = 5;

/**
 * Campos de identidad: de quién es el valor sigue siendo una pregunta cuando
 * nadie lo pidió. «Mi esposa es Ana Paz» dice el nombre de Ana Paz tal cual, y
 * no es el del asegurado — un lugar o un número de póliza no tienen ese
 * problema. Ver `loDijoRecien`.
 */
const CAMPOS_DE_IDENTIDAD = new Set(["full_name", "dni", "email", "phone"]);

/**
 * The single list of everything we need, gaps and doubts together.
 *
 * Order is deliberate: what is missing blocks the claim, what is uncertain only
 * slows it. `email_or_phone` is an internal alias for "either of these", so it
 * goes out as the contact field a person recognises.
 *
 * Deterministic, because two callers depend on agreeing: the branch that sends
 * the email and the one that decides what a bare "Confirmo" answered.
 */
function buildAskList(
  missingRequiredFields: string[],
  pending: ConfirmableField[],
  outstandingDocs: string[] = [],
  opts: {
    cap?: boolean;
    /**
     * Values we hold, whatever the gap analyser thinks.
     *
     * A rehearsal caught the message this fixes: the claimant wrote "Soy
     * Roberto Paz, DNI 25.888.101" and the reply opened "¡Gracias, Roberto!"
     * and then asked for his name and surname. Both halves came from the same
     * run — the greeting used the extracted value, the list used the gap
     * analyser, and the two disagreed about whether we knew who he was.
     *
     * A field we can quote back is never missing. It might be uncertain, and
     * the honest question is "¿confirmás que sos Roberto Paz?" — never "decinos
     * tu nombre" to someone who just said it.
     */
    held?: Record<string, string>;
  } = {}
): { fields: string[]; knownValues: Record<string, string> } {
  const missing = missingRequiredFields
    .map((f) => (f === "email_or_phone" ? "email" : f))
    .filter((f) => isNameable(f));

  // A key we cannot name in Spanish never becomes a question. labelForField
  // always returns something — it title-cases the raw key — which is right for
  // an internal screen and wrong for a message: a rehearsal caught
  // `Injury severity: entendimos "none"` going out to someone who had just
  // crashed their car. The field stays on the case for the analyst.
  const nameable = (k: string) => isNameable(k);
  const seen = new Set(missing.filter(nameable));
  const doubts = pending.filter((p) => !seen.has(p.fieldKey) && nameable(p.fieldKey));
  const doubtKeys = new Set(doubts.map((d) => d.fieldKey));
  // Documents last. A missing field blocks the claim, a doubt slows it, and a
  // document is something the person has to go and photograph — the slowest
  // thing to ask for and the least urgent to have.
  const docs = outstandingDocs.filter(
    (k) => !seen.has(k) && !doubtKeys.has(k) && nameable(k)
  );

  const ordered = [...missing, ...doubts.map((d) => d.fieldKey), ...docs];
  // Uncapped when the caller wants the whole picture: the agent choosing what
  // is worth asking has to see everything before it decides what to leave out.
  const fields = opts.cap === false ? ordered : ordered.slice(0, MAX_ASK_ITEMS);

  // Lo que ya tenemos, dicho como una persona: un solo lugar, y de acá lo
  // toman el agente, el redactor y los pisos. La base guarda el valor crudo.
  const hoy = diaArgentino();
  const propuestos = new Map(pending.map((p) => [canonicalFieldKey(p.fieldKey), p.proposedValue]));
  const knownValues: Record<string, string> = {};
  for (const key of fields) {
    // Un documento se manda, no se confirma: el «si» del extractor dice que lo
    // nombró, no qué es.
    if (isDocument(key)) continue;
    const canon = canonicalFieldKey(key);
    // Con fila pendiente se muestra ése y ningún otro: es el valor que cierra
    // un «Confirmo».
    const crudo = propuestos.has(canon)
      ? propuestos.get(canon)
      : (opts.held?.[key] ?? opts.held?.[canon]);
    // Una franja del día no se confirma: se pide la hora, siempre igual.
    const legible = esValorVago(key, crudo) ? null : valorLegible(key, crudo, hoy);
    if (legible !== null) knownValues[key] = legible;
  }

  return { fields, knownValues };
}

/**
 * Write down what the agent found by looking, not by asking.
 *
 * Stored at high confidence and marked as coming from a lookup, because that
 * is what it is: our own record of a policy is better evidence than a person
 * typing the number from memory on a phone, and it should not sit in the
 * medium-confidence band waiting for them to confirm what we already know.
 *
 * `validate` exige que el plan haya llamado a ALGUNA herramienta antes de
 * aceptar un `resolved` — pero no comprueba que el campo resuelto venga de esa
 * llamada. Decía acá que «nada de lo que llega fue inventado», y era falso.
 *
 * ── Por qué un documento nunca se resuelve por búsqueda ──────────────────────
 *
 * Un dato lo podemos averiguar: el número de póliza está en nuestro propio
 * padrón. Un documento no: la denuncia policial, el parte amistoso y las fotos
 * de los daños son archivos que existen del lado de la persona, y ninguna
 * herramienta los produce.
 *
 * Con una sola llamada a `polizas_por_dni` en el plan, el modelo podía nombrar
 * `denuncia_policial` en `resolved` y el pedido del documento se cerraba: el
 * caso podía llegar a `listo_para_core` y exportarse a la aseguradora diciendo
 * que teníamos el parte policial de un robo. No lo teníamos — teníamos la
 * palabra del modelo. Comprobado: `validate` acepta ese plan.
 *
 * Se FILTRA en vez de rechazar el plan entero. Rechazarlo manda todo a la rama
 * determinista y se pierde la parte buena —la respuesta a lo que la persona
 * preguntó—, que es exactamente el costo que documenta `validate` unas líneas
 * más arriba, donde una regla demasiado estricta hizo que se le pidieran fotos
 * a un hombre cuya póliza había vencido en 2020. Acá se descarta lo imposible,
 * se conserva lo demás, y queda dicho en el log.
 */
async function recordLookedUpFields(
  caseId: string,
  tenantId: string,
  resolvedCrudo: Array<{ field: string; value: string }>,
  /** Lo que devolvieron las consultas de este plan, en crudo. */
  lookupResults: readonly string[]
): Promise<void> {
  const documentos = resolvedCrudo.filter((r) => isDocument(r.field));
  const datos = resolvedCrudo.filter((r) => !isDocument(r.field));

  /*
   * ── Y el valor tiene que estar en lo que devolvió alguna consulta ──────────
   *
   * `validate` exige que el plan haya llamado a alguna herramienta, no que el
   * valor venga de alguna. Con `polizas_por_dni → { encontradas: 0 }` en el
   * plan, un `policy_number = "POL-INVENTADA-9999"` pasaba: se guardaba con
   * confianza 0.95 —la más alta que maneja el sistema— y encima cerraba el
   * pedido de ese campo, así que nunca se le volvía a preguntar a la persona.
   *
   * El comentario del propio campo `resolved` ya lo advertía: «un modelo que
   * puede escribir valores de memoria es un modelo que puede inventar un número
   * de póliza». La guarda que lo impedía no existía.
   *
   * Se descarta lo no respaldado y se conserva el resto, por lo mismo que con
   * los documentos: rechazar el plan entero manda todo a la rama determinista y
   * se pierde la respuesta a lo que la persona preguntó.
   */
  const { respaldados: resolved, sinRespaldo } = separarPorRespaldo(
    datos,
    lookupResults
  );

  if (sinRespaldo.length > 0) {
    logger.warn({
        case_id: caseId,
        // Los nombres, no los valores: el valor es justamente lo dudoso.
        campos: sinRespaldo.map((r) => r.field),
        consultas: lookupResults.length,
        detalle:
          "El agente dijo haber encontrado un valor que no aparece en lo que " +
          "devolvió ninguna consulta. Se descarta: el campo sigue faltando.",
      }, "agent.resolvio_sin_respaldo");
  }

  if (documentos.length > 0) {
    logger.warn({
        case_id: caseId,
        // Los nombres, no los valores: el valor es texto que escribió una persona.
        campos: documentos.map((d) => d.field),
        detalle:
          "El agente dijo haber resuelto por búsqueda un archivo que sólo puede " +
          "mandar la persona. Se descarta: el pedido sigue abierto.",
      }, "agent.resolvio_un_documento");
  }

  if (resolved.length === 0) return;

  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    await enTenant(tenantCtx, (db) =>
      db
        .insert(extractedFields)
        .values(
          resolved.map((r) => ({
            case_id: caseId,
            tenant_id: tenantId,
            field_key: canonicalFieldKey(r.field),
            field_value: r.value,
            confidence: "0.95",
          }))
        )
        .onConflictDoUpdate({
          target: [extractedFields.case_id, extractedFields.field_key],
          set: {
            field_value: sql`excluded.field_value`,
            confidence: sql`excluded.confidence`,
          },
        })
    );

    // Closes the request too, so the next round does not ask for the document
    // or field we just filled in ourselves.
    await enTenant(tenantCtx, (db) =>
      db
        .update(missingDocs)
        .set({ satisfied_at: new Date().toISOString() })
        .where(
          and(
            eq(missingDocs.case_id, caseId),
            isNull(missingDocs.satisfied_at),
            inArray(
              missingDocs.doc_key,
              resolved.flatMap((r) => [r.field, canonicalFieldKey(r.field)])
            )
          )
        )
    );

    logger.info({
        case_id: caseId,
        fields: resolved.map((r) => r.field),
      }, "agent.resolved_by_lookup");
  } catch (err) {
    // The claim survives: the field simply stays missing and gets asked for.
    logger.error({ code: errCode(err) }, "orchestrate.failed_to_store_looked_up_fields");
  }
}

/**
 * El titular del padrón en iniciales, cuando quien escribe no es esa persona.
 *
 * `verificar_poliza` ya detecta esto —devuelve `titular_coincide: false`— y a
 * propósito NO le dice el nombre al modelo: un número de póliza se adivina, y
 * ésa es la línea entre una línea de siniestros y un servicio de consulta del
 * padrón. Así que las iniciales se arman acá, del lado del servidor, leyendo
 * la base, y lo único que puede salir del sistema es «R*** P***».
 *
 * Devuelve null —y entonces el mensaje no nombra ningún padrón— cuando no hay
 * con qué comparar, cuando el titular ES quien escribe, y cuando los dos
 * nombres son el mismo: un padre y un hijo homónimos con documentos distintos
 * existen, y ahí las iniciales al lado del nombre entero lo dirían entero.
 */
async function inicialesDelTitularAjeno(
  caseId: string,
  tenantId: string,
  extractedClaim: ExtractedClaim,
  nombreQueDijo: string | null,
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>
): Promise<string | null> {
  const dicho = (key: string) =>
    extractedClaim.fields.find((f) => canonicalFieldKey(f.field_key) === key)
      ?.field_value?.trim() || null;

  /*
   * Los mismos dos valores que comparó `verificar_poliza`, no los extraídos.
   *
   * En el ensayo la herramienta la buscó como «POL-3390-F» y la encontró,
   * mientras el emparejador —que usa el campo extraído— devolvía cero
   * coincidencias para la misma póliza: el modelo escribe el número de una
   * forma en el campo y de otra en la llamada, y el guion no se normaliza a
   * propósito (ver `normalizarNumeroPoliza`). Buscar con el número que ya
   * resolvió es lo único que hace que esto no dependa de cuál de las dos
   * formas eligió el modelo ese día.
   */
  const verificada =
    toolCalls.find((c) => c.tool === "verificar_poliza")?.args ?? {};
  const texto = (v: unknown) =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;

  const numero = texto(verificada.numero_poliza) ?? dicho("policy_number");
  const dni = texto(verificada.dni) ?? dicho("dni");
  if (!numero || !dni || !nombreQueDijo) return null;

  try {
    // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
    const titular = firstRow(
      await enTenant({ tenantId }, (db) =>
        db
          .select({ nombre: customers.full_name, dni: customers.dni })
          .from(policies)
          .leftJoin(customers, eq(policies.customer_id, customers.id))
          // Los dos lados sin espacios y en mayúsculas, igual que los
          // buscadores: el número lo tipea una persona.
          .where(
            sql`upper(replace(${policies.policy_number}, ' ', '')) = ${normalizarNumeroPoliza(numero)}`
          )
          .limit(1)
      )
    );

    if (!titular?.nombre || !titular.dni) {
      // Sin nombres ni números: que la póliza no apareció es lo que hay que
      // poder leer cuando el mensaje sale sin los dos valores.
      logger.info({ case_id: caseId }, "escalation.holder_not_found");
      return null;
    }
    if (normalizarDni(titular.dni) === normalizarDni(dni)) return null;
    if (mismoNombre(titular.nombre, nombreQueDijo)) return null;

    return maskFullName(titular.nombre);
  } catch (err) {
    // Sin las iniciales el mensaje dice menos; sin derivación no se entera
    // nadie. La derivación gana.
    logger.error({ code: errCode(err) }, "orchestrate.holder_lookup_failed");
    return null;
  }
}

/**
 * Hand the case to a person, and make sure a person is actually told.
 *
 * One function because there are now two ways in and they must not diverge.
 * Severity classification catches the physical emergencies — fire, injuries —
 * and the agent catches the rest: an expired policy, a DNI that is not the
 * holder's, someone mentioning a lawyer, someone too distressed to answer
 * questions. Both owe the claimant the same message and the specialist the
 * same alert.
 *
 * The alert is not optional. The message above promises that a specialist will
 * be in touch; until `alertSpecialists` existed, nothing made that true — the
 * case changed status and waited for somebody to notice it.
 */
async function escalate(opts: {
  caseId: string;
  tenantId: string;
  senderEmail: string;
  latestMessageText?: string;
  inReplyToMessageId?: string;
  messenger: AgentMessenger;
  severity: string | null | undefined;
  /** El nombre de pila, para que el redactor no salude a un desconocido. */
  claimantName?: string | null;
  /**
   * El titular del padrón en iniciales, cuando no es quien escribe.
   *
   * Con el nombre que dio quien escribe —`claimantName`— son los dos valores
   * que no coinciden, y son lo único que esa persona necesita para saber qué
   * contestar. Nunca el nombre entero: ver `inicialesDelTitularAjeno`.
   */
  titularIniciales?: string | null;
  claimTypeValue: string | null;
  summary?: string | null;
  reason: string;
  /**
   * Alguien se lastimó: la derivación abre con una frase de cuidado. La pasa
   * la derivación por gravedad y la que sale porque hay heridos aunque la
   * gravedad no lo pida; nunca la del titular ni la de póliza sin gravedad.
   * Es sólo el booleano: ni el mensaje, ni el redactor, ni la auditoría
   * necesitan el detalle médico.
   */
  heridos?: boolean;
  /**
   * Ya le mandamos en esta vuelta un mensaje que avisa el traspaso.
   *
   * Suprime SÓLO el mensaje al asegurado. El estado, el registro de
   * auditoría y el aviso al especialista pasan igual: la garantía que este
   * camino promete es que un especialista se entere, y eso no depende de lo
   * que lea el asegurado.
   */
  yaLeEscribimos?: boolean;
  /**
   * Ya le preguntamos algo en esta vuelta —el pedido de confirmación de un
   * conflicto común— y la derivación sale igual: el mensaje le dice que no
   * hace falta contestarlo.
   */
  yaPreguntamos?: boolean;
}): Promise<void> {
  const { caseId, tenantId, severity } = opts;
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  // Este contexto es lo único que le dice de quién son los datos.
  const tenantCtx: TenantContext = { tenantId };

  await setStatus(caseId, tenantId, "requiere_especialista");

  /*
   * Dos mensajes en la misma vuelta no pueden tirar para lados opuestos.
   *
   * Un familiar del titular escribe por el auto del padre, y el conflicto con
   * el padrón ya le dijo que esto lo revisa una persona y que sigue por otro
   * medio: ése es `yaLeEscribimos`, y la derivación no sale.
   *
   * Si el conflicto fue común, en cambio, le pidió que conteste cuál dato es
   * el correcto, y en `requiere_especialista` esa respuesta no la lee nadie.
   * Ahí la derivación sale igual, con `yaPreguntamos`: cierra la carga y le
   * dice que no hace falta contestar. Callarla dejaba a la persona contestando
   * a un chat que ya no lee nadie.
   *
   * Lo que NO se suprime nunca es nada de lo de abajo. El caso queda en
   * `requiere_especialista`, el evento se registra y al especialista se le
   * avisa.
   */
  if (opts.yaLeEscribimos) {
    logger.info({
        case_id: caseId,
        reason: "already_written_this_round",
      }, "escalation.claimant_message_skipped");
  } else {
    await opts.messenger.send({
      caseId,
      tenantId,
      to: opts.senderEmail,
      lastMessage: opts.latestMessageText,
      template: "specialist_escalation",
      data: {
        caseId,
        severity,
        claimantName: opts.claimantName ?? null,
        titularIniciales: opts.titularIniciales ?? null,
        ...(opts.heridos ? { heridos: true } : {}),
        ...(opts.yaPreguntamos ? { yaPreguntamos: true } : {}),
      },
      inReplyToMessageId: opts.inReplyToMessageId,
    });
  }

  await writeAuditLog({
    tenant_id: tenantId,
    actor_id: null,
    event_type: AuditEvent.SPECIALIST_REQUIRED,
    target_type: "case",
    target_id: caseId,
    payload: { severity, reason: opts.reason },
  });

  await alertSpecialists({
    caseId,
    tenantId,
    severity: severity ?? "high",
    claimTypeLabel: labelForClaimType(opts.claimTypeValue),
    summary: opts.summary ?? opts.reason,
  });
}

/**
 * Never drop something we asked for that is still missing.
 *
 * Letting the agent choose what is worth asking made the messages shorter and
 * better judged, and introduced a failure the fixed list could not have: the
 * choice varied between rounds. A rehearsal produced "necesitamos el parte y
 * la licencia", then "el parte y las fotos", then "las fotos y la licencia" —
 * each individually reasonable, and together the unmistakable impression that
 * nobody was keeping track.
 *
 * So the agent decides what to ADD, and the code decides what to KEEP. An item
 * we have already asked for stays on the list until it arrives or the claimant
 * says it does not exist; anything the agent newly judged worth asking is
 * appended after it. Order is stable too, which matters more than it sounds:
 * a person re-reading a list expects to find the same things in the same
 * places.
 */
function keepAskingForWhatIsStillNeeded(
  chosen: string[],
  previouslyAsked: string[],
  stillOutstanding: string[]
): string[] {
  const outstanding = new Set(stillOutstanding);

  // What we asked for last time and is still missing, in the order it was in.
  const carried = previouslyAsked.filter((k) => outstanding.has(k));
  const seen = new Set(carried);

  const added = chosen.filter((k) => outstanding.has(k) && !seen.has(k));

  return [...carried, ...added].slice(0, MAX_ASK_ITEMS);
}

/**
 * Every field value this extraction produced, by canonical key.
 *
 * Highest confidence wins when the extractor emits a field twice under
 * different names, which it routinely does.
 */
function valuesWeHold(fields: ExtractedClaim["fields"]): Record<string, string> {
  const held: Record<string, string> = {};
  const seen: Record<string, number> = {};

  for (const field of fields) {
    const value = field.field_value?.trim();
    if (!value || esValorVacio(value)) continue;

    const key = canonicalFieldKey(field.field_key);
    const confidence = Number(field.confidence) || 0;
    // La fecha a confianza baja o media no la dijo la persona, la infirió el
    // extractor — a veces sin ningún texto que la sostenga. El goteo del
    // 24/09 preguntó «¿es correcto que fue el 24 de septiembre?» sobre un
    // mensaje sin ninguna fecha. Mismo resguardo que `collectConfirmableFields`.
    if (key === "accident_date" && confidence < MEDIUM_CONFIDENCE_HIGH) continue;
    if (held[key] !== undefined && seen[key] >= confidence) continue;

    held[key] = value;
    held[field.field_key] = value;
    seen[key] = confidence;
  }

  return held;
}

interface ConfirmableField {
  fieldKey: string;
  proposedValue: string;
  confidence: number;
}

/**
 * Turn a pile of uncertain field keys into the questions actually worth asking,
 * best first.
 *
 * Three things happen here, each from a request that went out to a real inbox:
 *
 *  - Narrative fields are dropped. One email asked someone to confirm "Qué
 *    pasó" by quoting back the sentence they had just written.
 *  - Aliases collapse. The extractor emits `accident_description` and
 *    `descripcion_hecho` with identical text, so two rows appeared for one
 *    question; the higher-confidence copy wins.
 *  - Order is by how much the answer is worth, then by confidence. Sorting on
 *    confidence alone was useless: the model returns whole groups at exactly
 *    0.70, and the tie silently fell back to emission order.
 */
function collectConfirmableFields(
  uncertainKeys: string[],
  extracted: ExtractedClaim["fields"],
  /**
   * El valor que ya teníamos, por clave canónica: la fila pendiente.
   *
   * La extracción relee la conversación y a veces se saltea un campo. Pisar la
   * fila con "" convirtió «¿Fue a la tarde, correcto?» en «Más o menos a qué
   * hora fue.» en la vuelta siguiente, sin que la persona contestara (23/09).
   */
  guardados: Map<string, { valor: string; confianza: number }> = new Map()
): ConfirmableField[] {
  const byCanonical = new Map<string, ConfirmableField>();

  const confidenceOf = (key: string) =>
    extracted.find((f) => canonicalFieldKey(f.field_key) === canonicalFieldKey(key))
      ?.confidence;

  for (const rawKey of uncertainKeys) {
    if (!isWorthConfirming(rawKey)) continue;
    // Un documento se pide por `missing_docs`, que sabe si llegó y si la
    // persona dijo que no existe. Como duda volvía por la puerta de atrás: el
    // extractor lee «no completamos ningún parte» como parte_amistoso = "no" a
    // confianza media, y se le volvía a pedir el papel que acababa de negar.
    if (isDocument(rawKey)) continue;
    // Worked out from something we already read well — an analyst can correct
    // it without costing the claimant an email.
    if (isDerivable(rawKey, confidenceOf)) continue;
    // Una fecha inferida ("el sábado") o inventada sin texto que la sostenga
    // no se afirma como si la persona la hubiera dado. El 23/09 y el 24/09 el
    // goteo confirmó «20 de septiembre» y después «24 de septiembre» sobre
    // mensajes que sólo decían «el sábado» o nada. A confianza alta sí es un
    // dato que dio y se sigue preguntando como cualquier otro.
    if (
      canonicalFieldKey(rawKey) === "accident_date" &&
      (confidenceOf(rawKey) ?? 0) < MEDIUM_CONFIDENCE_HIGH
    )
      continue;

    const canonical = canonicalFieldKey(rawKey);

    // The value may be filed under either spelling — take the most confident.
    const candidates = extracted.filter(
      (f) => canonicalFieldKey(f.field_key) === canonical
    );
    const best = candidates.reduce<ExtractedClaim["fields"][number] | null>(
      (acc, f) => (acc === null || f.confidence > acc.confidence ? f : acc),
      null
    );

    const guardado =
      best && !esValorVacio(best.field_value) ? undefined : guardados.get(canonical);

    const existing = byCanonical.get(canonical);
    const confidence = guardado?.confianza ?? best?.confidence ?? 0;
    if (existing && existing.confidence >= confidence) continue;

    byCanonical.set(canonical, {
      fieldKey: canonical,
      proposedValue: guardado?.valor ?? best?.field_value ?? "",
      confidence,
    });
  }

  return [...byCanonical.values()].sort(
    (a, b) =>
      confirmationRank(a.fieldKey) - confirmationRank(b.fieldKey) ||
      a.confidence - b.confidence
  );
}

/** Extract a loggable error code from a thrown DB error (PII-safe). */
function errCode(err: unknown): string {
  return (
    (err as { code?: string })?.code ??
    (err instanceof Error ? err.name : "UnknownError")
  );
}

/** Update the case status (no FSM transition check — worker already validated). */
async function setStatus(
  caseId: string,
  tenantId: string,
  status: string
): Promise<void> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    await enTenant(tenantCtx, (db) =>
      db
        .update(cases)
        .set({
          status: status as CaseRow["status"],
          updated_at: new Date().toISOString(),
        })
        .where(eq(cases.id, caseId))
    );
  } catch (err) {
    logger.error({ code: errCode(err), case_id: caseId }, "orchestrate.failed_to_update_case_status");
  }
}

/**
 * Upsert a claim_field_confirmations row. Avoids duplicate pending rows.
 *
 * NOTE: the Neon schema has no unique constraint on (case_id, field_name),
 * so the "only one row per field per case" rule is emulated with an
 * update-then-insert (no ON CONFLICT target available).
 */
/**
 * Escribe (o pisa) las filas de confirmación de varios campos en tres viajes
 * fijos, en vez de tres por campo.
 *
 * No usa `onConflictDoUpdate` porque no hay índice único en
 * `(case_id, field_name)` — la 0001 indexa sólo `case_id`— y agregarlo pide una
 * migración a mano sobre datos que ya pueden tener duplicados. Con una lectura
 * previa alcanza y no hay que tocar el esquema.
 */
async function guardarConfirmaciones(
  caseId: string,
  tenantId: string,
  campos: Array<{
    fieldKey: string;
    proposedValue: string;
    confidence: number;
    /**
     * Lo que ya figuraba en el padrón, cuando lo que llegó no coincide.
     *
     * Antes iba `null` fijo y por eso la rama D —la de conflictos— no podía
     * usar esta función y escribía fila por fila.
     */
    conflictWithValue?: string | null;
    /** `confirmed` para lo que la persona escribió recién. Ver la rama C. */
    estado?: "pending" | "confirmed";
  }>
): Promise<void> {
  const tenantCtx: TenantContext = { tenantId };
  const ahora = new Date().toISOString();

  try {
    const claves = campos.map((c) => c.fieldKey);
    const existentes = await enTenant<Array<{ id: string; field_name: string }>>(
      tenantCtx,
      (db) =>
        db
          .select({
            id: claimFieldConfirmations.id,
            field_name: claimFieldConfirmations.field_name,
          })
          .from(claimFieldConfirmations)
          .where(
            and(
              eq(claimFieldConfirmations.case_id, caseId),
              inArray(claimFieldConfirmations.field_name, claves)
            )
          )
    );

    const porClave = new Map(existentes.map((e) => [e.field_name, e.id]));
    const nuevos = campos.filter((c) => !porClave.has(c.fieldKey));
    const aPisar = campos.filter((c) => porClave.has(c.fieldKey));

    if (nuevos.length > 0) {
      await enTenant(tenantCtx, (db) =>
        db.insert(claimFieldConfirmations).values(
          nuevos.map((c) => ({
            case_id: caseId,
            tenant_id: tenantId,
            field_name: c.fieldKey,
            suggested_value: c.proposedValue,
            conflict_with_value: c.conflictWithValue ?? null,
            confidence: c.confidence.toFixed(2),
            status: c.estado ?? "pending",
            created_at: ahora,
          }))
        )
      );
    }

    /*
     * Los que ya estaban se pisan de a uno, y eso está bien acá.
     *
     * Cada uno lleva su propio valor y su propia confianza, así que un UPDATE
     * masivo pediría un CASE por columna. Y en la práctica esta rama casi
     * siempre está vacía o tiene uno: los repetidos son los que el asegurado
     * todavía no contestó y cuyo valor no cambió.
     */
    for (const c of aPisar) {
      await enTenant(tenantCtx, (db) =>
        db
          .update(claimFieldConfirmations)
          .set({
            suggested_value: c.proposedValue,
            conflict_with_value: c.conflictWithValue ?? null,
            confidence: c.confidence.toFixed(2),
            status: c.estado ?? "pending",
            created_at: ahora,
          })
          /*
           * `status = "pending"` en el WHERE, no solo el id.
           *
           * Pisar una fila que el asegurado todavia no contesto esta bien.
           * RESUCITAR una que el analista ya cerro —confirmed o corrected— no:
           * el UPDATE la devolvia a `pending` y el pedido salia de nuevo, asi
           * que a la persona se le preguntaba dos veces por un dato que ya
           * habia dado y que alguien ya habia validado.
           */
          .where(
            and(
              eq(claimFieldConfirmations.id, porClave.get(c.fieldKey)!),
              eq(claimFieldConfirmations.status, "pending")
            )
          )
      );
    }
  } catch (err) {
    logger.error({ code: errCode(err), case_id: caseId }, "orchestrate.guardarconfirmaciones");
  }
}

/**
 * Have we already asked for exactly this, and heard nothing back about it?
 *
 * Every inbound message starts a fresh round, and a round that finds the same
 * gap sends the same request again. A claimant answered the question about
 * injuries and then forwarded a contact card, and got three messages inside
 * ninety seconds all asking for the friendly accident report. Each round was
 * individually correct: the document was outstanding, so it asked.
 *
 * What was missing is memory of having spoken. The prose cannot be compared —
 * the composer rewrites it every time — so this compares the keys.
 *
 * Only a sent message counts. A request that failed to go out was never made,
 * and staying quiet about it would leave the claim waiting on an answer to a
 * question nobody heard.
 *
 * Note that this deliberately never expires. Nudging someone who has gone
 * quiet is a good idea and a different one: it belongs to a job that decides
 * when a silence has gone on too long, not to whatever unrelated message
 * happened to arrive next.
 */
async function alreadyAskedFor(
  caseId: string,
  tenantId: string,
  keys: string[]
): Promise<boolean> {
  if (keys.length === 0) return false;

  const previous = await lastAskedKeys(caseId, tenantId);
  if (previous.length !== keys.length) return false;

  const before = new Set(previous);
  return keys.every((k) => before.has(k));
}

/**
 * Has a file arrived since the last thing we said?
 *
 * Sending a document and getting nothing back is its own kind of ignored. The
 * no-repeat guard is right that an unchanged request should not go out twice,
 * and wrong to conclude that nothing happened: the claimant went and
 * photographed something. Even when we cannot tell what the file is — a blurry
 * page, a screenshot — "recibimos tu archivo" is true and silence is not.
 *
 * Compared against the last outbound rather than tracked separately: the
 * question is only ever "since we last spoke", and both timestamps already
 * exist.
 */
/**
 * Cuándo salió lo último que dijimos. `null` si nunca dijimos nada.
 *
 * Las dos preguntas de «¿pasó algo desde que hablamos?» —un archivo que llegó
 * y un dato que aprendimos— leían esta misma fila por separado, una detrás de
 * la otra y sin nada que escriba en el medio. Es la ÚNICA de las lecturas de
 * `outbound_messages` de este archivo que sobra.
 *
 * Las otras no: `hasPriorOutbound` se pregunta antes y después de mandar, y
 * tiene que dar distinto —si diera lo de antes, el cuarto mensaje volvería a
 * abrir con «gracias por contactarnos», que es el bug que su comentario
 * describe—. Ahí la repetición no es un desperdicio: es el punto.
 */
async function cuandoHablamosPorUltimaVez(
  caseId: string,
  tenantId: string
): Promise<string | null> {
  /*
   * Atrapa acá, y no en quien llama.
   *
   * Esta lectura estaba adentro de las dos funciones que la usaban, cada una con
   * su `catch`. Al sacarla afuera quedó por un momento sin ninguno, y un test la
   * agarró: un hipo de la base dejaba de devolver «no sabemos» y pasaba a tirar
   * abajo la orquestación entera.
   *
   * `null` es lo mismo que decía antes: las dos preguntas de «¿pasó algo desde
   * que hablamos?» contestan que no, y el resto sigue.
   */
  try {
    const fila = firstRow(
      await enTenant({ tenantId }, (db) =>
        db
          .select({ created_at: outboundMessages.created_at })
          .from(outboundMessages)
          .where(
            and(
              eq(outboundMessages.case_id, caseId),
              inArray(outboundMessages.status, ["sent", "skipped_simulated"])
            )
          )
          .orderBy(desc(outboundMessages.created_at))
          .limit(1)
      )
    );
    return fila?.created_at ?? null;
  } catch (err) {
    logger.error(
      { code: errCode(err) },
      "orchestrate.ultimo_saliente_fallo"
    );
    return null;
  }
}

async function filesArrivedSinceWeLastSpoke(
  caseId: string,
  tenantId: string,
  hablamos: string | null
): Promise<boolean> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    if (!hablamos) return false;

    const since = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ id: claimAttachments.id })
          .from(claimAttachments)
          .where(
            and(
              eq(claimAttachments.case_id, caseId),
              gt(claimAttachments.created_at, hablamos),
              /*
               * Sólo las filas que traen bytes. Esta señal —que se llama «llegó
               * un archivo» y es la que el núcleo usa para sacar el pedido de
               * espera— se encendía con CUALQUIER fila rechazada, sin que hubiera
               * llegado nada: salía el mismo pedido de siempre, la lista entera
               * como si la foto hubiera entrado, sin una palabra sobre el motivo
               * porque ninguna plantilla lo menciona. No es nuevo ni es de
               * WhatsApp: el correo viene escribiendo `rejected_reason` desde
               * antes —189 filas con "storage_upload_failed" en producción,
               * contadas en `api/health/trabajo.ts`—, y el adjunto grande de
               * WhatsApp sólo sumó "size_exceeded". Repetir el pedido es peor que
               * callarse. Decirle al asegurado que lo mande más chico es un cambio
               * aparte, con plantilla propia.
               */
              isNull(claimAttachments.rejected_reason)
            )
          )
          .limit(1)
      )
    );
    return Boolean(since);
  } catch (err) {
    // Speaking is the safe direction here too.
    logger.error({ code: errCode(err) }, "orchestrate.failed_to_check_for_new_files");
    return false;
  }
}

/**
 * ¿Nos enteramos de algo nuevo desde la última vez que hablamos?
 *
 * Hermana de filesArrivedSinceWeLastSpoke, y por el mismo motivo: la regla de
 * no repetir el pedido acierta en que una petición sin cambios no se manda dos
 * veces, y se equivoca al concluir que no pasó nada. Alguien que contesta «fue
 * un choque, ayer a la tarde» mientras siguen faltando el nombre, la póliza y
 * el DNI no cambió el pedido y sí cambió si le debemos un mensaje.
 *
 * Se apoya en que extracted_fields hace upsert sobre (case_id, field_key) y NO
 * toca extracted_at al actualizar: una fila con fecha posterior a lo último que
 * dijimos es un dato que antes no teníamos. Un valor que CAMBIÓ —«no, fue el
 * martes»— no se detecta por acá; eso es una corrección, va por el camino del
 * conflicto, y decirlo así es más honesto que fingir que esto lo cubre.
 */
async function factsLearnedSinceWeLastSpoke(
  caseId: string,
  tenantId: string,
  hablamos: string | null
): Promise<boolean> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    if (!hablamos) return false;

    const since = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ id: extractedFields.id })
          .from(extractedFields)
          .where(
            and(
              eq(extractedFields.case_id, caseId),
              gt(extractedFields.extracted_at, hablamos)
            )
          )
          .limit(1)
      )
    );
    return Boolean(since);
  } catch (err) {
    // Callarse es la dirección insegura acá: ante la duda, contestar.
    logger.error({ code: errCode(err) }, "orchestrate.failed_to_check_for_new_facts");
    return false;
  }
}

/** Whether anything has already gone out to the claimant on this case. */
async function hasPriorOutbound(caseId: string, tenantId: string): Promise<boolean> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const rows = await enTenant(tenantCtx, (db) =>
      db
        .select({ id: outboundMessages.id })
        .from(outboundMessages)
        .where(
          eq(outboundMessages.case_id, caseId)
        )
        .limit(1)
    );
    return rows.length > 0;
  } catch (err) {
    // Fall back to the first-contact wording: greeting someone twice is a
    // smaller error than closing a conversation that never happened.
    logger.error({ code: errCode(err) }, "orchestrate.failed_to_check_prior_outbound");
    return false;
  }
}

/**
 * ¿El cierre es lo último que le dijimos a este caso?
 *
 * Es la regla AC12: mandalo siempre, pero una sola vez por cierre. Preguntaba
 * por el nombre del mail y nada más, así que en WhatsApp no frenaba nada: un
 * analista tocaba «Re-analizar» sobre un caso ya completo y al asegurado le
 * llegaba por segunda vez el mensaje de que su denuncia está lista.
 *
 * Y preguntaba si salió alguna vez: si después del cierre le pedimos algo, el
 * caso se reabrió, y el cierre que lo termina tiene que volver a salir. Si no,
 * la persona se queda con el último pedido y nunca se entera de que terminó.
 */
async function checkConfirmationAlreadySent(
  caseId: string,
  tenantId: string
): Promise<boolean> {
  // Los dos nombres de cada uno: el mail guarda `confirmation_received` y
  // WhatsApp `wa_confirmation_received`.
  const cierre = nombresEnElLibro("confirmation_received");
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const ultimo = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ template: outboundMessages.template })
          .from(outboundMessages)
          .where(
            and(
              eq(outboundMessages.case_id, caseId),
              inArray(outboundMessages.template, [
                ...cierre,
                ...nombresEnElLibro("missing_information_request"),
                ...nombresEnElLibro("data_confirmation_request"),
              ])
            )
          )
          .orderBy(desc(outboundMessages.created_at))
          .limit(1)
      )
    );

    return ultimo !== null && cierre.includes(ultimo.template);
  } catch (err) {
    logger.error({ code: errCode(err) }, "orchestrate.failed_to_check_outbound_messages");
    return false;
  }
}

/**
 * Extract the stored (customer record) value for a conflicting field.
 * Used to populate conflict_with_value in claim_field_confirmations.
 *
 * LLM06: We do not log this value — caller ensures no PII in audit payloads.
 */
function getStoredFieldValue(
  match: CustomerMatch,
  fieldKey: string
): string {
  /*
   * Devolvía `""` para todo lo que no fuera el nombre, y lo decía: «el valor
   * está en la base pero no llega por esta interfaz».
   *
   * El efecto era un mail que el asegurado no podía usar. Le llega «Campo: DNI
   * del titular. Obtuvimos el siguiente dato:» y nada después, así que no sabe
   * qué figura mal ni qué tiene que corregir. El caso queda en
   * `confirmacion_pendiente` esperando una respuesta que nadie puede dar.
   *
   * Y el valor estaba a mano: el buscador acababa de compararlo para DETECTAR
   * el conflicto. Ahora viaja en el match.
   *
   * Sin enmascarar a propósito: el analista lo ve entero en la pantalla, y el
   * enmascarado ocurre al renderizar el mail (`maskFieldValue` en
   * `data-confirmation-request`), que es donde corresponde — quien escribió
   * puede no ser el titular.
   */
  const guardado = match.storedValues?.[canonicalFieldKey(fieldKey)];
  if (guardado) return guardado;

  // El nombre sigue teniendo su atajo: `customerName` está en la interfaz desde
  // siempre y algunos buscadores lo llenan sin pasar por la fila completa.
  if (canonicalFieldKey(fieldKey) === "full_name") return match.customerName;

  return "";
}
