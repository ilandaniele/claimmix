/**
 * The veto over the agent's own decisions.
 *
 * Handing the model the decision is what makes this an agent rather than a
 * flowchart — it can now answer a question, or judge that a message deserves
 * no reply, without anyone having written a branch for it. What keeps that
 * safe is not the prompt. Prompts are advice. These are the rules, and a plan
 * that breaks one is thrown away whole: the deterministic tree still exists
 * and still works, so a bad decision degrades to the old behaviour rather than
 * to no behaviour.
 *
 * Each case below is a way an insurer could be embarrassed by an automated
 * message, not a way the code could crash.
 */

import { describe, it, expect } from "vitest";
import { validate, type AgentPlan, type DeliberationInput } from "@/server/ai/deliberate";

function situation(overrides: Partial<DeliberationInput> = {}): DeliberationInput {
  return {
    caseId: "11111111-1111-1111-1111-111111111111",
    tenantId: "10000000-0000-0000-0000-000000000001",
    outstanding: ["policy_number", "fotos_danos"],
    knownValues: {},
    lastAsked: [],
    latestMessage: "choqué ayer",
    claimTypeLabel: "choque de vehículo",
    isHighSeverity: false,
    isComplete: false,
    ...overrides,
  };
}

function plan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    intent: "ask",
    askFor: ["policy_number"],
    question: null,
    reasoning: "falta la póliza",
    noteForAnalyst: null,
    resolved: [],
    toolCalls: [],
    ...overrides,
  };
}

describe("validate — what the agent may not decide", () => {
  it("accepts a plan that asks for something outstanding", () => {
    expect(validate(plan(), situation())).toBeNull();
  });

  it("refuses to ask for anything we did not say was missing", () => {
    // The rule that matters most. A model free to ask for whatever it likes
    // turns a claim form into a fishing expedition — and an insurer collecting
    // a bank account number it never needed has a problem no apology fixes.
    const problem = validate(plan({ askFor: ["cbu", "policy_number"] }), situation());
    expect(problem).toBe("invented:cbu");
  });

  it("refuses to declare a claim finished while something is outstanding", () => {
    // "Ya tenemos todo lo necesario" is a status an analyst acts on. It
    // follows from the gaps being closed, not from the model feeling done.
    const problem = validate(plan({ intent: "acknowledge", askFor: [] }), situation());
    expect(problem).toBe("closed_with_gaps_open");
  });

  it("allows acknowledging once nothing is left", () => {
    expect(
      validate(
        plan({ intent: "acknowledge", askFor: [] }),
        situation({ outstanding: [], isComplete: true })
      )
    ).toBeNull();
  });

  it("refuses to go quiet before ever having asked", () => {
    // The claim would sleep forever with nobody waiting on anybody.
    const problem = validate(
      plan({ intent: "wait", askFor: [] }),
      situation({ lastAsked: [] })
    );
    expect(problem).toBe("silent_before_ever_asking");
  });

  it("allows going quiet when the same request already went out", () => {
    // Three messages in ninety seconds asking for the same document is the
    // behaviour this permits it to stop.
    expect(
      validate(
        plan({ intent: "wait", askFor: [] }),
        situation({ lastAsked: ["policy_number", "fotos_danos"] })
      )
    ).toBeNull();
  });

  it("refuses an ask with nothing in it", () => {
    expect(validate(plan({ intent: "ask", askFor: [] }), situation())).toBe(
      "ask_without_items"
    );
  });

  it("refuses items smuggled into an intent that does not ask", () => {
    const problem = validate(
      plan({ intent: "wait", askFor: ["policy_number"] }),
      situation({ lastAsked: ["policy_number"] })
    );
    expect(problem).toBe("items_without_ask");
  });

  it("refuses to answer a question nobody asked", () => {
    const problem = validate(
      plan({ intent: "answer", askFor: [], question: null }),
      situation({ outstanding: [] })
    );
    expect(problem).toBe("answer_without_question");
  });

  it("accepts answering and asking in the same breath", () => {
    // The realistic shape: "¿cuánto tarda?" while two documents are still
    // missing. Answer them, and say what is still needed.
    expect(
      validate(
        plan({
          intent: "answer_and_ask",
          askFor: ["policy_number"],
          question: "¿cuánto tarda esto?",
        }),
        situation()
      )
    ).toBeNull();
  });

  it("refuses a bare answer while the claim still has gaps", () => {
    // A plain answer rides on the closing message, which says we have
    // everything — false while anything is outstanding. The right shape there
    // is answer_and_ask.
    const problem = validate(
      plan({ intent: "answer", askFor: [], question: "¿cuánto tarda?" }),
      situation()
    );
    expect(problem).toBe("answer_alone_with_gaps_open");
  });

  it("accepts a bare answer once there is nothing left to ask", () => {
    expect(
      validate(
        plan({ intent: "answer", askFor: [], question: "¿cuándo me llaman?" }),
        situation({ outstanding: [], isComplete: true })
      )
    ).toBeNull();
  });
});

