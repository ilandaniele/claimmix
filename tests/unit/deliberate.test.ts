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
