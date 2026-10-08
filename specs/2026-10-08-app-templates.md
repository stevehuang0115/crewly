# Crewly App templates on the Marketplace (OSS side)

Epic: crewly#1045 ("no templates yet — revisit after real use"; this is the revisit).
Cloud side: crewly-services `apps/SPEC.md` §17. Portal: crewly-web (Marketplace → Apps).

## Goal

An app an agent built can become a **template** — its code, with no data — on
the Crewly Marketplace. Other people copy it into their own account. Before an
agent builds a new Crewly App it looks for a matching template, starts from it,
adapts it to the owner and publishes it as the owner's own app. The owner is
usually away from the machine: they only tap.

## Flows

### Publish as a template (agent asks, owner taps)

1. `publish-app --app <id> --as-template --description "…" [--tags] [--category] [--author] [--sample-data f.json]`
   → `POST /api/apps/:appId/template-request` (publisher or teammate only, like republishing).
2. The backend asks Cloud for a **draft** (`POST /api/apps/v1/apps/:appId/template-drafts`,
   instance-bound, agent-attributed). Cloud snapshots the current version's files
   plus a manifest (name, description, category, tags, capabilities, collection +
   field names; never data, files, comments, collaborators or the owner) and
   **scans** it for secrets and personal data. A finding refuses the draft:
   422 `unsafe_content` with `findings: [{ path, line, kind, what, excerpt }]`
   (masked), passed through to the skill so the agent can fix the code.
3. A decision card (kind `app_template`, `sensitive: 'publish'`, never applied
   at its 72 h deadline): "Publish “<app>” as a public template on the Crewly
   Marketplace? <agent> asked." with the preview link (sample data only), what is
   and isn't included, the agent's description (labelled as written by the agent),
   and *Publish as <author>* (only when `--author` was given) / *Publish anonymously* / *Don't publish* (default).
4. On a publish option the backend calls `POST /api/apps/v1/templates/:id/approve
   { version, authorName|null }` **as the owner** (no instance / agent headers;
   Cloud refuses those). Otherwise `…/discard`. The agent gets
   `[APP TEMPLATE] …` with the outcome and the Marketplace link.
5. The owner can unlist / relist / rename the author / delete from the portal;
   any agent of the account can unlist (`publish-app --unlist-template <id>`).

### Find and use (before building a new app)

- `find-app-template --query "<need>" [--tag] [--category] [--limit]` →
  `GET /api/apps/templates` → Cloud's public search. Output includes a `next`
  line telling the agent what to do.
- `use-app-template <templateId> --dir ./<dir> [--name]` →
  `POST /api/apps/templates/:templateId/use { name?, source }` → Cloud makes a
  **new app in this account** (empty data, the agent as creator,
  `fromTemplate` provenance; counts as creating an app) → the backend records it
  in the local registry with the agent as publisher and `<dir>` as its source →
  returns the template's files, which the skill writes into `<dir>` (a new or
  empty directory inside the project; never outside, never Crewly's home). The
  agent adapts the files and publishes with `publish-app --dir <dir>` (same app).
- From the portal ("Use this template" → pick a machine) the relay calls the
  same route as the owner (allowlisted: `POST /apps/templates/:id/use`). The
  orchestrator becomes the app's publisher and is told to fetch the files with
  `use-app-template --app <appId> --dir …` (`POST /api/apps/:appId/template-files`),
  ask the owner in one line what to change, and republish.

### Prompt rule

`skills-reference` (Crewly Apps paragraph) and the publish-app SKILL.md: before
building a new Crewly App run `find-app-template`; if a template fits, start
from it with `use-app-template`, adapt it, and tell the owner in one line which
template it started from. `--as-template` only asks the owner.

## Routes (this backend, `/api/apps`, owner or verified agent)

| Method | Path | |
|---|---|---|
| GET | `/templates?q&tag&category&limit` | search |
| GET | `/templates/mine` | the account's templates |
| POST | `/templates/:templateId/use` | `{ name?, source? }` → app + files (relay-allowlisted for the owner) |
| POST | `/templates/:templateId/unlist` | |
| POST | `/:appId/template-request` | `{ description, name?, category?, tags?, author?, sampleData? }` → card |
| POST | `/:appId/template-files` | `{ source? }` → files of the template an app came from |

The template routes are registered before the `/:appId` routes.

## Security

- No agent can list a template: the only listing call is the owner-actor call
  made after the owner's tap (same trust model as app collaborators), or the
  portal's own sign-in.
- What is listed is fixed when the agent asks (template id + draft version
  stored on the decision); Cloud refuses an approval for another version.
- Template files are written by the skill as the agent, into a checked project
  directory; server paths are re-checked (no absolute, `..` or dot segments).
- The large `use` response is read with the skill's own `curl` (not
  `api_call`, which would park a big body on disk).
