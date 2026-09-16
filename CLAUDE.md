@AGENTS.md
@C:/Users/Ilan/Desktop/Desarrollo/Development/BASE_CLAUDE.md

# How to work in this repo

- **Caveman, always.** Turn on `/caveman` (full) at the start of every session and keep it on to save tokens: terse chat, normal prose in code, comments, commits, PRs and docs.
- **Split before you start.** Break a large task into small, verifiable tasks and run them one at a time; report each one as it lands.
- **Delegate through `/orchestrator`.** Use subagents (whichever fit) for anything beyond a few tool calls, routed by the orchestrator's table so each step runs on the model its task needs: `orch-mapper` (Fable) to map, `orch-architect` (Opus) to plan, `orch-builder` (Sonnet) to edit, `orch-verifier` (Haiku) to run lint and tests until green. Send independent agents in one message so they run in parallel.
- **Fable out of quota → Opus.** If Fable hits its usage limit, continue on Opus: spawn agents with Opus and ask the user to switch the main session with `/model claude-opus-5`.
- **Hand off in writing.** When a task is left mid-way or passed to another agent, write `.claude/handoff/<task>.md` (gitignored): goal, what is done, what is next, exact paths and commands. Read it first when resuming.
- **Read only for the task at hand.** Do not read files, logs or docs that the current task does not need.
- **`BASE_CLAUDE.md` applies** (imported above): DRY, KISS, surgical changes, minimal comments.
