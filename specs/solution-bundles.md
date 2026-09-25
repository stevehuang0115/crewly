# Solution bundles: one-step deployable team templates

Status: implemented on `feat/bundle` (engine, API, CLI, `/setup`). The first
paid bundle, `smb-marketing-team` (小老板营销团队), lives in
`crewly-pro/config/templates/` on `feat/solution-bundles`.

Plan: `ops/marketing/2026-09-template-deploy/00-plan.md` §4–§6.

## Goal

A non-technical small-business owner picks a bundle, answers a few questions
on a phone, and gets a complete working team: members with filled prompts,
norms and SOPs with review points, skills, Slack channels, recurring
schedules, first-week tasks, and a list of services still to connect.

## One format, not three

A bundle is an ordinary team template (`config/templates/<id>.json` or
`<dir>/<id>/template.json`, the `roles` format of `TeamTemplate`) with an
extra `bundle` section. Nothing else changes:

- Templates without `bundle` load and behave exactly as before
  (`TemplateService`, `crewly onboard`, the onboarding starters).
  `bundle-manifest.test.ts` checks every shipped OSS template.
- `TemplateService` carries `bundle` through; it does not validate it.
- The old Pro `cloud-deploy.json` (runtime, token estimate, `deployConfig`)
  is folded into `bundle.runtime`, `bundle.usage` and `bundle.server`.
- Bundles must use `roles` (not `members[]`), because roles carry the
  hierarchy, the lead, skills and job titles.

Paid bundles stay out of the OSS repo. The catalog reads the OSS
`config/templates/` plus every directory in `CREWLY_TEMPLATE_DIRS`
(path-delimited). Crewly Pro sets that variable to its own
`config/templates/` when it starts the engine; `crewly deploy-bundle
--templates-dir <dir>` does the same for one command.

## The `bundle` section

Types: `backend/src/types/solution-bundle.types.ts`. Validation:
`backend/src/services/bundle/bundle-manifest.ts` (`validateBundleTemplate`).
A bundle that fails validation is not listed or deployable; the catalog
reports it with every error.

| Field | Required | What it is |
|---|---|---|
| `schemaVersion` | yes | `1` |
| `status` | no | `ready` (default) or `draft`. Drafts are hidden and need `allowDraft` / `--allow-draft` |
| `label`, `tagline`, `ownerSummary` | yes | Owner-facing name, one-line pitch, what the team does each day / week |
| `ownerDoes` | no | What the owner has to do (e.g. "点头") |
| `runtime` | yes | `{ recommended, compatible?, model?, reason? }` — `recommended` is a `RUNTIME_TYPES` id |
| `server` | yes | `{ tier: entry \| standard \| advanced, minVcpu?, minMemoryGb?, requiresBrowser?, requiresGit? }` |
| `usage` | no | `{ runsPerDay?, tokensPerRun?, note? }` for pricing the hosted fee |
| `timezone` | no | IANA timezone of schedules and first-week tasks (placeholders allowed; default `Asia/Shanghai`) |
| `teamName` | no | Main team name (placeholders allowed; default the template name) |
| `teams` | no | Extra teams `{ key, name, description?, roles }`; the template's own `roles` are team `main` |
| `questions` | no | Deploy-time questions (below) |
| `norms` | no | `{ id, title, trigger?, content \| file, team? }` |
| `sops` | no | `{ id, title, category?, content \| file, team? }` |
| `reviewPoints` | no | `{ id, what, approver: owner \| lead, how?, team? }` — what needs the owner's OK |
| `skills` | no | `{ required: [...], optional?: [...] }` skill ids |
| `connectors` | no | `{ id, products?, required, why }` — ids are the `/connections` cards (`google-workspace` with `products` gmail / calendar / drive, `canva`, `whatsapp`, `slack`, `microsoft-todo`, …) |
| `slack` | no | `{ teamChannels?: boolean (default true), channels?: [{ key, name, purpose?, members }] }` |
| `schedules` | no | `{ id, title, cron, timezone?, target?, task }` |
| `firstWeek` | no | `{ id, day: 0–6, time?: "HH:MM", target?, title, task }` |
| `todo` | no | Open items for the template's authors |

Rules the validator enforces:

