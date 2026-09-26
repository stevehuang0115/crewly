# Startup briefing under modular prompts (#816, part A)

Status: implemented (PR-A of #816). Part B, standing-answer pages, is a separate spec.

## Problem

Issue #395 gave every agent two boot-time blocks in its registration prompt:

- `## Your Active Work`: open Requests, active WorkItems, pending reviews and outbound
  delegations, from `ActiveWorkBriefingService`. This is the authoritative state.
- `## Your Previous Knowledge`: the session-memory startup briefing from
  `SessionMemoryService` (last session summary, agent and project memory, today's log,
  goals, recent learnings).

`AgentRegistrationService.loadRegistrationPrompt` appended both to the legacy `prompt`
string. On the default path (`CREWLY_USE_MODULAR_PROMPTS` unset), however, the method
assembled a separate `modularPrompt` from the prompt modules and returned that. Both
blocks were thrown away. The recovery module still told the agent the state "has already
been injected above", so the agent trusted a section that was not there. This was seen live
on 2026-09-26.

The #395 integration test re-implemented the injection code instead of calling
registration, so it stayed green through the regression.

## Design

The briefings travel through `ModuleConfig`, and two prompt modules render them.

| Module | Priority | Compactable | Renders |
|---|---|---|---|
| `active-work` (`ActiveWorkModule`) | 1.5 | no | `config.activeWorkBriefing`, or a **"not injected"** notice that includes the `get-my-active-work` command |
| `session-briefing` (`SessionBriefingModule`) | 1.6 | yes | `config.sessionBriefing`; skipped when empty |
| `recovery` (existing) | 2 | no | refers to "the `## Your Active Work` section above" |

- **Generation stays in registration.** Registration already builds both briefings. It
  now keeps them in locals and sets `moduleConfig.activeWorkBriefing` and
  `moduleConfig.sessionBriefing` before assembling. Each is generated once and reused by
  the orchestrator's profile-comparison assembly. The modules do no TaskPool, Request or
  memory I/O, so the other `PromptAssemblyService` callers (the prompt-builder paths and
  tests) are not affected.
- **An absent briefing never reads as "no work".** A briefing can be missing because
  generation failed, or because the caller does not compute one. In that case
  `active-work` still prints its heading, followed by an explicit "Not injected into this
  prompt… This does NOT mean you have no work" and the command that fetches the briefing.
  A briefing that was generated but is empty keeps the service's own
  `(No active work — fresh start)` text, which is a true answer.
- **Order.** State comes first, then memory, then the protocol that refers to both.
  Priorities below the recovery module's 2 make "above" literally true.
- **Budget.** `active-work` is non-compactable because it is state: trimming it could
  drop the WorkItem the agent was restarted to finish. Its size is already capped by
  `ActiveWorkBriefingService`, which applies per-section caps and a compact re-render
  above 25,000 chars. `session-briefing` is reference material, so it can be trimmed or
  removed when over budget.
- **Legacy path.** It uses the same `renderActiveWorkSection()` helper, so both paths
  print the same notice.
- **Profiles.** `active-work` is added to `PROFILE_REQUIRED_MODULES`, so the `lite` tier
  keeps it. Eval mode skips both modules (they are not core).

The recovery wording, in both `recovery.module.ts` and the legacy
`PromptBuilderService.buildSessionRecoverySection`, now reads: the state *is* in the
section above, and if that section says **not injected**, run `get-my-active-work` now.

## Two related skill fixes

- **`report-status` learning call.** It used to post `{agentId, content, type}` to
  `/memory/record-learning`. The controller requires `agentId, agentRole, projectPath,
  learning`, so every call returned 400, and `2>/dev/null || true` hid it. It now posts
  the following:
  - `agentRole`: from `--role`, then JSON `role`/`agentRole`, then `$CREWLY_ROLE`, else
    `agent`.
  - `learning`: `"Task completed: …"` or `"Task failed: …"` / `"Task blocked: …"`.
  - `relatedTask`: the WorkItem id or task id, when one is given.

  A failed call is still non-fatal, but it now prints a warning on stderr.
- **`recall`** defaults `projectPath` from `$CREWLY_PROJECT_PATH`, the same way
  `remember` does (#187).

## Tests

- `agent-registration.service.test.ts`, `startup briefings under the modular prompt`:
  the real `loadRegistrationPrompt` on the default path contains both briefings, with
  Active Work before recovery. When generation fails, the prompt carries the notice
  rather than "fresh start". The legacy path is covered too.
- `active-work.module.test.ts`, `session-briefing.module.test.ts`: rendering, the notice,
  and inclusion rules.
- `prompt-assembly.service.test.ts`: order relative to recovery; under budget pressure
  the session briefing is cut and Active Work never is.
- `recovery.module.test.ts`: the wording matches the heading `ActiveWorkModule` emits.
- `config/skills/agent/core/report-status/tests`: the real `recordLearning` controller
  accepts what the script sends (HTTP 200).
- `config/skills/agent/core/recall/tests`: the env default applies, and an explicit path
  wins.
