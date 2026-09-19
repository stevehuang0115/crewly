# Connectors: what to add, how hard, how (2026-09-19)

## How a connector works in Crewly today

One pattern, already proven with Slack and Google Workspace:

```
Browser ── consent ──▶ Crewly Cloud (services/auth)        holds client_secret + refresh token
                         GET  /api/cloud/<vendor>/start     302 → vendor consent
                         GET  /api/cloud/<vendor>/callback  code → tokens → Mongo (SecretBox-encrypted)
                         GET  /api/cloud/<vendor>/token     short-lived access token
OSS instance (crewly)    <vendor>-token.service.ts          asks Cloud /token, caches 60 s margin
                         <vendor>.service.ts                talks to the vendor API directly
                         /api/<vendor>/*                    controller + routes
config/skills/agent/core/<vendor>-<verb>/                   bash skill → api_call → JSON for the agent
frontend Settings → Integrations                            Connect / Disconnect card
```

Vendor data never passes through Cloud (only the tokens). An OSS install
therefore never needs a client secret, and one Cloud login covers every
instance the owner runs.

Cost to add a connector: **vendor already on a grant (new Google product) ≈
½ day; new vendor with plain OAuth ≈ 1 day; vendor with an app-review gate =
same code + weeks of waiting.**

## What exists now

| Vendor | Status | Skills |
|---|---|---|
| Slack | live (v3, Cloud master app + per-agent apps) | slack-post, team channels, DMs |
| Gmail | live | gmail-search / gmail-read / gmail-send |
| Google Calendar | live | calendar-list / calendar-create |
| Google Drive | **new (faa00ac8, unreleased)** | drive-search / drive-read / drive-upload |
| Google Docs | new | docs-read / docs-write (create, append) |
| Google Sheets | new | sheets-read / sheets-write (create, append, update) |
| Google Slides | new | slides-read / slides-create (outline → deck) |
| Discord / Telegram / WhatsApp / Google Chat | messaging bridges (owner-provided tokens) | — |
| Browser (Chrome extension) | live via relay | remote-browser |

The four new Google products ride on scopes the grant already has
(`drive.readonly`, `drive.file`, `documents.readonly`): read anything the
owner can see, create new files, edit files Crewly created. **Owner step:**
make sure Drive / Docs / Sheets / Slides APIs are enabled on GCP project
`crewlyai` (Gmail/Calendar already are). No re-consent needed.

Limitation: editing a Doc/Sheet/Slides the customer made *outside* Crewly
needs `documents` / `spreadsheets` / `presentations` scopes → add them on
the consent screen + `GOOGLE_WORKSPACE_SCOPES` (Cloud) + `CREWLY_GOOGLE_SCOPES`
(OSS), then every user re-connects. They are "sensitive" (not restricted)
scopes: verification questionnaire, no CASA.

## Muse AI's list, evaluated for Crewly

Value = how much it helps a Crewly customer running agent teams. Gate = what
blocks it beyond writing code.

### Do (high value, OAuth only)

| Connector | Value | Difficulty | Gate / owner action |
|---|---|---|---|
| **Canva** | high for SteamFun (posters, short-video templates, brand kits) | **done in code (this commit)** — Cloud grant + OSS `/api/canva/*` + skills canva-designs / canva-create / canva-export / canva-upload + Settings card. OAuth 2 + PKCE; refresh tokens single-use; APIs: list/create designs, export (pdf/png/pptx/mp4, async job), asset upload, brand templates (Enterprise only) | Create integration at canva.dev (needs MFA); redirect `https://api.crewlyai.com/api/cloud/canva/callback`; scopes `design:meta:read design:content:read design:content:write asset:read asset:write folder:read`; put `CANVA_CLIENT_ID/SECRET` in `crewly-auth.env`. **Before review only the developer's own Canva account can connect** — customers need the integration to pass Canva's public review (private integrations = Canva Enterprise only). Video *generation* is not in the API: agents can fill/duplicate/export, not render from scratch. |
| **Notion** | high for enterprise KB / task sync | 1 day. Plain OAuth (no PKCE), API stable (pages, databases, search) | Public integration needs Notion review for other workspaces; internal integration works instantly for one workspace via a token |
| **Google Contacts / Tasks / Forms** | medium | ½ day each — same grant, add scopes (`contacts.readonly`, `tasks`, `forms.body.readonly` + `forms.responses.readonly`) | Console scope add + re-consent |
| **Calendly** | medium (sales teams) | ½ day, plain OAuth, tiny API | App registration only |

### Later (value ok, gate heavy)

| Connector | Difficulty | Gate |
|---|---|---|
| **Outlook Mail / Calendar / Contacts** (Microsoft Graph) | 2 days for all three (one grant) | Azure app registration (multi-tenant), publisher verification for external tenants; admin consent in many orgs |
| **Instagram Messages / Messenger / Threads / Facebook** (Meta) | 2–3 days | Meta App Review + Business Verification for `instagram_manage_messages`, `pages_messaging`; weeks; DM automation policy limits (24 h window). Posting is partly covered by the `social-media-post` marketplace skill already |
| **Granola** | — | No public API today (export only) — skip |

