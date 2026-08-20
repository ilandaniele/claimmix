/**
 * Letting the agent decide what to do, and checking the decision.
 *
 * Until now every choice was a branch. The model extracted fields, and code
 * decided from a table whether to reply, what to ask for, in what order, and
 * when to stop. That works, and it is why this thing is predictable — but it
 * only ever does what someone thought of in advance. A claimant who asks
 * "¿cuánto tarda?" gets no answer, because there is no branch for a question;
 * a claimant who writes "ya te mandé eso" gets asked again, because there is
 * no branch for being contradicted. Every gap is a new branch, forever.
 *
 * So the model gets the decision, and the code gets a veto.
 *
 * It is shown what we know, what is outstanding, what we already asked for and
 * what the person just said, and it returns a plan: whether to write at all,
 * which of the outstanding items are worth asking for now, whether a question
 * was asked and what can honestly be said about it, and why. The reasoning is
 * kept — a claims operation has to be able to answer "why did it say that",
 * and until now the only answer was "read orchestrate.ts".
 *
 * What the model cannot do is the point. It cannot invent something to ask
 * for, cannot skip an escalation, cannot promise anything, and cannot decide a
 * claim is finished. Those are `validate` below, and a plan that breaks one is
 * discarded whole — the caller falls back to the deterministic tree, which
 * still exists and still works. A wrong decision must degrade to the old
 * behaviour, never to no behaviour.
 */

import "server-only";

import { callGemini } from "@/server/ai/gemini-extractor";
import { labelForField } from "@/lib/labels/claim-fields";

export type AgentIntent = "ask" | "answer_and_ask" | "answer" | "acknowledge" | "wait";

export interface AgentPlan {
  intent: AgentIntent;
  /** Outstanding keys to ask for now, best first. Never anything else. */
  askFor: string[];
  /**
   * What the claimant asked, in their words, when they asked something.
   *
   * Not the answer: the writer produces that, under the same guardrails as
   * every other message. This is only what the question was.
   */
  question: string | null;
  /** Why, in one or two sentences. Written to the audit log. */
  reasoning: string;
}

export interface DeliberationInput {
  /** Everything still outstanding, as canonical keys. The only askable set. */
  outstanding: string[];
  /** Values we already hold for some of those, to be confirmed rather than asked. */
  knownValues: Record<string, string>;
  /** Keys the last sent message asked for. */
  lastAsked: string[];
  /** What the claimant just said. */
  latestMessage: string;
  /** Spanish name of the claim type, when known. */
  claimTypeLabel: string | null;
  /** True when the case has escalated — the plan is not consulted at all. */
  isHighSeverity: boolean;
  /** True when nothing is outstanding and the claim is ready. */
  isComplete: boolean;
}

/** The deterministic tree remains the fallback, and the switch to reach it. */
function deliberationEnabled(): boolean {
  return process.env.AGENT_DELIBERATION !== "off";
}

/**
 * Decide what to do about this message.
 *
 * Returns null when the plan is unusable — disabled, unparseable, or rejected
 * by `validate` — and the caller keeps the behaviour it has always had.
 */
export async function deliberate(
  input: DeliberationInput
): Promise<AgentPlan | null> {
  if (!deliberationEnabled()) return null;

  // Escalation is not a judgement call. Someone reporting a fire with injuries
  // gets a specialist, whatever a model thinks about it, so there is nothing
  // here to deliberate and no reason to spend a call.
  if (input.isHighSeverity) return null;

  try {
    const { text } = await callGemini(
      buildPrompt(input),
      "Decidí qué corresponde hacer con este mensaje y devolvé el JSON pedido."
    );
    if (!text) return null;

    const parsed = JSON.parse(text) as Record<string, unknown>;
    const plan = coerce(parsed);
    if (!plan) return null;

    const problem = validate(plan, input);
    if (problem) {
      console.warn(
        JSON.stringify({
          level: "warn",
          service: "claimmix",
          msg: "agent.deliberation_rejected",
          reason: problem,
          intent: plan.intent,
        })
      );
      return null;
    }

    return plan;
  } catch (err) {
    console.error(
      "[deliberate] failed:",
      err instanceof Error ? err.name : "UnknownError"
    );
    return null;
  }
}

// ── The prompt ───────────────────────────────────────────────────────────────

