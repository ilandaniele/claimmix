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
import { describeTools, runTool, type ToolContext } from "@/server/ai/agent-tools";

export type AgentIntent =
  | "ask"
  | "answer_and_ask"
  | "answer"
  | "acknowledge"
  | "escalate"
  | "wait";

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
  /**
   * Something an analyst should know that no field captures.
   *
   * "El otro conductor se dio a la fuga", "dice que ya reclamó por esto en
   * marzo", "menciona un abogado". Facts a person handling the file would
   * write down and a schema was never going to have a column for.
   */
  noteForAnalyst: string | null;
  /**
   * Values a lookup turned up, to be recorded instead of asked for.
   *
   * Without this the tools were half a feature. The agent would search by DNI,
   * find the policy number sitting in our own database, and then ask the
   * claimant for it anyway — because asking was the only way it had to move a
   * field from missing to known.
   *
   * Only ever from a lookup. `validate` refuses these outright when no tool
   * was called, because a model that can write values into a claim from
   * memory is a model that can invent a policy number.
   */
  resolved: Array<{ field: string; value: string }>;
  /** The lookups it made, in order, for the audit trail. */
  toolCalls: Array<{ tool: string; args: Record<string, unknown> }>;
  /**
   * Lo que DEVOLVIERON esas consultas, en crudo.
   *
   * Estaba sólo adentro de `think`, en el transcripto que se le muestra al
   * modelo, y no salía de ahí. Sin esto, nadie río abajo puede comprobar que un
   * valor de `resolved` haya salido de una búsqueda: `validate` sólo podía
   * contar CUÁNTAS consultas se hicieron, que es una pregunta distinta.
   *
   * Con `polizas_por_dni → { encontradas: 0 }` en el plan, un
   * `resolved: policy_number = "POL-INVENTADA"` pasaba y se guardaba con
   * confianza 0.95.
   */
  lookupResults: string[];
}

