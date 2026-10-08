# Model tiers and "Optimize usage" (crewly#1173, phase 1)

Status: phase 1 (recommendation mode). The team lead proposes; the owner approves every change. No automatic tier changes.

## Why

Cheap fast models can do routine work (polling, first-pass sorting, formatting). Before this, every member ran on one model: its own `modelId`, or the reviewed-member default (Sonnet). Measured over 7 days at list price, Opus was about 95% of cost, dominated by lead turns at 120–480k context.

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

`Team.optimizeUsage`. Owner-only: `PUT /api/teams/:id/model-tiers { optimizeUsage?, tierModels?, memberTiers? }`, the team page ("More" → Model tiers: switch + per-member tier dropdown + Review now). `PATCH /api/teams/:teamId/members/:memberId { tier }` is owner-only too.

While on:

1. **Review** — hourly tick: when 7 days passed since the last review (or never), the lead gets `[MODEL TIER REVIEW]`: per member turns, average context, output tokens, estimated cost by model (list price), work items handled (titles + kinds) and send-back rate, plus instructions. Also on demand (`POST /api/teams/:id/model-tiers/review`, owner or the team's lead).
2. **Proposals** — `propose-tier-change --member X --tier weak --reason …`, `--routing "polling / formatting -> X"`, then `--submit` (`POST /api/teams/model-tiers/proposals`, the lead only). Proposals collect in a draft; submit posts **one** owner card (kind `model_tier_change`, from the lead's bot, top-level in the team channel when mapped) with Apply / Keep as is, default Keep as is, 72h. A draft not submitted within 2 hours is sent automatically. Submit with nothing proposed closes the review without a card. A lead cannot propose itself below mid.
3. **Apply** — only on the owner's Apply: tiers are set, a member's fixed `modelId` is cleared (the card says so) so the tier takes effect, routing rules go to `Team.tierRoutingRules`. Each member picks up its model at its next start; the lead is told it may restart an idle member. Keep as is / deadline / skip: nothing changes.
4. **Quality guard** — every lowered member is watched. Baseline: its last 10 settled work items before the change. After 5 settled items since the change: if at least 2 were sent back (rejected, failed or retried) and the rate rose by more than 0.2, a revert card ("Move back" / "Keep as is") goes to the owner. Otherwise `ok`; unjudged after 30 days → `expired`.
5. **Prompt** — leads of such teams get a short "Model Tiers" section (members by tier, approved routing rules, route work to the weakest fitting member, how to propose).

State: `CREWLY_HOME/model-tier-reviews.json` (last review, draft, open card, applied changes + guard).

## Not in phase 1

- Automatic tier changes by the lead.
- A "super" tier above strong (e.g. Fable).
- Restarting idle members on apply (the lead does it with stop-agent / start-agent).
- Pricing: `model-pricing` still prices Haiku at the 4.5 list price ($1 / $5 per M). The repo has no Haiku 5.5 price source, so the table was left as is; savings estimates for weak Claude members are therefore conservative.