### Skip for Crewly (consumer / no product fit)

Peloton, Philips Hue, Spotify, Withings, Function Health, HealthEx, Tessie,
OpenTable, Printify, Plaid (finance = compliance + liability), Tailscale
(infra, API key — only if we do machine management), Bluetooth.

### Not connectors at all

Calendar / Contacts / Reminders / Health / Home in Muse are **iOS on-device
permissions** of their app. For Crewly they belong to the mobile app
(`crewly-projects/mobile`, Expo: `expo-contacts`, `expo-calendar`) and would
sync through the relay — a mobile feature, not a Cloud connector.

## Where connectors live in the UI (as of 1.20.32)

`/connections` (sidebar → TOOLS, next to Marketplace) is the one page for
every external account, in two sections:

- **Messaging** — Slack, WhatsApp, Discord, Telegram, Google Chat
- **Data & content** — Google Workspace, Canva

They are the same kind of object (external account + credential +
connect/disconnect), so they sit together; splitting them by history
("Slack is in Settings, Canva is elsewhere") only made the owner guess.

- `Settings → Integrations` redirects to `/connections`, carrying the query
  string, so every stored OAuth return URL keeps working — including the
  legacy `?tab=slack` the Cloud Slack install still sends.
- **Marketplace** keeps its meaning: things you *install* (skills, roles,
  MCP tools, models). Its **Connectors** tab is discovery only — a
  connector is authorised, not installed, so the card links to
  `/connections?platform=<id>` instead of offering Install.
- Each data connector card carries a **role allowlist** ("which agents may
  use this"). A grant is instance-wide, so the default (no allowlist) means
  every agent; picking roles narrows it. Enforced by
  `requireConnectorAccess` on the Google / Canva data routes, which reads
  `X-Agent-Session`; the owner's own calls are never gated, and `orchestrator`
  is a role like any other, so even the orc can be kept out. Stored in
  `<CREWLY_HOME>/connector-access.json`.

Catalog lives in `frontend/src/config/connectors.ts` (used by both the page
and the Marketplace tab) and `GATED_CONNECTORS` in
`backend/src/services/connector/connector-access.service.ts` — keep the ids
in step.

## Recipe: adding a connector (files to touch)

1. **Cloud** `services/auth/src/deps.ts` — `<VENDOR>_CONSTANTS` (auth/token URLs, env client id/secret, callback, scopes), state + grant document types, collection names.
2. `services/auth/src/mongodb.service.ts` — accessors + indexes (state TTL, grant unique per account).
3. `services/auth/src/<vendor>.service.ts` — `beginConnect / consumeState / completeConnect / status / getAccessToken (single-flight refresh) / disconnect`; copy `google-workspace.service.ts` `GoogleWorkspaceGrantService`.
4. `services/auth/src/<vendor>.controller.ts` + routes in `auth.routes.ts` (`/start` with `requireAuthOrQueryToken`, `/callback` public, `/status` `/token` `DELETE` with `requireAuth`).
5. **OSS** `backend/src/constants.ts` — `<VENDOR>_CONSTANTS` (Cloud path, API bases, caps, error codes).
6. `backend/src/services/<vendor>/<vendor>-token.service.ts` (copy `google-workspace-token.service.ts`) + `<vendor>.service.ts` (API calls) + tests.
7. `backend/src/controllers/<vendor>/` controller + routes; mount in `backend/src/routes/api.routes.ts`.
8. `config/skills/agent/core/<vendor>-<verb>/` — `SKILL.md`, `execute.sh` (use `call`/`api_call`; **never name a flag `--file`**, the runner reserves it), `execute.test.sh` (python stub).
9. `frontend/src/components/Settings/<Vendor>Tab.tsx`, then add the connector to `frontend/src/config/connectors.ts` and its panel/icon to `frontend/src/pages/Connections.tsx`; add the id to `GATED_CONNECTORS` and put `requireConnectorAccess('<id>')` in front of the data routes.
10. Deploy: auth image (`services/auth`, surgical compose tag on both nodes), crewly npm release, env vars on `crewly-auth.env`.

## Recommended order

1. Ship the Google extension (release + enable APIs) — done in code.
2. Canva — done in code. Owner: create the integration at canva.dev, add
   `CANVA_CLIENT_ID` / `CANVA_CLIENT_SECRET` to `crewly-auth.env` on both
   nodes, then submit for public review (the long pole). Until the env is
   set, Connect answers `not_configured` (503) and the card explains it.
3. Notion.
4. Google Contacts/Tasks/Forms + the three edit scopes in one re-consent.
5. Outlook when an enterprise customer asks.
