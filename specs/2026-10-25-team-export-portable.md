# Portable, secret-free team packages (#880 slice 1)

Status: shipped 2026-10-25 (API + CLI 1.20.412, dashboard 1.20.413).

A team should travel as one file the owner can keep, hand to someone else or
load into another Crewly, without anything of this install's running state
or any credential inside. The export/import endpoints existed (03-28) but
returned the stored team object as is. This slice makes the package portable
and adds the CLI.

## Package

`TeamExport` version `1.1` (`backend/src/services/core/team-export.service.ts`):

| Field | Content |
|---|---|
| `team` | `config.json` with every member `sessionName: ''`, `agentStatus: 'inactive'`, `workingStatus: 'idle'`, and `agentId`, `currentTickets`, `readyAt`, `loginRequired`, `usageLimited`, `runtimeOverride`, `capabilities`, `lastActivityCheck` removed (`TEAM_EXPORT_CONSTANTS.RUNTIME_MEMBER_FIELDS`) |
| `prompts` | `prompts/<memberId>.md` |
| `norms` | `norms/*.md` |
| `cronTasks` | `cron-tasks.json` tasks as stored (ids are regenerated on import) |
| `portability.redactions` | secrets masked across the package |
| `portability.scanClean` | a last `redactSecretsWithCount` over the serialized package found nothing |
| `portability.connectors` | connector ids the team refers to (`CONNECTOR_HINTS` word match over system prompts, roles, skills, prompts, norms, schedule descriptions): `google-workspace`, `canva`, `microsoft-todo`, `whatsapp`, `slack` |
| `portability.strippedFields` | which runtime fields were actually present and removed |

Masking: every string in the package goes through `redactSecretsWithCount`
(token shapes + `NAME=value` with a secret-looking name) plus the exact values
of this process's secret env vars (`collectSecretEnvValues(process.env)`).
Grants (Google, Canva, Slack tokens) live outside the team directory and never
enter the package; the connector list tells the importer what to reconnect.

Import accepts `1.0` and `1.1`, strips runtime state again (a 1.0 package
taken from a running team comes in idle), regenerates cron ids, and returns
`connectorsToReconnect` (from the package, or derived for 1.0). An unknown
version is a 400.

## Entry points

- `GET /api/teams/:teamId/export` — owner only; `?download=1` sends the
  package as `attachment; filename="crewly-team-<slug>.json"`.
- `POST /api/teams/import` — owner only; body is the package or a saved
  `{ success, data }` answer.
- `crewly team export <team> [--out <file>] [--json]` — resolves name or id,
  writes `crewly-team-<slug>-<date>.json`, prints members/prompts/norms/
  schedules, secrets masked, scan result, connectors to reconnect. Exit 2 when
  the final scan is not clean.
- `crewly team import <file> [--json]` — posts the package; prints counts and
  the connectors to reconnect. Members start inactive.
- Dashboard (Teams page, `frontend/src/services/team-export.service.ts`):
  "Export team…" in a team row's ⋯ menu downloads
  `crewly-team-<slug>-<date>.json` and confirms what the file holds and what
  to reconnect; the toolbar's Import button (file picker, `.json`) imports a
  package or a saved API answer, reloads the list and names the connectors to
  reconnect. Both use the same words as the CLI (`describePackage`,
  `describeImport`).

## Not in this slice

- Portal (crewlyai.com) download/import — the dashboard has it; the
  `download=1` mode is for the portal, which can stream the file without
  building it client-side.
- Project repositories: a package names `projectIds` only; code moves with
  `crewly team move` (specs/2026-10-12-team-move.md) or `git clone`.
- Wiki, tickets, memory: the package is the team's definition, not its history.
- Agent-authored exports: export is owner only on purpose, since the package
  holds every prompt and schedule of the team.
