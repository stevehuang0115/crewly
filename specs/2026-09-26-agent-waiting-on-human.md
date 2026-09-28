# Agent `waiting_on_human`: detect agents blocked on a prompt (#815)

Status: PR 1 (screen + title detection, owner routing, reconciler). PR 2 (Claude Code hook ingestion) is stacked on #798.

## Problem

An agent stuck on an interactive prompt looked like any other agent. The prompt could be a command approval, a folder-trust dialog, the plan-approval menu, or an onboarding menu. The agent can do nothing until a human answers, and nobody was told.

- **The activity monitor** diffs the last 5 screen lines every 30 s. A static prompt therefore reads as `idle`, not as blocked.
- **The reconciler** kept the agent's WorkItem `running` for up to 4 h. Its "back online" and "redeliver" rules could type a brief *into* the dialog, which could answer it. Eviction treated the agent as spare capacity.
- **The waiting regexes** in `continuation/patterns/waiting-patterns.ts` and `output-analyzer.service.ts` reached nothing. `ContinuationService.start()` has no caller, so the `OutputAnalyzer` is dead code. This PR does not revive it.

## Verdict

`backend/src/services/monitoring/agent-attention.ts` holds pure functions.

`computeAgentAttention({ screen, title })` returns `{ verdict, kind?, evidence[], linesExamined, titleLabel? }`. `verdict` is one of `waiting_on_human | busy | idle`. `kind` is one of `permission | trust | plan | menu | unspecified`.

### Signals, verified on 2026-09-26 (Claude Code 2.1.283, Codex 0.157.1)

| Signal | Claude Code | Codex | Weight |
|---|---|---|---|
| Screen: dialog at the bottom | yes | yes | primary |
| OSC title | `✳ <task>` in every state, including while blocked | `[ ! ] Action Required \| …` while blocked; braille spinner while working | Codex: votes. Claude: label only |
| BEL / OSC 9 notification | none emitted (raw PTY bytes logged) | — | not used |
| Hook events (Notification / PermissionRequest / Stop) | available | `notify` (turn complete) only | PR 2 |

### Screen rules

The rules examine only the **bottom 20 non-empty lines** after stripping ANSI. That keeps a dialog answered earlier (still in scrollback) from counting.

A menu is a numbered selector line (`❯ 1. Yes`, `› 1. …`) **or** a selector plus a confirm footer:
- `Esc to cancel`
- `Enter to confirm`
- `Press enter to confirm`
- `enter continue · esc back`

A bare `❯`/`›` is not enough, because both runtimes draw their input box and user messages with it.

In order:
1. `plan`: "Claude has written up a plan" / "Ready to code?" together with "Would you like to proceed?"
2. `trust`: a menu plus trust-folder text.
3. `permission`: a menu plus "Do you want to proceed?", "Would you like to run the following command?" and similar.
4. `menu`: a selector plus a confirm footer (for example the Claude-in-Chrome opt-in, which blocks a fresh session).

The busy marker is `esc to interrupt`.

**Precedence:**
1. A dialog on screen.
2. A waiting title.
3. A busy screen or busy title.
4. Otherwise, `idle`.

### Fixtures

`__fixtures__/agent-screens/` holds 10 real screens captured in tmux (120 columns). Paths, host and user names are scrubbed.

| Runtime | Fixtures |
|---|---|
| Claude Code | permission, trust, plan menu, onboarding menu, busy, idle |
| Codex | command approval, trust, busy, idle |

`manifest.json` records each fixture's captured title and expected verdict. `agent-attention.test.ts` runs every fixture twice: once with its title, once with the screen alone. The screen alone must be enough. The test prints `N fixture(s) examined` and fails on an empty set.

## Title capture

`PtyTerminalBuffer` subscribes to xterm's `onTitleChange` and exposes `getTitle()`. `PtySessionBackend.getTerminalTitle(name)` reads it. On `ISessionBackend` this method is optional.

## Flow

On every poll, `ActivityMonitorService` (30 s) does the following for each team member with a live session:
1. Captures 60 lines and the title.
2. Computes the verdict.
3. Keeps state in `agent-attention-registry.ts`, in memory. After a restart the next poll re-detects any prompt that is still showing.