describe("validate — escalating", () => {
  /**
   * Severity classification catches the physical emergencies: fire, injuries.
   * It misses everything else that needs a person — a policy that lapsed last
   * year, a DNI that is not the holder's, someone mentioning a lawyer, someone
   * too distressed to answer questions. Those are judgement, which is the
   * thing that was missing.
   *
   * Nothing here makes escalating harder than carrying on, and that is
   * deliberate. The cost of a wrong escalation is a person reading a case they
   * did not need to; the cost of not escalating is a chatbot asking for
   * photographs of a car whose cover expired in 2020.
   */
  it("lets the agent hand a case to a person", () => {
    expect(
      validate(
        plan({ intent: "escalate", askFor: [], reasoning: "la póliza venció en 2020" }),
        situation()
      )
    ).toBeNull();
  });

  it("allows it even with gaps wide open", () => {
    // The gaps are exactly why it is escalating.
    expect(
      validate(
        plan({ intent: "escalate", askFor: [] }),
        situation({ outstanding: ["policy_number", "dni", "fotos_danos"] })
      )
    ).toBeNull();
  });

  it("allows it before anything has been asked", () => {
    expect(
      validate(plan({ intent: "escalate", askFor: [] }), situation({ lastAsked: [] }))
    ).toBeNull();
  });

  it("refuses to ask for documents in the same breath", () => {
    // Someone told "la derivamos a un especialista, no hace falta que hagas
    // nada" and then asked for their DNI got two contradictory bubbles.
    expect(
      validate(plan({ intent: "escalate", askFor: ["policy_number"] }), situation())
    ).toBe("escalation_asks_for_data");
  });
});

describe("validate — filling a field in from a lookup", () => {
  /**
   * The tools were half a feature without this. The agent would search by DNI,
   * find the policy number sitting in our own database, and then ask the
   * claimant for it anyway — asking was the only way it had to move a field
   * from missing to known.
   *
   * The danger is the same mechanism used from memory. A value written here
   * lands on the claim at high confidence, so a model that can fill fields in
   * unprompted is a model that can invent a policy number and have it believed.
   */
  const LOOKED_UP = [{ tool: "polizas_por_dni", args: { dni: "27654321" } }];

  it("accepts a value that a lookup produced", () => {
    expect(
      validate(
        plan({
          intent: "ask",
          askFor: ["fotos_danos"],
          resolved: [{ field: "policy_number", value: "POL-8812-R" }],
          toolCalls: LOOKED_UP,
        }),
        situation()
      )
    ).toBeNull();
  });

  it("refuses a value with no lookup behind it", () => {
    // Otherwise the model is writing a policy number from imagination, at 0.95
    // confidence, which is the worst possible way to be wrong.
    expect(
      validate(
        plan({
          askFor: ["fotos_danos"],
          resolved: [{ field: "policy_number", value: "POL-INVENTADA" }],
          toolCalls: [],
        }),
        situation()
      )
    ).toBe("resolved_without_looking_anything_up");
  });

  it("refuses to fill in a field nobody said was missing", () => {
    expect(
      validate(
        plan({
          askFor: ["policy_number"],
          resolved: [{ field: "cbu", value: "0000003100010000000001" }],
          toolCalls: LOOKED_UP,
        }),
        situation()
      )
    ).toBe("resolved_something_not_missing:cbu");
  });

  it("refuses to fill a field in and ask for it in the same breath", () => {
    // The claimant would be asked to supply what the message already contains.
    expect(
      validate(
        plan({
          askFor: ["policy_number"],
          resolved: [{ field: "policy_number", value: "POL-8812-R" }],
          toolCalls: LOOKED_UP,
        }),
        situation()
      )
    ).toBe("asked_and_resolved:policy_number");
  });
});
