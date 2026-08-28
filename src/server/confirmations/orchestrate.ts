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
import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { queHacer, elPedidoQuedaEnEspera } from "@/core/case/reply-decision";
import { enTenant, type TenantContext } from "@/data/scope";
import { firstRow } from "@/lib/db/helpers";
import {
  cases,
  claimAttachments,
  claimFieldConfirmations,
  extractedFields,
  missingDocs,
  outboundMessages,
} from "@/lib/db/schema";
import type { CaseRow } from "@/lib/db/types";
import type { ExtractedClaim } from "@/lib/schemas/extracted-claim";
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
import {
  canonicalFieldKey,
  confirmationRank,
  isAffirmativeReply,
  isDerivable,
  isNameable,
  isWorthConfirming,
  labelForClaimType,
} from "@/lib/labels/claim-fields";
import { emailMessenger, type AgentMessenger } from "@/server/confirmations/messenger";
import { writeAuditLog, AuditEvent } from "@/lib/audit/log";

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
  messenger: AgentMessenger = emailMessenger
): Promise<void> {
  const { extractedClaim, senderEmail, inReplyToMessageId, latestMessageText } =
    extractedOutput;

  // ── A. Non-claim email — return early ─────────────────────────────────────
  if (extractedClaim.is_claim === false) {
    // Already handled by extraction worker (status=no_relevante).
    // No email should be sent for non-claim emails (AC5).
    return;
  }

  let confirmationEmailDispatched = false;

  // ── B. Severity escalation — AC11 ────────────────────────────────────────
  const severity = extractedClaim.severity;
  const isHighSeverity = severity === "high" || severity === "critical";

  if (isHighSeverity) {
    await escalate({
      caseId,
      tenantId,
      senderEmail,
      latestMessageText,
      inReplyToMessageId,
      messenger,
      severity,
      claimTypeValue: extractedClaim.fields.find(
        (f) => canonicalFieldKey(f.field_key) === "claim_type"
      )?.field_value ?? null,
      summary: extractedClaim.summary ?? null,
      reason: `severidad ${severity}`,
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

  // A field the claimant has now answered is no longer pending. Runs BEFORE
  // the gap analysis, which reads those rows straight back out.
  await resolveAnsweredConfirmations(
    caseId,
    tenantId,
    extractedClaim.fields,
    latestMessageText
  );

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

  // Who we are writing to. The claimant said their name in the first message
  // and the model greeted them by it; the second round arrived as a photo with
  // no caption, so the only text we handed the composer was "[Imagen adjunta
  // sin texto]" and the reply opened with a bare "¡Hola!". A name we already
  // hold should not be forgotten because the last thing said was a picture.
  const claimantName =
    extractedClaim.fields.find((f) => canonicalFieldKey(f.field_key) === "full_name")
      ?.field_value?.trim() || null;

  // What we have actually put in front of this person. Read before the
  // documents block, which needs it to know what could possibly be refused.
  const lastAsked = await lastAskedKeys(caseId, tenantId);

  await seedRequiredDocs(caseId, tenantId, claimTypeValue);

  // Y cerrar el contacto que ya tenemos por el canal: por WhatsApp el teléfono
  // es el remitente, y pedirle a alguien el número desde el que está escribiendo
  // es de las cosas que hacen que deje de contestar.
  await satisfyContactDocsWeAlreadyHave(caseId, tenantId, extractedClaim.fields);
  await reconcileAttachments(caseId, tenantId, labelForClaimType(claimTypeValue));

  // And close the ones they have just told us do not exist. Most crashes have
  // no friendly accident report — our own message says "si lo completaron" —
  // and until now "no completamos ninguno" was heard as silence: the request
  // stayed open, every round asked again, and the case died of abandonment two
  // weeks later.
  await resolveDeclinedDocs(caseId, tenantId, latestMessageText, lastAsked);

  const gapResult = await analyzeEmailClaimGaps(caseId, extractedClaim.fields, tenantId);

  // ── C. Medium-confidence fields → confirmation rows — AC7 ─────────────────
  //
  // Union of both opinions: if either side thinks a field is uncertain, ask.
  // Conflicts are excluded — branch D owns those and has the stored value to
  // show alongside.
  const uncertainKeys = [
    ...(extractedClaim.fields_pending_confirmation ?? []),
    ...gapResult.fieldsNeedingConfirmation
      .filter((f) => f.reason !== "conflict")
      .map((f) => f.fieldName),
  ];

  const pendingConfirmationFields = collectConfirmableFields(
    uncertainKeys,
    extractedClaim.fields
  );

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
   * llama a Gemini y contra un tope de 180 segundos.
   *
   * La forma ya estaba en este archivo: `resolveAnsweredConfirmations` hace un
   * solo UPDATE con `inArray` sobre esta misma tabla.
   */
  if (pendingConfirmationFields.length > 0) {
    await guardarConfirmaciones(caseId, tenantId, pendingConfirmationFields);

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

  // ── D. Customer conflict → confirmation rows — AC9 ────────────────────────
  for (const match of customerMatches) {
    if (match.conflictsWithExtracted.length === 0) continue;

    for (const conflictField of match.conflictsWithExtracted) {
      // Get the extracted value for this conflicting field.
      const extractedEntry = extractedClaim.fields.find((f) => f.field_key === conflictField);
      const extractedValue = extractedEntry?.field_value ?? "";
      const confidence = extractedEntry?.confidence ?? 0;

      // The stored value — which field in the customer record?
      const storedValue = getStoredFieldValue(match, conflictField);

      // Insert conflict confirmation row (extracted value vs stored customer value).
      await upsertFieldConfirmation(caseId, tenantId, {
        field_key: conflictField,
        proposed_value: extractedValue,
        confidence,
        conflict_with_value: storedValue,
      });

      // An escalated case keeps its own status and its own single message.
      if (isHighSeverity) continue;

      // Set case status to confirmacion_pendiente for conflict.
      await setStatus(caseId, tenantId, "confirmacion_pendiente");

      // Dispatch data_confirmation_request email.
      await messenger.send({
        caseId,
        tenantId,
        to: senderEmail,
        lastMessage: latestMessageText,
        template: "data_confirmation_request",
        data: {
          caseId,
          fieldKey: conflictField,
          proposedValue: extractedValue,
          conflictWithValue: storedValue,
        },
        inReplyToMessageId,
      });
      confirmationEmailDispatched = true;

      // Audit: CONFIRMATION_REQUESTED (field key only — no PII).
      await writeAuditLog({
        tenant_id: tenantId,
        actor_id: null,
        event_type: AuditEvent.CONFIRMATION_REQUESTED,
        target_type: "case",
        target_id: caseId,
        payload: { field_key: conflictField, reason: "conflict" },
      });
    }
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
    isHighSeverity,
    isComplete: everythingOutstanding.fields.length === 0,
  });

  if (plan) {
    await writeAuditLog({
      tenant_id: tenantId,
      actor_id: null,
      event_type: AuditEvent.AGENT_DELIBERATED,
      target_type: "case",
      target_id: caseId,
      payload: {
        intent: plan.intent,
        ask_for: plan.askFor,
        question: plan.question,
        // What it went and looked up before deciding.
        tools: plan.toolCalls,
        // The one thing nobody could answer before: why did it say that.
        reasoning: plan.reasoning,
      },
    });

    // What a lookup turned up goes onto the claim instead of into a question.
    // Searching by DNI, finding the policy number in our own database, and
    // then asking the claimant for it is exactly what a form does.
    const resolved = plan.resolved ?? [];
    if (resolved.length > 0) {
      await recordLookedUpFields(caseId, tenantId, resolved);
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
  if (plan?.intent === "escalate" && !isHighSeverity) {
    await escalate({
      caseId,
      tenantId,
      senderEmail,
      latestMessageText,
      inReplyToMessageId,
      messenger,
      severity: extractedClaim.severity,
      claimTypeValue,
      reason: plan.reasoning,
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

  const chosen = plan
    ? keepAskingForWhatIsStillNeeded(plan.askFor, lastAsked, stillOutstanding)
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
  const askAlreadyMade =
    askItems.fields.length > 0 &&
    (await alreadyAskedFor(caseId, tenantId, askItems.fields));
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
  const owesAnAnswer = Boolean(plan?.question);

  // Same for a file that just arrived. They went and photographed something;
  // getting nothing back reads as nobody looking, whether or not we managed to
  // recognise what it was.
  const somethingArrived = await filesArrivedSinceWeLastSpoke(caseId, tenantId);

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
    datosQueFaltan: askItems.fields.length,
    esGrave: isHighSeverity,
  } as const;

  const askOnHold = elPedidoQuedaEnEspera({ ...señalesBase, aprendimosAlgo: false });

  // La consulta de «¿aprendimos algo?» sólo se hace si puede cambiar la
  // decisión. Antes el `&&` la salteaba por corto circuito y sería una pena
  // perder eso: es una ida a la base por cada caso que no está en espera.
  const aprendimosAlgo =
    askOnHold && !agentIsWaiting && !isHighSeverity
      ? await factsLearnedSinceWeLastSpoke(caseId, tenantId)
      : false;

  const decision = queHacer({ ...señalesBase, aprendimosAlgo });
  const askIsNew = decision === "pedir";
  const acknowledgeOnly = decision === "acusar-recibo";

  if (askIsNew && !confirmationEmailDispatched && !isHighSeverity) {
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
        question: plan?.question ?? null,
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
  } else if (askOnHold && !isHighSeverity && !confirmationEmailDispatched) {
    // We asked for exactly this and they have not answered it yet. Nothing to
    // say, but the case is still blocked on it — leaving the status alone here
    // would let the branch below mark a claim ready while a document nobody
    // has sent is still outstanding.
    await setStatus(
      caseId,
      tenantId,
      missingInfoEmailComing ? "info_faltante" : "confirmacion_pendiente"
    );
  } else if (!isHighSeverity && !confirmationEmailDispatched) {
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
    isHighSeverity ||
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
        question: plan?.question ?? null,
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
  latestMessageText?: string
): Promise<void> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const settled = new Set(
    fields
      .filter((f) => f.confidence >= MEDIUM_CONFIDENCE_HIGH)
      .map((f) => canonicalFieldKey(f.field_key))
  );

  // "Confirmo" is an answer even though it adds no data. The email asks for
  // that exact word and nothing read it, so the claimant wrote it, extraction
  // re-ran, the inferred value came back at the same confidence it always had,
  // and the identical email went out again. Answering the way we asked left
  // them where they started.
  //
  // It closes the one field we asked about, not every pending row: we only ever
  // ask about one per email, and the same ranking that picked it picks it now.
  if (isAffirmativeReply(latestMessageText)) {
    for (const asked of await askedPendingFields(caseId, tenantId, fields)) {
      settled.add(asked);
    }
  }

  if (settled.size === 0) return;

  try {
    await enTenant(tenantCtx, (db) =>
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
    );
  } catch (err) {
    console.error("[orchestrate] Failed to resolve confirmations:", errCode(err));
  }
}

/**
 * The pending fields the last message actually put in front of them.
 *
 * "Confirmo" agrees with what was on the page, so it must not close a doubt
 * that never made the list. This used to re-derive the subset by running the
 * same ranking again — which only held while the ranking was the only thing
 * choosing. Now that the agent picks what is worth asking, the list it chose
 * is recorded, and reading it back is both simpler and actually true.
 *
 * The re-derivation stays as the fallback, for messages sent before the keys
 * were being written down.
 */
async function askedPendingFields(
  caseId: string,
  tenantId: string,
  fields: ExtractedClaim["fields"]
): Promise<string[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  const recorded = await lastAskedKeys(caseId, tenantId);
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
    console.error("[orchestrate] Failed to read pending confirmations:", errCode(err));
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

  const knownValues: Record<string, string> = {};
  for (const d of doubts) {
    if (fields.includes(d.fieldKey) && d.proposedValue) {
      knownValues[d.fieldKey] = d.proposedValue;
    }
  }

  // And anything we hold a value for, however it got onto the list.
  for (const key of fields) {
    if (knownValues[key]) continue;
    const value = opts.held?.[key] ?? opts.held?.[canonicalFieldKey(key)];
    if (value) knownValues[key] = value;
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
 * `validate` has already refused anything not backed by a tool call, so
 * nothing reaching here was invented.
 */
async function recordLookedUpFields(
  caseId: string,
  tenantId: string,
  resolved: Array<{ field: string; value: string }>
): Promise<void> {
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

    console.info(
      JSON.stringify({
        level: "info",
        service: "claimmix",
        msg: "agent.resolved_by_lookup",
        case_id: caseId,
        fields: resolved.map((r) => r.field),
      })
    );
  } catch (err) {
    // The claim survives: the field simply stays missing and gets asked for.
    console.error("[orchestrate] Failed to store looked-up fields:", errCode(err));
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
  claimTypeValue: string | null;
  summary?: string | null;
  reason: string;
}): Promise<void> {
  const { caseId, tenantId, severity } = opts;
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  // Este contexto es lo único que le dice de quién son los datos.
  const tenantCtx: TenantContext = { tenantId };

  await setStatus(caseId, tenantId, "requiere_especialista");

  await opts.messenger.send({
    caseId,
    tenantId,
    to: opts.senderEmail,
    lastMessage: opts.latestMessageText,
    template: "specialist_escalation",
    data: { caseId, severity },
    inReplyToMessageId: opts.inReplyToMessageId,
  });

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
    if (!value) continue;

    const key = canonicalFieldKey(field.field_key);
    const confidence = Number(field.confidence) || 0;
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
  extracted: ExtractedClaim["fields"]
): ConfirmableField[] {
  const byCanonical = new Map<string, ConfirmableField>();

  const confidenceOf = (key: string) =>
    extracted.find((f) => canonicalFieldKey(f.field_key) === canonicalFieldKey(key))
      ?.confidence;

  for (const rawKey of uncertainKeys) {
    if (!isWorthConfirming(rawKey)) continue;
    // Worked out from something we already read well — an analyst can correct
    // it without costing the claimant an email.
    if (isDerivable(rawKey, confidenceOf)) continue;

    const canonical = canonicalFieldKey(rawKey);

    // The value may be filed under either spelling — take the most confident.
    const candidates = extracted.filter(
      (f) => canonicalFieldKey(f.field_key) === canonical
    );
    const best = candidates.reduce<ExtractedClaim["fields"][number] | null>(
      (acc, f) => (acc === null || f.confidence > acc.confidence ? f : acc),
      null
    );

    const existing = byCanonical.get(canonical);
    const confidence = best?.confidence ?? 0;
    if (existing && existing.confidence >= confidence) continue;

    byCanonical.set(canonical, {
      fieldKey: canonical,
      proposedValue: best?.field_value ?? "",
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
    console.error("[orchestrate] Failed to update case status:", errCode(err), "case:", caseId);
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
  campos: Array<{ fieldKey: string; proposedValue: string; confidence: number }>
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
            conflict_with_value: null,
            confidence: c.confidence.toFixed(2),
            status: "pending",
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
            conflict_with_value: null,
            confidence: c.confidence.toFixed(2),
            status: "pending",
            created_at: ahora,
          })
          .where(eq(claimFieldConfirmations.id, porClave.get(c.fieldKey)!))
      );
    }
  } catch (err) {
    console.error("[orchestrate] guardarConfirmaciones:", errCode(err), "case:", caseId);
  }
}

async function upsertFieldConfirmation(
  caseId: string,
  tenantId: string,
  row: {
    field_key: string;
    proposed_value: string;
    confidence: number;
    conflict_with_value: string | null;
  }
): Promise<void> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const existing = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ id: claimFieldConfirmations.id })
          .from(claimFieldConfirmations)
          .where(
            and(
              eq(claimFieldConfirmations.case_id, caseId),
              eq(claimFieldConfirmations.field_name, row.field_key)
            )
          )
          .limit(1)
      )
    );

    const values = {
      suggested_value: row.proposed_value,
      conflict_with_value: row.conflict_with_value,
      confidence: row.confidence.toFixed(2),
      status: "pending",
      created_at: new Date().toISOString(),
    };

    if (existing) {
      await enTenant(tenantCtx, (db) =>
        db
          .update(claimFieldConfirmations)
          .set(values)
          .where(eq(claimFieldConfirmations.id, existing.id))
      );
    } else {
      await enTenant(tenantCtx, (db) =>
        db.insert(claimFieldConfirmations).values({
          case_id: caseId,
          tenant_id: tenantId,
          field_name: row.field_key,
          ...values,
        })
      );
    }
  } catch (err) {
    console.error("[orchestrate] Failed to upsert claim_field_confirmations:", errCode(err));
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
 * What the last message we actually sent asked for.
 *
 * Empty when nothing has gone out, or on any failure: the safe direction is to
 * believe we have never asked. A repeated question is a nuisance; a claim that
 * waits forever because we wrongly believed we had asked is a claim nobody is
 * working on.
 */
async function lastAskedKeys(caseId: string, tenantId: string): Promise<string[]> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const last = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ asked_keys: outboundMessages.asked_keys })
          .from(outboundMessages)
          .where(
            and(
              eq(outboundMessages.case_id, caseId),
              // A simulated message counts. It is the message that would have
              // gone out, composed by the same writer, and a rehearsal in which
              // the agent never remembers having spoken is rehearsing something
              // other than production.
              inArray(outboundMessages.status, ["sent", "skipped_simulated"]),
              isNotNull(outboundMessages.asked_keys)
            )
          )
          .orderBy(desc(outboundMessages.created_at))
          .limit(1)
      )
    );
    return last?.asked_keys ?? [];
  } catch (err) {
    console.error("[orchestrate] Failed to read the last ask:", errCode(err));
    return [];
  }
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
async function filesArrivedSinceWeLastSpoke(
  caseId: string,
  tenantId: string
): Promise<boolean> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const spoke = firstRow(
      await enTenant(tenantCtx, (db) =>
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
    if (!spoke?.created_at) return false;

    const since = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ id: claimAttachments.id })
          .from(claimAttachments)
          .where(
            and(
              eq(claimAttachments.case_id, caseId),
              gt(claimAttachments.created_at, spoke.created_at)
            )
          )
          .limit(1)
      )
    );
    return Boolean(since);
  } catch (err) {
    // Speaking is the safe direction here too.
    console.error("[orchestrate] Failed to check for new files:", errCode(err));
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
  tenantId: string
): Promise<boolean> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const spoke = firstRow(
      await enTenant(tenantCtx, (db) =>
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
    if (!spoke?.created_at) return false;

    const since = firstRow(
      await enTenant(tenantCtx, (db) =>
        db
          .select({ id: extractedFields.id })
          .from(extractedFields)
          .where(
            and(
              eq(extractedFields.case_id, caseId),
              gt(extractedFields.extracted_at, spoke.created_at)
            )
          )
          .limit(1)
      )
    );
    return Boolean(since);
  } catch (err) {
    // Callarse es la dirección insegura acá: ante la duda, contestar.
    console.error("[orchestrate] Failed to check for new facts:", errCode(err));
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
    console.error("[orchestrate] Failed to check prior outbound:", errCode(err));
    return false;
  }
}