### When an agent enters `waiting_on_human`

- It publishes `agent:waiting_on_human`, a critical event. `newValue` is `waiting_on_human:<kind>`.
- It calls `EscalationRouterService.recordAgentWaitingOnHuman`. This creates one pending escalation per session, with source `agent_waiting_on_human` and target `human`, and posts a Slack notice.
- The owner's approvals queue in OSS is **`GET /api/escalations`**. crewly-mobile's `useApprovals` polls it every 15 s.
  - `/api/approvals` is the Crewly-Agent in-process tool-approval queue, which has a 10-min TTL and where "approve" means "run the tool". That is the wrong fit.
  - Mobile's `GET /approvals` returns 404 today. That is filed as #817.
- **Latency:** one 30 s monitor poll plus one 15 s mobile poll is at most 45 s, inside the 1-minute bound.

### When the prompt is gone (or the session ends)

- It publishes `agent:waiting_resolved`, an info event.
- It closes that session's waiting escalations.

**Resolving the escalation does not answer the prompt.** The owner answers it in the agent's terminal. Remote answering is out of scope.

Logs carry rule names and line counts, never screen text.

## Reconciler

- `AgentHealth.waitingOnHumanSince` is filled from the registry (`getAgentHealthMap`).
- **New rule `detectWaitingOnHumanWorkItems`**, run in the full pass (60 s):
  - `running` → `blocked` once the agent has waited more than **5 min**. It sets `blockSource: 'waiting_on_human'` and a `blockedReason` that starts with `waiting_on_human:`.
  - `blocked` (that source) → `running` once the agent is active and no longer waiting. This goes through the normal →running path, which **resets `startedAt`**. Time spent waiting on the owner does not use up the stuck-timeout budget. Keeping the old `startedAt` would make a 4 h `delegate` item fail right after a long wait.
  - `blocked` (that source) → `queued` if the agent is inactive or missing: nobody holds the work any more.
  - None of these counts as a failure or a retry; `retryCount` is untouched.
- **New legal edge:** `blocked → running` in `WORK_ITEM_TRANSITIONS`, with the `TRANSITION_PERMISSIONS` entry `'blocked→running': {system}`. Agents and leads still unblock through `blocked→queued`.
- These rules and paths skip a waiting agent, or an item it parked, so they do not fight the new rule:
  - `detectRecoverableWorkItems` (the agent-back-online requeue)
  - `detectDependencyResolvedWorkItems`
  - the data provider's `requeueWorkItem`
  - `detectUnclaimedTasks` "redeliver": no brief is ever typed into a prompt
  - `findEvictableIdleAgent`: a waiting agent is never evicted as idle

## Plan-mode dismiss fix

`PLAN_MODE_PATTERNS` (exported as `PLAN_MODE_DISMISS_PATTERNS`) decides whether `dismissInteractivePromptIfNeeded` sends ESC before a message is delivered.

Its `/shift\+tab\s+to\s+cycle/i` matched the footer of **every idle Claude Code screen**: "bypass permissions on (shift+tab to cycle)" and "auto mode on (shift+tab to cycle)". So ESC was sent to idle agents before deliveries, and a second ESC opens Claude Code's Rewind UI.

The pattern is replaced with plan-menu text ("Claude has written up a plan", "Ready to code?"). Fixture tests assert that the idle footer does not match and the real plan menu does.

## Known limits

- **Orchestrator:** the monitor evaluates team members only, not the orchestrator session.
- **Title transitions:** detection is poll-based (30 s). A prompt answered within one poll is never seen, which is fine.
- **Claude Code permission prompts:** these are rare for Crewly agents, which launch with `--dangerously-skip-permissions`. The common real cases are:
  - trust dialogs
  - onboarding menus
  - plan menus
  - owners with custom `runtimeCommands`
  - Codex approvals
- **Wording drift:** a runtime that changes its dialog text needs a new fixture. Capture it the same way: run in tmux, `capture-pane -p`, `display -p '#{pane_title}'`, then scrub.