- Every team has exactly one clear lead: a role with `hierarchyLevel: 1`
  and `canDelegate: true`. `reportsTo` must name a role of the same team.
- `defaultName` is ASCII (session names are built from it); Chinese titles
  go in `jobTitle`. Names are unique per team.
- **Member refs** (`target`, channel `members`) are `role` (main team) or
  `team/role`; `*` in channel members means every member of every team.
  Unknown teams or roles are errors. A ref to a counted role means its first
  member. `target` defaults to the main team's lead.
- **Placeholders** are `{{question_id}}`, plus the built-ins `team_name` and
  `lead_name` (filled per team). Every placeholder in prompts
  (`promptAdditions`, `jobDescription`), names, norms / SOPs (inline and
  `file`), review points, channels, schedules, tasks and the timezone must
  name a question or a built-in.
- Questions: `id` is lower snake case and unique (it is the placeholder);
  `type` is `text | textarea | select | multiselect`; select / multiselect
  need `options`; an optional question must declare a `default` (may be
  `""`), and a choice default must be an option.
- `cron` is five fields in range; `day` is 0–6; `time` is `HH:MM`;
  norm / SOP `file` is a relative path inside the template directory and
  must exist; the norm id `owner-review-points` is reserved.
- Connector ids are known; `products` only on `google-workspace`.

Excerpt (`crewly-pro/config/templates/smb-marketing-team/template.json`):

```json
{
  "id": "smb-marketing-team",
  "tier": "pro",
  "defaultRuntime": "crewly-agent",
  "roles": [
    { "role": "team-leader", "defaultName": "Ava", "jobTitle": "营销负责人",
      "hierarchyLevel": 1, "canDelegate": true,
      "promptAdditions": "你是 {{lead_name}}，{{team_name}}的负责人。…品牌：{{business_name}}…" }
  ],
  "bundle": {
    "schemaVersion": 1,
    "label": "小老板营销团队",
    "runtime": { "recommended": "crewly-agent", "compatible": ["claude-code", "codex-cli"], "model": "deepseek-chat" },
    "server": { "tier": "entry", "minVcpu": 2, "minMemoryGb": 4 },
    "timezone": "{{timezone}}",
    "teamName": "{{business_name}} 营销团队",
    "questions": [
      { "id": "business_name", "label": "公司或品牌叫什么？", "type": "text", "required": true },
      { "id": "platforms", "label": "在哪些平台做内容？", "type": "multiselect", "required": true, "options": [{ "value": "小红书" }] }
    ],
    "norms": [{ "id": "brand-voice", "title": "{{business_name}} 的品牌口吻", "file": "norms/brand-voice.md" }],
    "reviewPoints": [{ "id": "publish", "what": "任何要公开发布的内容", "approver": "owner" }],
    "slack": { "channels": [{ "key": "approvals", "name": "{{business_name}}-待审批", "members": ["team-leader", "content-strategist"] }] },
    "schedules": [{ "id": "daily-brief", "title": "每日简报", "cron": "0 9 * * 1-6", "target": "team-leader", "task": "…" }],
    "firstWeek": [{ "id": "brand-voice-guide", "day": 0, "title": "认识你的生意，写品牌口吻指南", "task": "…" }]
  }
}
```

## Answers

`services/bundle/bundle-placeholders.ts`. `resolveAnswers(questions, raw)`:

- trims text; a required question without an answer is **missing**; an
  optional one takes its `default`;
- a select answer must be an option; a multiselect takes a list (or one
  value) of options; text is capped at 2,000 characters;
