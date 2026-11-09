# Model tiers and "Optimize usage" (crewly#1173, phases 1 and 2)

Status: phase 1 (recommendation mode, #1185/#1186/#1416) and phase 2 (change mode "Lead decides, tells me", idle restarts on apply). Default stays phase 1: the team lead proposes, the owner approves every change.

## Why

Cheap fast models can do routine work (polling, first-pass sorting, formatting). Before this, every member ran on one model: its own `modelId`, or the reviewed-member default (Sonnet). Measured from the usage ledger over 2026-10-10 to 2026-10-16 (all teams on one machine, estimated at API list price, not a bill), Opus was 79–80% of cost and Sonnet about 20%; team-lead turns were 49–53% of total cost and about 60% of the Opus cost, member turns 40–44%, the orchestrator about 2%. Method, coverage and the reproduce script: `.crewly/findings/2026-10-17-model-cost-share-week-1010-1016.md`.

## Tiers

`TeamMember.tier`: `strong` | `mid` | `weak`. Resolved at launch, for the runtime that really runs, through the existing model-flag path (`effectiveMemberModelId`, `fallbackRuntimeModelId` in `utils/member-default-model.utils.ts`).

Precedence: explicit `modelId` > tier model > reviewed-member default (Sonnet) > the runtime's own default. The orchestrator never takes a tier.

Global map (`MODEL_TIER_CONSTANTS.DEFAULT_TIER_MODELS`), overridable per team (`Team.tierModels = { runtime: { tier: model } }`):

| Runtime | strong | mid | weak |
|---|---|---|---|
| claude-code | opus | sonnet | haiku |
| codex-cli | gpt-5.6-sol | gpt-5.4 | (unmapped → mid) |
| gemini-cli | gemini-2.5-pro | gemini-2.5-flash | (unmapped → mid) |
| antigravity-cli | gemini-3.1-pro-high | gemini-3.8-flash-high | gemini-3.8-flash-medium |
| opencode-cli, crewly-agent | unmapped | unmapped | unmapped |

Model names come from the dashboard presets (`RUNTIME_MODEL_PRESETS`) and `agy models`. A runtime with no `weak` model uses its `mid` model; any other unmapped tier passes no model flag (runtime default). On a fallback runtime a tier resolves for that runtime (a tier is runtime-neutral; a model id is not).

## "Optimize usage" (per team, default off)

`Team.optimizeUsage`. Owner-only: `PUT /api/teams/:id/model-tiers { optimizeUsage?, tierChangeMode?, tierModels?, memberTiers? }`, the team page ("More" → Model tiers: switch + change mode + per-member tier dropdown + Review now). `PATCH /api/teams/:teamId/members/:memberId { tier }` is owner-only too.

### Change mode (phase 2)

`Team.tierChangeMode: 'approve' | 'auto'`, default `approve`, owner-only (same `PUT`, and on the team page a segmented control next to the switch: "Ask me first" / "Lead decides, tells me"; enabled only while "Optimize usage" is on). Auto behaviour needs both: `optimizeUsage === true && tierChangeMode === 'auto'` (`leadChangesTiersItself`). With "Optimize usage" off nothing is reviewed in either mode.

While on:

1. **Review** — hourly tick: when 7 days passed since the last review (or never), the lead gets `[MODEL TIER REVIEW]`: per member turns, average context, output tokens, estimated cost by model (list price), work items handled (titles + kinds) and send-back rate, plus instructions. Also on demand (`POST /api/teams/:id/model-tiers/review`, owner or the team's lead).
2. **Proposals** — `propose-tier-change --member X --tier weak --reason …`, `--routing "polling / formatting -> X"`, then `--submit` (`POST /api/teams/model-tiers/proposals`, the lead only). Proposals collect in a draft. A draft not submitted within 2 hours is submitted automatically. Submit with nothing proposed closes the review without a card or notice. A lead cannot propose itself below mid; the orchestrator never takes a tier (both modes).
   - **Approve mode**: submit posts **one** owner card (kind `model_tier_change`, from the lead's bot, top-level in the team channel when mapped) with Apply / Keep as is, default Keep as is, 72h. A second submit while it is open is refused.
   - **Auto mode**: submit applies the draft at once through the same `apply` path as an owner Apply, then posts **one notice** in the same place the card would go. The notice reuses the decision card (`askPrebuilt`, kind `model_tier_change`): question "Owen changed model tiers for Marketing: Ella → weak, Sam → mid.", one line per member (old → new tier and model, cleared fixed model, the lead's reason), new routing rules, the saving estimate; options **Undo** / **Keep**, default and plain "yes" = Keep, 72h (`NOTICE_DEADLINE_MS`). Its subject is the undo (`TierChangeSubject.kind = 'undo'`, `notice = 'applied'`, `undoOf` = the batch id, `changes` = the reverse entries, `removeRouting` = rules this batch added). A notice card has no "Remind me" / "Skip" buttons (`isNoticeCard`); skipping it = Keep. A notice does not block the next review (`openDecisionId` is not set). If notices cannot be posted on this machine (no decision service), submit is refused (503) and nothing changes — the owner must always be able to undo.
3. **Apply** — tiers are set, a member's fixed `modelId` is cleared (the card / notice says so) so the tier takes effect, routing rules go to `Team.tierRoutingRules`. Approve mode: only on the owner's Apply (Keep as is / deadline / skip: nothing changes). Auto mode: on submit.
   - **Undo** (owner taps it on an applied notice) puts back exactly those changes: each member's previous tier (or no tier) and its cleared fixed model, and removes the routing rules the batch added. A member whose tier changed again since (owner or lead) is left alone; the lead is told how many were skipped. The undone entries are marked `undone` and not watched. Keep / deadline / skip: nothing changes, the lead is told nothing.
   - **Restart idle members** (both modes, also on undo and revert): after an apply, each member whose effective model changed is restarted when it is idle — running (PTY or in-process), not mid-turn (observed working status not `in_progress`, no PTY output for 20 s) and holding no claimed work item (`running` / `accepted`). The restart uses the runtime fallback's relaunch path, now shared as `services/agent/member-relaunch.ts` (`isAgentBusy`, `stopForRelaunch` → `AgentRegistrationService.stopSessionForRelaunch`, `startMemberSession` → `createAgentSession`, which resumes the conversation), marked as a planned relaunch (`model_tier_change`) so the hung / heartbeat monitors leave it alone. Restarts run one after another in the background. A busy or stopped member picks the model up at its next start. A busy member is never stopped.
4. **Quality guard** — every lowered member is watched. Baseline: its last 10 settled work items before the change. After 5 settled items since the change: if at least 2 were sent back (rejected, failed or retried) and the rate rose by more than 0.2, the change is judged worse. Otherwise `ok`; unjudged after 30 days → `expired`.
   - **Approve mode**: a revert card ("Move back" / "Keep as is") goes to the owner (`revert_proposed`).
   - **Auto mode**: the member is moved back at once (same reverse entry and apply path; `auto_reverted`), the lead is told, and the owner gets a notice ("Ella's work was sent back more often on the weak tier, so it was moved back to …", the before / after send-back numbers) with **Keep the lower tier** / OK, default OK. "Keep the lower tier" re-applies the lowered tier (clears the fixed model again); the owner's choice is not watched again.
5. **Prompt** — leads of such teams get a short "Model Tiers" section: members by tier, routing rules in force, route work to the weakest fitting member, and the change mode — "the owner approves" (how to propose) or "you decide" (changes take effect at once, idle members restart, the owner gets a notice and can undo; change only what the review supports). The weekly review message says the same.

State: `CREWLY_HOME/model-tier-reviews.json` (last review, draft, open card, applied changes + guard). Guard states: `watching`, `ok`, `revert_proposed`, `auto_reverted`, `undone`, `expired`, `not_watched`. `AppliedTierChange.decisionId` is the approving decision, or the batch id (`TR-…` review, `TG-…` guard revert) of a change applied without a card.

## Not in phases 1–2

- A "super" tier above strong (e.g. Fable).
- Changing the review frequency.
- Showing the applied-change history on the team page (the API returns `review.recent`).
Pricing: Haiku 5.5 is priced in `model-pricing` since #1416 (long prompts at 5x), so weak-tier saving estimates use it.
