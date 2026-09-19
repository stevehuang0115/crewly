# Per-agent model selection (2026-09-19)

## Problem

`TeamMember.modelId` existed but was only read by the in-process
`crewly-agent` runtime. Agents on Claude Code / Codex / Gemini / OpenCode
all ran whatever the harness's global default was (`~/.codex/config.toml`
`model = …`, Claude's account default, …). A team could not mix, say, a
cheap model for a note-taker with a strong one for the architect.

A second latent bug: skill `runtimeFlags` (e.g. `--chrome`) were injected
by replacing `--dangerously-skip-permissions`, which only exists in the
Claude Code launch line — flags for every other runtime were dropped.

## Harness flags (verified with `--help`)

| runtime      | model                    | reasoning effort                                   |
|--------------|--------------------------|----------------------------------------------------|
| claude-code  | `--model <alias\|name>`  | `--effort low\|medium\|high\|xhigh\|max`           |
| codex-cli    | `-m, --model <MODEL>`    | `-c model_reasoning_effort="<level>"` (config key) |
| gemini-cli   | `-m, --model <name>`     | —                                                  |
| opencode-cli | `--model provider/model` | —                                                  |
| crewly-agent | `modelId` in code        | —                                                  |

`codex resume <id>` accepts the same global flags after the subcommand, so
resumed conversations keep the member's model.

## Design

- `TeamMember.modelId` is now runtime-agnostic: the string the harness
  itself accepts. `TeamMember.reasoningEffort` (new, optional) maps to the
  effort flag where one exists. The orchestrator carries the same two
  fields in `teams/orchestrator.json`.
- `backend/src/utils/runtime-model-flags.utils.ts`
  - `buildRuntimeModelFlags(runtime, modelId, effort)` → flag list.
    Values must match `[A-Za-z0-9][A-Za-z0-9._:/-]*` / `[a-z][a-z0-9]*`;
    anything else is ignored (never quoted onto a shell line).
  - `injectRuntimeFlags(cmd, runtime, flags)` inserts flags right after the
    binary (`claude`, `codex` / `codex resume`, `gemini`, `opencode`) and
    strips a pre-existing copy of the same flag so the member override
    beats a model baked into `settings.general.runtimeCommands`. Fallbacks:
    before `--dangerously-skip-permissions`, else appended.
- `AgentRegistrationService.resolveModelFlags` appends the model flags to
  the skill `runtimeFlags` for members (both lookup branches) and for the
  orchestrator; `executeRuntimeInitScript` now injects every runtime's
  flags with `injectRuntimeFlags` (fixes the dropped-flags bug).
- API: `POST /api/teams`, `PUT /api/teams/:id` (members[]),
  `PUT|PATCH /api/teams/:id/members/:memberId` and
  `PUT /api/orchestrator/runtime` accept `modelId` / `reasoningEffort`;
  `''` clears a field. Validation: `provider/model` with a known provider
  only when the runtime is `crewly-agent`; shell-safe otherwise.
- UI: Team modal + Agent detail modal show a free-text model field with
  per-runtime suggestions (`<datalist>`) and a hint of the flag used, plus
  an effort select for Claude Code / Codex. `crewly-agent` keeps its
  provider/model select.

## Not done / follow-ups

- No live model list per harness (Codex `api_key_model_discovery` is still
  "under development"); presets are hand-maintained in
  `frontend/src/types/index.ts`.
- The Settings page has no orchestrator model field; the API supports it.
