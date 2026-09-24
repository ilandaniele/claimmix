@AGENTS.md
@C:/Users/Ilan/Desktop/Desarrollo/Development/BASE_CLAUDE.md

# How to work in this repo

- **Caveman, always.** Turn on `/caveman` (full) at the start of every session and keep it on to save tokens: terse chat, normal prose in code, comments, commits, PRs and docs.
- **Split before you start.** Break a large task into small, verifiable tasks and run them one at a time; report each one as it lands.
- **Delegate through `/orchestrator`.** Use subagents (whichever fit) for anything beyond a few tool calls, routed by the orchestrator's table so each step runs on the model its task needs: `orch-mapper` (Opus 5.5) to map, `orch-architect` (Opus 5.5) to plan, `orch-builder` (Sonnet) to edit, `orch-verifier` (Haiku) to run lint and tests until green. Send independent agents in one message so they run in parallel.
- **Workflows follow the same table.** An `agent()` without `model` runs on the session model. Refuters, test runs and the PR step go to Sonnet, and only a security or high-severity finding gets three refuters — see "Inside Workflow scripts" in the orchestrator skill.
- **Security work runs on Fable.** Scans, audits, pen tests, threat modelling and any review of an authorization or secrets path go to Fable agents, whatever the orchestrator's table would pick for that step — a miss there costs more than the tokens saved.
- **Fable out of quota → Opus 5.5.** If Fable hits its usage limit, relaunch the same agent with `model: "opus"` (Opus 5.5) — the `desarrollo` workflow does this on its own for its security reviewers — and ask the user to switch the main session with `/model claude-opus-5-5`.
- **Compaction happens at 200k, on its own.** `.claude/settings.json` sets `autoCompactWindow` to 200000, so the client compacts when the context reaches that size — a rule written only here could not do it, because a session cannot see its own token count. What is on you is the timing around it: land or hand off whatever is in flight rather than letting a compaction land mid-edit, since it takes with it the detail the edit depended on. Write the handoff file below when the task will outlive the compaction. `/compact` by hand still works for compacting earlier, on purpose.
- **Hand off in writing.** When a task is left mid-way or passed to another agent, write `.claude/handoff/<task>.md` (gitignored): goal, what is done, what is next, exact paths and commands. Read it first when resuming.
- **Read only for the task at hand.** Do not read files, logs or docs that the current task does not need.
- **`BASE_CLAUDE.md` applies** (imported above): DRY, KISS, surgical changes, minimal comments.