export interface DeliberationInput {
  /** Which case and tenant the lookups run against. */
  caseId: string;
  tenantId: string;
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
    const { plan, toolCalls, lookupResults } = await think(input);
    if (!plan) return null;
    plan.toolCalls = toolCalls;
    plan.lookupResults = lookupResults;

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

/**
 * How many lookups one decision may make.
 *
 * Each is a database query and a round trip to the model, so the ceiling is
 * about cost and latency rather than safety — the tools are read-only, and a
 * loop that ran forever would only be expensive. Three is enough for the real
 * chains: check the DNI, find their policies, confirm one is in force.
 */
const MAX_TOOL_CALLS = 3;

/**
 * Let the agent look things up until it knows enough to decide.
 *
 * The model answers with either a tool call or a plan. A tool call is run, its
 * result appended to the conversation, and the model asked again. This is a
 * JSON protocol rather than Gemini's native function calling because the
 * shared `callGemini` pins responseMimeType to JSON for every caller in the
 * codebase, and the two cannot both be on. What makes it an agent is that the
 * model chooses the actions and sees their results, not which wire format
 * carries them.
 */
async function think(
  input: DeliberationInput
): Promise<{
  plan: AgentPlan | null;
  toolCalls: AgentPlan["toolCalls"];
  lookupResults: string[];
}> {
  const ctx: ToolContext = { caseId: input.caseId, tenantId: input.tenantId };
  const toolCalls: AgentPlan["toolCalls"] = [];
  const transcript: string[] = [];

  for (let step = 0; step <= MAX_TOOL_CALLS; step++) {
    // On the last pass the tool menu is withdrawn, so the model has to decide
    // with what it has rather than asking for one more lookup forever.
    const lastChance = step === MAX_TOOL_CALLS;
    const prompt =
      buildPrompt(input, lastChance) +
      (transcript.length > 0
        ? `\n\nLO QUE AVERIGUASTE:\n${transcript.join("\n")}`
        : "");

    const { text } = await callGemini(
      prompt,
      "Decidí qué corresponde hacer con este mensaje y devolvé el JSON pedido."
    );
    if (!text) return { plan: null, toolCalls, lookupResults: transcript };

    const parsed = JSON.parse(text) as Record<string, unknown>;

    const call = toolCallIn(parsed);
    if (call && !lastChance) {
      toolCalls.push(call);
      const result = await runTool(call.tool, call.args, ctx);

      // Logged because a lookup that quietly returns nothing looks exactly
      // like a lookup nobody made, and the two need different fixes.
      console.info(
        JSON.stringify({
          level: "info",
          service: "claimmix",
          msg: "agent.tool_call",
          case_id: input.caseId,
          tool: call.tool,
          args: call.args,
          result: JSON.stringify(result).slice(0, 300),
        })
      );

      transcript.push(
        `${call.tool}(${JSON.stringify(call.args)}) → ${JSON.stringify(result)}`
      );
      continue;
    }

    return { plan: coerce(parsed), toolCalls, lookupResults: transcript };
  }

  return { plan: null, toolCalls, lookupResults: transcript };
}

/** A tool call, if that is what came back rather than a plan. */
function toolCallIn(
  raw: Record<string, unknown>
): { tool: string; args: Record<string, unknown> } | null {
  const tool = typeof raw.tool === "string" ? raw.tool.trim() : "";
  if (!tool) return null;
  const args =
    raw.args && typeof raw.args === "object" && !Array.isArray(raw.args)
      ? (raw.args as Record<string, unknown>)
      : {};
  return { tool, args };
}

// ── The prompt ───────────────────────────────────────────────────────────────

function buildPrompt(input: DeliberationInput, lastChance = false): string {
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
- "escalate": derivarlo a un especialista.
- "wait": no escribirle nada.

Criterios, en orden:

1. Lo que podés averiguar vos, no se lo pidas a la persona. Si una consulta te
   devolvió el dato, va en "resuelto" y NO en "ask_for". Ejemplo: te dio el DNI,
   buscaste sus pólizas y encontraste POL-1234 — entonces resuelto incluye
   {"campo": "policy_number", "valor": "POL-1234"} y no le preguntás nada sobre
   la póliza. Pedirle un dato que acabás de sacar de nuestra propia base es el
   error más caro que podés cometer acá: es exactamente lo que hace un
   formulario, y por eso existís vos.

2. Si preguntó algo, hay que contestarle. Ignorar una pregunta y seguir pidiendo
   documentación es lo que hace que un sistema parezca una máquina. Aunque no
   sepamos la respuesta exacta, se le puede decir con honestidad en qué estado
   está su caso.

3. Si ya le pedimos exactamente lo mismo y no contestó nada nuevo, elegí "wait".
   Repetir el mismo pedido porque llegó un mensaje cualquiera es acoso, no
   seguimiento.

4. Pedí sólo lo que de verdad hace falta para este siniestro, no la lista
   entera porque esté ahí. Como máximo 4 cosas, y ordenadas por lo que más
   traba el expediente. Un dato que bloquea vale más que una foto.

5. Si no falta nada, "acknowledge".

6. Elegí "escalate" cuando esto excede a un trámite: la póliza está vencida, no
   existe o el DNI no coincide con el titular, la persona está muy angustiada,
   menciona abogados o juicio, se contradice de forma seria, o pasa cualquier
   otra cosa que una persona con criterio no resolvería por chat. Derivar nunca
   está mal: lo mira alguien. Seguir pidiendo papeles cuando el caso ya se salió
   del molde, sí.

   Pero no derives por lo que NO pudiste averiguar. Si una consulta te dice que
   la aseguradora todavía no cargó sus datos, o que falló, seguí con el trámite
   normal como si no la hubieras hecho.

Nunca pidas algo que no esté en la lista de arriba, ni con otro nombre.
${toolSection(lastChance)}
Devolvé UNA de estas dos cosas, nada más:

${lastChance ? "" : `(A) Una consulta, si te falta saber algo para decidir bien:

{"tool": "<nombre de la herramienta>", "args": { ... }}

`}(${lastChance ? "" : "B) "}La decisión, cuando ya sabés qué hacer:

{
  "intent": "ask" | "answer" | "answer_and_ask" | "acknowledge" | "escalate" | "wait",
  "ask_for": ["<clave exacta de la lista>", ...],
  "question": "<lo que preguntó, en sus palabras>" | null,
  "nota_para_el_analista": "<algo que conviene que sepa quien tome el caso>" | null,
  "resuelto": [{"campo": "<clave de la lista>", "valor": "<lo que averiguaste>"}],
  "reasoning": "<por qué, en una o dos oraciones>"
}

En "resuelto" va lo que averiguaste con una consulta y por lo tanto YA NO hace
falta pedirle a la persona. Si buscaste su póliza por DNI y la encontraste, el
número va acá y NO en "ask_for": pedirle un dato que acabás de sacar de nuestra
propia base es exactamente lo que hace un formulario. Nunca pongas en "resuelto"
algo que no te haya devuelto una consulta.`;
}

/**
 * The tool menu, and how to call one.
 *
 * Withdrawn on the last pass. Left available, a model that keeps asking for
 * one more lookup never gets round to deciding — and the person is waiting for
 * a reply, not for thoroughness.
 */
function toolSection(lastChance: boolean): string {
  if (lastChance) {
    return "\nYa no podés consultar nada más. Decidí con lo que tenés.\n";
  }

  return `
ANTES DE DECIDIR PODÉS AVERIGUAR ESTO:

${describeTools()}

Consultá cuando la respuesta cambie lo que vas a hacer. Sobre todo: nunca le
pidas a la persona un dato que podés buscar vos, y nunca sigas un trámite sobre
una póliza sin haber mirado si existe y está vigente.
`;
}

// ── Reading the answer ───────────────────────────────────────────────────────

const INTENTS: AgentIntent[] = [
  "ask",
  "answer_and_ask",
  "answer",
  "acknowledge",
  "escalate",
  "wait",
];

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

  const note =
    typeof raw.nota_para_el_analista === "string" &&
    raw.nota_para_el_analista.trim().length > 0
      ? raw.nota_para_el_analista.trim().slice(0, 500)
      : null;

  const resolved = Array.isArray(raw.resuelto)
    ? raw.resuelto
        .filter(
          (r): r is { campo: string; valor: string } =>
            typeof r === "object" &&
            r !== null &&
            typeof (r as { campo?: unknown }).campo === "string" &&
            typeof (r as { valor?: unknown }).valor === "string"
        )
        .map((r) => ({ field: r.campo.trim(), value: r.valor.trim().slice(0, 200) }))
        .filter((r) => r.field.length > 0 && r.value.length > 0)
    : [];

  return {
    intent: intent as AgentIntent,
    askFor,
    question,
    reasoning,
    noteForAnalyst: note,
    resolved,
    toolCalls: [],
    // Los pega `deliberate`, que es quien los tiene.
    lookupResults: [],
  };
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

  // A value written into the claim has to have come from somewhere. Without a
  // lookup behind it, "resolved" is the model filling in a policy number from
  // imagination — and it would be stored at full confidence, which is the
  // worst possible way to be wrong.
  if (plan.resolved.length > 0 && plan.toolCalls.length === 0) {
    return "resolved_without_looking_anything_up";
  }

  // Deliberately NOT "the field must be one we said was missing". That rule
  // looked right and threw away a correct decision: shown an expired policy,
  // the agent chose to escalate and recorded the policy number and DNI it had
  // just verified — neither of which was missing, because the claimant had
  // supplied both. The whole plan was rejected and the fallback tree asked the
  // man for photographs of a car whose cover lapsed in 2020.
  //
  // Recording a value we confirmed against our own records is an improvement
  // on one a person typed from memory, whether or not we were missing it. The
  // risk this section exists for — values conjured out of nothing — is already
  // covered above.

  // It cannot both fill a field in and ask for it.
  const both = plan.askFor.filter((k) => plan.resolved.some((r) => r.field === k));
  if (both.length > 0) return `asked_and_resolved:${both.join(",")}`;

  // Escalating is the one intent with no other requirements. It is the
  // conservative move — a person looks at the case — so nothing here should
  // make it harder to choose than carrying on.
  if (plan.intent === "escalate") {
    return plan.askFor.length > 0 ? "escalation_asks_for_data" : null;
  }

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