function buildPrompt(input: DeliberationInput): string {
  const items = input.outstanding.map((key) => {
    const { label, kind } = labelForField(key);
    const known = input.knownValues[key];
    return known
      ? `- ${key} — ${label}. Ya entendimos "${known}", sólo habría que confirmarlo.`
      : `- ${key} — ${label} (${kind === "documento" ? "archivo o foto" : "dato"})`;
  });

  const alreadyAsked =
    input.lastAsked.length > 0
      ? input.lastAsked.map((k) => `- ${k}`).join("\n")
      : "- (todavía no le pedimos nada)";

  return `Sos el agente que atiende las denuncias de siniestro de una aseguradora
argentina por WhatsApp y mail. Acaba de llegar un mensaje y tenés que decidir
qué corresponde hacer.

SINIESTRO: ${input.claimTypeLabel ?? "todavía no sabemos de qué tipo"}
¿Tenemos todo lo necesario?: ${input.isComplete ? "sí" : "no"}

NOS FALTA (esta es la única lista de la que podés pedir cosas):
${items.length > 0 ? items.join("\n") : "- (nada)"}

LO ÚLTIMO QUE YA LE PEDIMOS EN UN MENSAJE:
${alreadyAsked}

LO QUE ACABA DE ESCRIBIR:
"""${input.latestMessage.slice(0, 2000)}"""

Decidí una de estas acciones:

- "ask": pedirle lo que falta.
- "answer": contestar algo que preguntó, sin pedirle nada más ahora.
- "answer_and_ask": contestar lo que preguntó y aprovechar a pedirle lo que falta.
- "acknowledge": avisarle que ya tenemos todo y que la denuncia pasa a análisis.
- "wait": no escribirle nada.

Criterios, en orden:

1. Si preguntó algo, hay que contestarle. Ignorar una pregunta y seguir pidiendo
   documentación es lo que hace que un sistema parezca una máquina. Aunque no
   sepamos la respuesta exacta, se le puede decir con honestidad en qué estado
   está su caso.

2. Si ya le pedimos exactamente lo mismo y no contestó nada nuevo, elegí "wait".
   Repetir el mismo pedido porque llegó un mensaje cualquiera es acoso, no
   seguimiento.

3. Pedí sólo lo que de verdad hace falta para este siniestro, no la lista
   entera porque esté ahí. Como máximo 4 cosas, y ordenadas por lo que más
   traba el expediente. Un dato que bloquea vale más que una foto.

4. Si no falta nada, "acknowledge".

Nunca pidas algo que no esté en la lista de arriba, ni con otro nombre.

Devolvé JSON:
{
  "intent": "ask" | "answer" | "answer_and_ask" | "acknowledge" | "wait",
  "ask_for": ["<clave exacta de la lista>", ...],
  "question": "<lo que preguntó, en sus palabras>" | null,
  "reasoning": "<por qué, en una o dos oraciones>"
}`;
}

// ── Reading the answer ───────────────────────────────────────────────────────

const INTENTS: AgentIntent[] = ["ask", "answer_and_ask", "answer", "acknowledge", "wait"];

function coerce(raw: Record<string, unknown>): AgentPlan | null {
  const intent = typeof raw.intent === "string" ? raw.intent.trim() : "";
  if (!INTENTS.includes(intent as AgentIntent)) return null;

  const askFor = Array.isArray(raw.ask_for)
    ? raw.ask_for.filter((k): k is string => typeof k === "string").map((k) => k.trim())
    : [];

  const question =
    typeof raw.question === "string" && raw.question.trim().length > 0
      ? raw.question.trim().slice(0, 400)
      : null;

  const reasoning =
    typeof raw.reasoning === "string" ? raw.reasoning.trim().slice(0, 500) : "";

  return { intent: intent as AgentIntent, askFor, question, reasoning };
}

/**
 * The things a plan is not allowed to do.
 *
 * Returns a reason to reject, or null to accept. Each of these is a promise
 * the product makes that no amount of good judgement is allowed to break —
 * and one of them, `invented`, is the one that matters most: a model that can
 * ask for anything it likes turns a claim form into a fishing expedition.
 */
export function validate(plan: AgentPlan, input: DeliberationInput): string | null {
  const outstanding = new Set(input.outstanding);

  const invented = plan.askFor.filter((k) => !outstanding.has(k));
  if (invented.length > 0) return `invented:${invented.join(",")}`;

  const wantsToAsk = plan.intent === "ask" || plan.intent === "answer_and_ask";

  if (wantsToAsk && plan.askFor.length === 0) return "ask_without_items";
  if (!wantsToAsk && plan.askFor.length > 0) return "items_without_ask";

  // Closing a claim is a status change an analyst acts on. It follows from
  // there being nothing left, not from the model feeling finished.
  if (plan.intent === "acknowledge" && input.outstanding.length > 0) {
    return "closed_with_gaps_open";
  }

  // The mirror image: something is outstanding, they said nothing new about
  // it, and we have never asked. Staying quiet there is how a claim goes to
  // sleep with nobody waiting on anybody.
  if (
    plan.intent === "wait" &&
    input.outstanding.length > 0 &&
    input.lastAsked.length === 0
  ) {
    return "silent_before_ever_asking";
  }

  const answering = plan.intent === "answer" || plan.intent === "answer_and_ask";
  if (answering && !plan.question) return "answer_without_question";

  // A bare "answer" rides on the closing message, which is only honest once
  // there is nothing left to ask. With gaps still open the right shape is
  // answer_and_ask — reply to them AND say what is still needed — so a plan
  // that answers into an open claim without asking anything is refused and
  // the deterministic tree takes over.
  if (plan.intent === "answer" && input.outstanding.length > 0) {
    return "answer_alone_with_gaps_open";
  }

  return null;
}