/**
 * Check whether a confirmation_received email has already been dispatched
 * for this case. Used to enforce the AC12 "always send, but only once" rule.
 */
async function checkConfirmationAlreadySent(
  caseId: string,
  tenantId: string
): Promise<boolean> {
  // Las consultas de acá ya no llevan filtro por inquilino: lo pone la base.
  const tenantCtx: TenantContext = { tenantId };
  try {
    const data = await enTenant(tenantCtx, (db) =>
      db
        .select({ id: outboundMessages.id })
        .from(outboundMessages)
        .where(
          and(
            eq(outboundMessages.case_id, caseId),
            eq(outboundMessages.template, "confirmation_received")
          )
        )
        .limit(1)
    );

    return data.length > 0;
  } catch (err) {
    console.error("[orchestrate] Failed to check outbound_messages:", errCode(err));
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
  // The CustomerMatch interface does not directly expose the stored field values.
  // We use the customerName for full_name conflicts (the most common case).
  // For other fields, we return an empty string — the conflict is flagged but
  // the exact stored value is not available from this interface.
  if (fieldKey === "full_name") {
    return match.customerName;
  }
  // For email, dni, phone — the stored value is in the DB but not passed through
  // the match interface. For now, we flag the conflict without the stored value.
  // The analyst can see the stored value in the admin dashboard (W5/W6).
  return "";
}