- unknown keys are ignored; numbers / booleans become text;
- every problem is reported at once (`BundleAnswersError`: `missing`,
  `invalid`, each with the question's label). Nothing is written.

A multiselect fills its placeholder joined with `、`. `fillPlaceholders`
throws `BundlePlaceholderError` naming the placeholder and where it is when
a value is missing.

## Apply engine

`services/bundle/bundle-apply.service.ts` (`BundleApplyService`). All
collaborators are injected; `bundle-apply.factory.ts` wires the backend,
`bundle-deps.ts` the backend-free set the CLI uses.

`start({ templateId, answers?, runtime?, allowDraft? })` validates first
(`unknown_bundle`, `bundle_not_ready`, `invalid_runtime`, `invalid_answers`),
persists the deployment, and runs the steps in the background.
`applyAndWait` does the same and waits.

| Step | Does | Existing service it uses |
|---|---|---|
| `team` | Builds each team (`main` + `bundle.teams`) with filled prompts and saves it; an existing team is kept | `StorageService.saveTeam`; team id `<templateId>` / `<templateId>--<key>`, `templateId` recorded, session names `<team-id-slug>-<member>-<id8>` like the onboarding starters |
| `norms` | Writes norms, one `owner-review-points` norm from `reviewPoints`, and SOPs, with frontmatter | The files `get-team-norms` reads (`teams/<id>/norms/<id>.md`, `title` / `trigger` / `updatedBy` / `updatedAt`) and `get-sops` reads (`teams/<id>/sops/<category>/<id>.md`, `title` / `category`) |
| `skills` | Installs required and optional skills that are not bundled or installed; optional failures do not fail the step | `BundleSkillInstaller` over the marketplace install (`fetchRegistry` + `installItem`, the `crewly install` / `POST /api/marketplace/:id/install` path) |
| `connectors` | Checks each connector; `pending` (`connectors_missing`) while a required one is not connected; links `/connections?platform=<id>` | Google / Canva / Microsoft token services' `status()` (Google per product), WhatsApp and Slack services |
| `slack` | The team channel for every team, then extra channels with their agents | `SlackTeamChannelService.ensureTeamChannel`, and the new `ensureAgentChannel` (an ad-hoc mapping `adhoc:<channel>` with a member roster, owner invited, installed agent bots invited — now or when they install) |
| `schedules` | Creates each recurring task for its target agent in the bundle timezone | `CronTaskService.create` (dedups identical tasks; fires into the task pool as a WorkItem) |
| `first_week` | Day-0 tasks go to the orchestrator now; later days are stored with their due time and delivered when due | `sendChatMessageToOrchestrator` (the onboarding first-task path: stored as an owner message, ticket intake, queued while the orchestrator is offline). Message: `[成套方案 · 第一周] 第 n 天 · <title>` + "请交给团队「…」(team id: …) 的 <member> 来做" + the task |

Step states: `queued → running → done | failed | pending | skipped`.
`pending` carries a reason: `slack_not_connected`, `backend_not_running`,
`connectors_missing`. `skipped` carries `team_failed` or `nothing_to_do`.
Overall: `done` when every step is done (or had nothing to do), `failed`
when the team could not be created, otherwise `partial`.

**Idempotent and resumable.** The deployment
(`<crewlyHome>/bundles/<templateId>.json`, `BundleDeploymentStore`) is written
atomically after every step. A re-run skips `done` steps; inside a step, an
existing team is kept, schedules and channels are recorded (and the cron
service dedups), and a first-week task is sent once. One failing step does
not stop the others; only the team is a prerequisite (norms, Slack,
schedules and first week are `skipped: team_failed` without it). A re-run
without `answers` reuses the stored ones; once the team exists its answers
and runtime are kept. A second `start` while a run is in flight joins it
(double tap on a phone).

**Waiting steps finish by themselves.** The backend runs a maintenance pass
at start and every 5 minutes (`startBundleMaintenance`): it re-runs
deployments with a step pending on `backend_not_running` (a CLI deploy while
Crewly was stopped) or on `slack_not_connected` once Slack is connected, and
delivers first-week tasks that are due. `connectors_missing` is not
re-polled; applying again re-checks it.

**Runtime.** `runtime` wins; else the recommended runtime when this
machine can run it (`crewly-agent` with `DEEPSEEK_API_KEY`, or a coding
harness equal to the orchestrator's); else the orchestrator's harness; else
the recommendation (`bundle-runtime.ts`). Every member of the bundle gets
the same runtime.

**Home directory.** Everything honours `CREWLY_HOME`. The marketplace
installer still writes to `~/.crewly`, so under another `CREWLY_HOME` the
installer refuses instead of installing (bundled skills need no install).
While building this, two services that ignored `CREWLY_HOME` were fixed:
`TeamsBackupService` (a CLI deploy under a temp home rotated a snapshot into
the real `~/.crewly/teams-backup-history`) and `CronTaskService`'s default
home.

## API (`/api/bundles`)

| Method & path | Body | Response `data` |
|---|---|---|
| `GET /` | – (`?drafts=1` adds drafts) | `{ bundles: BundleSummary[] }` |
| `GET /:templateId` | – | `{ bundle: BundleDetail (questions, members, skills, connectors, schedules, first week, channels), deployment \| null }` |
| `POST /apply` | `{ templateId, answers?, runtime?, allowDraft? }` | 202 `{ jobId, deployment }` |
| `GET /apply/:jobId` | – | `BundleDeployment` (live while running, else the stored one) |

Errors: `{ success: false, error, code, missing?, invalid? }`.
`unknown_bundle`, `job_not_found` → 404; `bundle_not_ready` → 409;
`invalid_runtime`, `invalid_answers` → 400.

**Owner-only.** `POST /apply` and `GET /apply/:jobId` refuse any request with
`X-Agent-Session` (403), like `/api/harness` and the setup checklist. The
catalog reads stay open.

**Relay.** `MobileApiRelayService` allowlists `GET /bundles` (list, detail,
job) and `POST /bundles/apply`, so the portal / phone app can deploy.

## `/setup`

`GET /api/onboarding/starters` now lists, after the free starters and
before Blank, every ready bundle (`kind: 'bundle'`; starters also carry
`kind: 'template' | 'blank'`). Picking a bundle in the team step opens
`BundleDeployStep`: what the team does and what the owner does, the members,
the recommended runtime and server tier, then `BundleQuestionsForm` (text,
textarea, select, multiselect chips; required checked on the phone and by
the server, whose `missing` answers are marked on the fields). Deploy shows
each step live, pending steps with what they wait for, and the services to
connect as links. A failed step can be retried (a re-apply without answers).
"下一步" goes to 第一件事, which says the first week is already planned.

## CLI

```
crewly deploy-bundle <template-id> --answers answers.json [--runtime <id>]
                     [--templates-dir <dir>]… [--dry-run] [--allow-draft] [--json]
crewly onboard --template <bundle-id> [--answers answers.json] [--runtime <id>] [--yes]
```

- The answers file is `{ "<question id>": "<answer>" }` (lists for
  multiselects). Missing answers are refused before anything is written,
  with a skeleton of the file to fill in.
- With this user's backend running, the deploy goes through
  `POST /api/bundles/apply` and the job is polled (1.5 s, up to 10 min).
  Otherwise the engine runs in-process: team, norms, SOPs, skills and
  schedules are written; Slack, connector checks and first-week hand-offs
  stay pending until the backend starts. `--templates-dir` is only seen by
  the in-process engine (a running backend reads `CREWLY_TEMPLATE_DIRS`).
- `--dry-run` validates the bundle (and the answers, when given) and prints
  the plan. Exit code 1 when refused or when a step failed; a re-run
  retries.
- `crewly onboard --template <bundle>` asks the questions in the terminal
  (a number picks an option, comma-separated for multiselect, Enter takes
  the default) unless `--answers` covers them; with `--yes` it never asks.
  The bundle's first-week tasks replace the first-task step (`--task` still
  adds one).
- Hosted servers (cloud-init) run `crewly deploy-bundle` with the answers
  collected at checkout and `--runtime crewly-agent`.

## Pending on `feat/skill-autoinstall`

The engine installs through `BundleSkillInstaller`
(`bundle-skill-installer.ts`). When the skill-autoinstall branch lands, swap
the marketplace implementation for one over its `SkillDiscoveryService`
(bundled / installed / registry resolution with official-source checks) and
`SkillInstallJobService` (install jobs with OS setup recipes, e.g.
whisper.cpp), and let `isAvailable` use discovery. The interface and the
engine do not change.

## Not in this change

- Charging for bundles (Stripe products), entitlement checks and delivering
  paid templates to a local install (today a bundle is available where its
  directory is: Pro / hosted servers).
- Starting the team's agents at deploy; the orchestrator starts them when
  the first task arrives, and cron fires start them through the task pool.
- Re-polling connectors on a timer; an extra-channel roster shrinking when
  a bundle is re-applied with fewer members.
