# Feature map — the Crewly dashboard (`frontend/`)

What an agent needs to act on a bug report that is a screenshot and one
sentence: which feature the screenshot shows, how a user reaches it, what
it is supposed to do, which DOM anchors to drive it by, which backend calls
feed it, and which files own it (#811, `specs/2026-10-26-feature-map.md`).

The route tables below are checked against the router by
`src/utils/feature-map.test.ts`: a route added to or removed from
`src/App.tsx` or `LEGACY_REDIRECTS` without a matching row here fails the
frontend tests. Everything else is prose; keep it short and current.

Conventions: the sidebar has 12 items (`src/components/Layout/nav-items.ts`,
groups WORK / TOOLS / SYSTEM); pages with tabs keep the tab in `?tab=<id>`
(`src/constants/routes.constants.ts`, the first tab is the default and is
left out of the URL); every page is wrapped by `AppLayout`
(`src/components/Layout/AppLayout.tsx`) which draws the sidebar, the phone
tab bar and the app-wide status bar; the backend is `backend/src/` and
every call below is relative to the same origin (`/api/...`). Element
anchors are `data-testid` values; `${...}` marks a per-item id.

## Routes

| Route | Page | Reached from | One job |
| --- | --- | --- | --- |
| `/` | `src/pages/Dashboard.tsx` | sidebar Dashboard; app start | What needs me, and is my crew OK |
| `/team-chat` | `src/components/Chat-team/TeamChatRoute.tsx` | sidebar Chat; `/teams` row › chat (`?team=<id>`) | Orchestrator, agent DMs and team channels in one Slack-like shell |
| `/tickets` | `src/pages/hubs/TicketsHub.tsx` | sidebar Tickets | Board · Requests · Runs · Experiments tabs |
| `/tickets/requests/:id` | `src/pages/RequestDetail.tsx` | Tickets › Requests row; decision cards | One request: progress, its runs, timeline |
| `/tickets/runs/:id` | `src/pages/WorkItemDetail.tsx` | Tickets › Runs row; request page | One run (work item): metrics, timeline, ticket acceptance |
| `/tickets/experiments/:id` | `src/pages/ExperimentDetail.tsx` | Tickets › Experiments row | One experiment card and its run timeline |
| `/tickets/traces/:traceId` | `src/pages/TraceDetail.tsx` | links in retros, cards and chat | Any run trace's timeline |
| `/projects` | `src/pages/Projects.tsx` | sidebar Projects | Which projects exist and how far along each is |
| `/projects/:id` | `src/pages/ProjectDetail.tsx` | Projects row | One project: Detail · Editor · Tasks · Teams · Autopilot tabs |
| `/teams` | `src/pages/hubs/TeamsHub.tsx` | sidebar Teams | Teams · Goals tabs |
| `/teams/:id` | `src/pages/TeamDetail.tsx` | Teams row | One team: members, hierarchy, start/stop, feed |
| `/teams/goals/:id` | `src/pages/MissionDetail.tsx` | Teams › Goals row | One goal (OKR): objective, key results, proposals |
| `/wiki` | `src/pages/Wiki.tsx` | sidebar Wiki; `/teams` row › wiki | Browse and edit the vaults (global / team / project) |
| `/triggers` | `src/pages/Triggers.tsx` | sidebar Schedules | Scheduled work: schedules and cron tasks by team |
| `/browser` | `src/pages/BrowserView.tsx` | sidebar Browser | Watch or take over agent browsing |
| `/marketplace` | `src/pages/hubs/MarketplaceHub.tsx` | sidebar Marketplace | Browse · Installed · Submissions tabs |
| `/marketplace/:id` | `src/pages/MarketplaceDetail.tsx` | Marketplace row | One registry item: README, install / uninstall |
| `/connections` | `src/pages/Connections.tsx` | sidebar Connections | Every account this instance is connected to |
| `/usage` | `src/pages/Usage.tsx` | sidebar Usage | Tokens by team, agent and runtime; daily caps |
| `/settings` | `src/pages/Settings.tsx` | sidebar Settings | General · Runtimes · Roles · People · API keys · Credentials · Cloud · Security · System · Activity |
| `/pricing` | `src/pages/Pricing.tsx` | Settings › Cloud "Upgrade" | Plans and checkout (Cloud) |
| `/setup` | `src/pages/Setup.tsx` | first run (`SetupRedirectGuard`); no sidebar | Install and sign in to the orchestrator's runtime, pick a bundle, send the first task |
| `/auth` | `src/pages/Auth.tsx` | Cloud sign-in links; no sidebar | Sign in to Crewly Cloud (Google or magic link) |
| `/auth/callback` | `src/pages/AuthCallback.tsx` | Cloud OAuth return; no sidebar | Finish the Cloud sign-in and connect this instance |
| `/factory` | `src/pages/Factory.tsx` | Dashboard menu | 3D view of the agents at work (not in the sidebar) |
| `/assignments` | `src/pages/Assignments.tsx` | direct URL only | Older assignments list (not in the sidebar) |
| `/scheduled-checkins` | `src/pages/ScheduledCheckins.tsx` | direct URL only | Older automations page (not in the sidebar; `/triggers` replaced it) |

## Old URLs

`LEGACY_REDIRECTS` in `src/constants/routes.constants.ts` sends bookmarks,
Slack links and decision cards to the new home. `/cloud` and `/security`
keep their query string (OAuth returns).

| Old URL | Goes to |
| --- | --- |
| `/tasks` | `/tickets?tab=requests` |
| `/tasks/:id` | `/tickets/requests/:id` |
| `/requests` | `/tickets?tab=requests` |
| `/requests/:id` | `/tickets/requests/:id` |
| `/workitems` | `/tickets?tab=runs` |
| `/workitems/:id` | `/tickets/runs/:id` |
| `/missions` | `/teams?tab=goals` |
| `/missions/:id` | `/teams/goals/:id` |
| `/cloud` | `/settings?tab=cloud` |
| `/security` | `/settings?tab=security` |
| `/monitoring/costs` | `/usage` |
| `/chat` | `/team-chat` |
| `/agents` | `/team-chat` |

## Features

### Dashboard (`/`)

- **Reach**: sidebar › Dashboard; the app opens here. Problems (orchestrator down, sign-in needed, runtime out of usage, update) are shown once by the status bar above every page (`src/components/Layout/AppStatusBar.tsx`), not repeated here.
- **Expected**: a "needs you" list first, then the running work and the crew's state. Empty states say so; nothing spins forever.
- **Elements**: `dashboard`; the status bar's chips (`SignInNeededChip`, `OrchestratorStatusBanner`, `UpdateAvailableBanner`, `PendingLoginsBanner`).
- **Backend**: `GET /api/teams`, `GET /api/task-pool/items?status=running`, `GET /api/decisions` (via `src/services/decisions.service.ts`).
- **Source**: `src/pages/Dashboard.tsx`, `src/components/Dashboard/`, `src/components/Layout/`.

### Chat (`/team-chat`)

- **Reach**: sidebar › Chat (unread badge); a team row's "chat" opens the team channel (`?team=<id>`).
- **Expected**: three panels (conversation list, thread, detail). The orchestrator DM is always present. Messages arrive live over the WebSocket; sending shows a placeholder until the agent answers. Threads open on the right; Slack-bridged conversations are read-only mirrors with a hint.
- **Elements**: see `src/components/Chat-team/` (`team-chat-*` ids) and `packages/chat-ui/` (shared message list / composer).
- **Backend**: `GET /api/chat/channels`, `POST /api/chat/channels/dm/ensure`, `POST /api/chat/channels/team/ensure`, `GET/POST /api/chat/channels/:id/messages`, `GET /api/chat/search`, WebSocket `chat:*` events (`src/services/websocket.service.ts`).
- **Source**: `src/components/Chat-team/`, `packages/chat-ui/`, `src/services/chat.service.ts`, `src/services/channels.service.ts`; backend `backend/src/controllers/chat/`, `backend/src/services/chat-v2/`.

### Tickets hub (`/tickets`, tabs `board` · `requests` · `runs` · `experiments`)

- **Reach**: sidebar › Tickets. "New ticket" sits in the page header on the Board tab.
- **Expected**: Board = the project tickets as kanban columns with a search box (`TicketBoard`, also used by Projects › Tasks); a card opens a drawer with acceptance criteria and an accept / send-back form. Requests = one compact row per owner request with status as colour + word and a Filter button (Active by default). Runs = one row per work item. Experiments = one row per experiment card with its verdict once measured.
- **Elements**: `tickets-panel-${tab}`, `tickets-page`, `tickets-board`, `tickets-search`, `tickets-new-ticket`, `tickets-column-${col}`, `ticket-card-${key}`, `ticket-detail-drawer`, `ticket-acceptance`, `ticket-acceptance-item`, `ticket-reject-form`, `ticket-action-error`.
- **Backend**: `GET /api/project-tickets`, `GET /api/tickets`, `GET /api/requests`, `GET /api/task-pool/items`, `GET /api/experiments`.
- **Source**: `src/pages/hubs/TicketsHub.tsx`, `src/pages/Tickets.tsx`, `src/pages/RequestsPage.tsx`, `src/pages/WorkItems.tsx`, `src/pages/Experiments.tsx`, `src/components/Tickets/`, `src/services/{project-tickets,tickets,experiments}.service.ts`.

### Request detail (`/tickets/requests/:id`, tabs `overview` · `timeline`)

- **Reach**: a Requests row; decision cards in chat link here.
- **Expected**: header with status and "now with" (the agent that holds it), a progress rail, the request's runs (each with a detail link and a timeline link), and stats. The Timeline tab shows the run trace grouped by stage. Loading / error / not-found states each have their own element.
- **Elements**: `request-detail`, `request-detail-header`, `request-progress-rail`, `request-now-with`, `request-action-area`, `request-detail-workitems`, `request-workitem-${id}`, `request-workitem-detail-link-${id}`, `request-workitem-timeline-${id}`, `request-panel-overview`, `request-panel-timeline`, `request-detail-loading|error|not-found`, `request-detail-back`, `request-detail-refresh`.
- **Backend**: `GET /api/requests/:id`, `GET /api/decisions`, `GET /api/traces/:id` (`src/services/traces.service.ts`).
- **Source**: `src/pages/RequestDetail.tsx`, `src/components/RequestTracking/`, `src/components/TraceTimeline/`.

### Run detail (`/tickets/runs/:id`)

- **Reach**: a Runs row; the request page's run links.
- **Expected**: the work item's header, metrics strip, timeline, and the acceptance criteria of its ticket with each self-check result.
- **Elements**: `workitem-detail`, `workitem-detail-header`, `workitem-metrics`, `workitem-timeline`, `timeline-empty`, `workitem-detail-loading|error|not-found`, `workitem-detail-back`, `workitem-detail-refresh`.
- **Backend**: `GET /api/task-pool/items/:id`, `GET /api/traces/:id`.
- **Source**: `src/pages/WorkItemDetail.tsx`, `src/components/WorkItemDetail/`.

### Experiment detail (`/tickets/experiments/:id`, tabs `overview` · `timeline`) and trace detail (`/tickets/traces/:traceId`)

- **Reach**: an Experiments row; retro pages and the autopilot tab link to traces directly.
- **Expected**: the card (hypothesis, metric, baseline → result, verdict), its autopilot numbers when the card belongs to an autopilot run, and the run timeline: grouped trace events with a metrics strip and an outcome line. A trace page is the timeline alone.
- **Elements**: `experiment-detail`, `experiment-results`, `experiment-card-log`, `experiment-autopilot`, `experiment-panel-overview|timeline`, `trace-detail`, `trace-timeline`, `trace-group-${id}`, `trace-group-row-${id}`, `trace-group-events-${id}`, `trace-event`, `trace-metrics-strip`, `trace-metric-${id}`, `trace-outcome`, `trace-timeline-loading|none|error`.
- **Backend**: `GET /api/experiments/:id`, `GET /api/traces/:id`.
- **Source**: `src/pages/ExperimentDetail.tsx`, `src/pages/TraceDetail.tsx`, `src/components/TraceTimeline/`.

### Projects (`/projects`)

- **Reach**: sidebar › Projects.
- **Expected**: compact rows (name · "N of M tasks done · team · updated" · status), one Filter button and a search box; completed projects in a collapsed section; pin / archive in each row's "⋯". A "generate tasks" call to action appears when a project has none.
- **Elements**: `projects-toolbar`, `projects-list`, `projects-show-all`, `archived-section`, `archived-grid`, `generate-tasks-cta`.
- **Backend**: `GET /api/projects`, `GET /api/projects/:id/stats`.
- **Source**: `src/pages/Projects.tsx`, `src/components/Projects/`.

### Project detail (`/projects/:id`, tabs `detail` · `editor` · `tasks` · `teams` · `autopilot`)

- **Reach**: a Projects row. Old hash links (`#tasks`) map to the tab.
- **Expected**: header with name and folder path; Detail = metrics, specs and alignment; Editor = the project's files in a markdown editor; Tasks = the project's ticket board; Teams = the teams working on it; Autopilot = the day bars and headline of the ticket autopilot with its settings.
- **Elements**: `project-header`, `project-path`, `project-detail-view`, `project-metrics`, `project-teams-view`, `project-team-${id}`, `project-tasks-tab`, `project-task-flow`, `autopilot-tab`, `autopilot-headline`, `autopilot-day-bars`, `autopilot-bar-${day}`.
- **Backend**: `GET/PUT /api/projects/:id`, `GET /api/projects/:id/files`, `GET /api/projects/:id/file-content`, `GET /api/projects/:id/specs`, `POST /api/projects/:id/create-spec-file`, `GET /api/projects/:id/alignment-status`, `POST /api/projects/:id/open-finder`, `GET /api/projects/:id/stats`, `GET /api/build-specs/config`, `POST /api/build-specs/retry-step`, `GET /api/directories`, `POST /api/orchestrator/execute`, `/api/project-tickets/*` (board), `src/services/autopilot.service.ts`.
- **Source**: `src/pages/ProjectDetail.tsx`, `src/components/ProjectDetail/`, `src/components/MarkdownEditor/`, `src/components/Tickets/TicketBoard.tsx`.

### Teams hub (`/teams`, tabs `teams` · `goals`)

- **Reach**: sidebar › Teams. "New team" / "New goal" in the header (`?create=1` opens the goal form).
- **Expected**: Teams = compact rows (name · project · members · last activity · status) with Start / Stop visible and view / edit / chat / wiki / export / pin / delete in "⋯"; a tree view shows parent / sub-teams. Goals = one row per goal nested company → team → project; proposals show Approve / Reject inline.
- **Elements**: `teams-panel-${tab}`, `teams-new`, `missions-new`; rows in `src/pages/Teams.tsx` and `src/pages/Missions.tsx`.
- **Backend**: `GET /api/teams`, `POST /api/teams/:id/start|stop`, `GET /api/missions`, `POST /api/missions/:id/approve|reject`, `src/services/team-export.service.ts`.
- **Source**: `src/pages/hubs/TeamsHub.tsx`, `src/pages/Teams.tsx`, `src/pages/Missions.tsx`, `src/components/Missions/`, `src/components/StartTeamModal.tsx`.

### Team detail (`/teams/:id`)

- **Reach**: a Teams row.
- **Expected**: members with their status and a per-member start / stop / runtime switch, the lead, sub-teams, a hierarchy view (tree or flat; config mode picks leaders), the project link, and the execution feed (live over the WebSocket, clearable). "⋯" holds edit / export / delete.
- **Elements**: `team-members`, `team-project`, `team-more`, `sub-team-${id}`, `hierarchy-view`, `hierarchy-dashboard`, `hierarchy-mode-config`, `leader-select`, `leader-toggle-${id}`, `tree-node-${id}`, `flat-member-${id}`, `task-node-${id}`, `no-leaders-message`, `stats-row`, `execution-feed`, `feed-entry`, `feed-clear`.
- **Backend**: `GET/PUT/DELETE /api/teams/:id`, `PUT /api/teams/:id/lead`, `POST /api/teams/:id/start|stop`, `/api/teams/:id/members[/:memberId[/start|stop|runtime|session]]`, `GET /api/terminal/sessions`, `POST /api/orchestrator/stop`, `GET /api/projects`, `GET /api/directories`.
- **Source**: `src/pages/TeamDetail.tsx`, `src/components/TeamDetail/`, `src/components/Hierarchy/`, `src/components/ExecutionFeed/`, `src/components/Teams/`.

### Goal detail (`/teams/goals/:id`)

- **Reach**: a Goals row; parent / child goal links.
- **Expected**: the goal's level badge, objective, status, priority, owner team, parent, cadence, strategy, success criteria and period, editable in place (Edit → form → Save / Cancel); a pending banner and the rejection reason when the goal is a proposal; learnings and "more" at the end.
- **Elements**: `mission-detail-page`, `mission-level`, `level-badge-${level}`, `mission-edit`, `mission-edit-form`, `edit-objective|status|priority|owner-team|parent|cadence|strategy|success-criteria|period-type|period-start|period-end|period-label`, `mission-save`, `mission-cancel`, `mission-save-error`, `mission-pending-banner`, `mission-rejection-reason`, `mission-parent-link`, `goal-more`, `goal-learnings`, `mission-detail-back`, `mission-detail-error`.
- **Backend**: `GET/PUT /api/missions/:id`.
- **Source**: `src/pages/MissionDetail.tsx`, `src/components/Missions/`.

### Wiki (`/wiki`)

- **Reach**: sidebar › Wiki; a team row's "wiki" opens that team's vault (`?team=<id>`).
- **Expected**: vault picker (global / team / project), file tree, page view with backlinks, search in one vault or all, recent pages, a page editor (name, content, delete) and the SOP catalog modal with per-SOP toggles. A migration panel lists pages the lint found missing and applies the move.
- **Elements**: `wiki-recent-list`, `wiki-missing-list`, `wiki-migrate-detail`, `wiki-page-editor`, `wiki-editor-name`, `wiki-editor-content`, `wiki-editor-delete`, `edit-overlay-page`, `open-sop-catalog`, `sop-catalog-modal`, `sop-row-${path}`, `sop-toggle-${path}`.
- **Backend**: `GET /api/wiki/vaults`, `GET /api/wiki/tree`, `GET /api/wiki/page`, `GET /api/wiki/backlinks`, `GET /api/wiki/recent`, `GET /api/wiki/search`, `GET /api/wiki/search-all`, `GET /api/wiki/lint`, `POST /api/wiki/migrate/scan|apply`, `PUT /api/wiki/overlay-page`, `GET /api/wiki/sop-catalog`, `POST /api/wiki/sop-catalog/:action`.
- **Source**: `src/pages/Wiki.tsx`, `src/components/Wiki/`; backend `backend/src/controllers/wiki/`, `backend/src/services/wiki/`.

### Schedules (`/triggers`)

- **Reach**: sidebar › Schedules (badge = due soon).
- **Expected**: scheduled messages and per-team cron tasks grouped by team as compact rows: a human name, the schedule in plain words, who runs it and when it runs next; a row opens its detail. Team and "system tasks" filters sit behind one Filter button; the tab lives in `?tab=`.
- **Elements**: `schedules-page`, `schedule-row`, `schedule-detail`.
- **Backend**: `src/hooks/useTriggers.ts`, `src/hooks/useCronTasks.ts` (`/api/triggers`, `/api/cron-tasks`, `/api/scheduled-messages`).
- **Source**: `src/pages/Triggers.tsx`, `src/components/Triggers/`, `src/constants/schedules.constants.ts`.

### Browser (`/browser`)

- **Reach**: sidebar › Browser.
- **Expected**: every agent that has touched Chrome, most recent first, with a live count; the first session opens by default into a live frame of the page. The owner can take control (tap ripple, zoom reset, owner controls) and hand it back; hints explain who is driving.
- **Elements**: `browser-page`, `browser-live-count`, `browser-session-card`, `browser-surface`, `frame-stage`, `frame-image`, `tap-ripple`, `reset-zoom`, `browser-owner-controls`, `take-control-hint`, `driving-hint`.
- **Backend**: `src/services/browser-session.service.ts` (`/api/browser/sessions`, `/api/browser/sessions/:id/frame|input|takeover`).
- **Source**: `src/pages/BrowserView.tsx`, `src/components/Browser/`.

### Marketplace (`/marketplace`, tabs `browse` · `installed` · `submissions`; detail `/marketplace/:id`)

- **Reach**: sidebar › Marketplace. Installed is the former Settings › Skills.
- **Expected**: Browse = registry items (skills, 3D models, roles, MCP tools) as compact rows with the install state as a word and at most two actions; Installed = the installed skills with a summary and per-skill detail; Submissions = skills submitted for review with a pending count. The detail page shows name, description, meta, README and Install / Uninstall.
- **Elements**: `marketplace-panel-${tab}`, `installed-skills`, `installed-summary`, `installed-skill-${id}`, `installed-skill-detail-${id}`, `browser-automation-settings`, `item-name`, `item-description`, `item-meta`, `readme-section`, `install-btn`, `uninstall-btn`, `back-to-marketplace`.
- **Backend**: `/api/marketplace/*` (`src/services/marketplace.service.ts`), `/api/skills/*` (`src/services/skills.service.ts`).
- **Source**: `src/pages/hubs/MarketplaceHub.tsx`, `src/pages/Marketplace.tsx`, `src/pages/MarketplaceDetail.tsx`, `src/components/Marketplace/`.

### Connections (`/connections`)

- **Reach**: sidebar › Connections.
- **Expected**: two groups — the channels you reach the orchestrator through (Slack, WhatsApp, Telegram, Discord, Google Chat) and the accounts your agents act in (Google products per account, Canva, Microsoft To Do, remote MCP servers). A card expands to that connector's connect / disconnect UI; data connectors carry the role allowlist (`connector-access-*`); a restricted card says why.
- **Elements**: `connections-page`, `connector-group-${id}`, `connector-card-${id}`, `connector-toggle-${id}`, `connector-content-${id}`, `connector-restricted-${id}`, `connector-access-${id}`, `slack-identity-groups`, `google-workspace-tab`, `google-connect-${product}`, `google-account-${email}`, `remote-mcp-panel`, `remote-mcp-empty`, `remote-mcp-server-${id}`, `remote-mcp-rename-input-${id}`.
- **Backend**: `GET /api/messengers/status`, `/api/messengers/{telegram,discord,google-chat}/connect|disconnect|status|pull|test-send`, `/api/google/status|connect-url|disconnect|default|sharing`, `/api/canva/status|connect-url|disconnect|sharing`, `/api/microsoft-todo/*`, `/api/remote-mcp/*` (`src/services/remote-mcp.service.ts`), `/api/slack/*`, `/api/whatsapp/*`.
- **Source**: `src/pages/Connections.tsx`, `src/components/Connections/`, `src/components/Settings/` (shared connector panels), `src/services/connector.service.ts`.

### Usage (`/usage`)

- **Reach**: sidebar › Usage.
- **Expected**: one headline (tokens / cost today with a Today / 7 days / 30 days switch), a meter against the daily cap with a subline, a caps section with a suggestion when something is capped, and breakdowns by model, by runtime and by team / agent. A stopped total says so.
- **Elements**: `usage-page`, `usage-headline`, `usage-meter`, `usage-subline`, `usage-cost`, `usage-note`, `usage-total-stopped`, `usage-caps`, `usage-caps-summary`, `usage-suggestion`, `usage-models`, `usage-models-list`, `usage-model-${key}`, `usage-runtimes`, `usage-runtime-${key}`, `usage-details`, `usage-split`.
- **Backend**: `GET /api/system/usage`, `GET/PUT /api/system/usage/caps`, `POST /api/system/usage/boost`.
- **Source**: `src/pages/Usage.tsx`, `src/components/Usage/`, `src/hooks/useUsage.ts`, `src/services/usage.service.ts`.

### Settings (`/settings`, tabs `general` · `runtimes` · `roles` · `people` · `api-keys` · `credentials` · `cloud` · `security` · `system` · `activity`)

- **Reach**: sidebar › Settings; `?tab=harness` is an alias of `runtimes`; `/cloud` and `/security` redirect here.
- **Expected**: one panel per tab. General (appearance, defaults); Runtimes (installed harnesses, sign-in, fallback accounts); Roles; People (who may use which connector); API keys (masked rows per provider, advanced section); Credentials (stored secrets); Cloud (sign-in, paired devices, sync state, upgrade); Security (approvals); System (backup, restart, update); Activity (the audit log with actor filters).
- **Elements**: `settings-panel-${tab}`, `api-keys-tab`, `api-key-row-${provider}`, `masked-key-hint-${id}`, `api-keys-advanced`, `credentials-tab`, `cloud-device-list-section`, `sync-state-badge`, `refresh-devices-button`, `token-expired-warning`, `upgrade-btn`, `activity-tab`, `activity-filters`, `activity-filter-actor-type`, `activity-filter-actor-id`.
- **Backend**: `/api/settings`, `/api/settings/roles`, `/api/people`, `/api/credentials`, `/api/harness`, `/api/security/approvals`, `/api/activity`, `/api/cloud/*` (`src/services/cloud-device-pairing.service.ts`), `/api/system/*` (`src/services/system-control.service.ts`), `src/services/runtime-fallback.service.ts`.
- **Source**: `src/pages/Settings.tsx`, `src/components/Settings/*Tab.tsx`.

### Pricing (`/pricing`)

- **Reach**: Settings › Cloud "Upgrade" (`upgrade-btn`); a Cloud sign-in is required.
- **Expected**: plan cards (Starter, Pro, Max) with a monthly / yearly toggle, the active plan marked, a call to action per plan that opens the Cloud checkout, and an enterprise section with "Contact sales".
- **Elements**: `plan-card-${id}`, `price-${id}`, `cta-${id}`, `enterprise-section`, `contact-sales-btn`.
- **Backend**: Cloud billing through `src/services/api.service.ts` (`AuthContext` supplies the session).
- **Source**: `src/pages/Pricing.tsx`, `src/components/PaymentWall/`.

### Setup (`/setup`) and Cloud sign-in (`/auth`, `/auth/callback`)

- **Reach**: the first run redirects here while the orchestrator's runtime is missing or signed out (`SetupRedirectGuard` in `src/App.tsx`); these pages have no sidebar.
- **Expected**: a step counter; pick and install a runtime (live install log), sign in (a login URL to open, with a paste fallback), pick a bundle (Marketing, Blank …) and watch its steps, connect Cloud (sign in or paste a token), send the first task, then "done" with the first-week checklist. `/auth` offers Google and magic-link sign-in and sends the browser to Cloud; `/auth/callback` finishes it by connecting this instance.
- **Elements**: `setup-step-counter`, `orc-harness-picker`, `harness-list`, `harness-card-${id}`, `install-log`, `harness-login-card-${id}`, `login-screen`, `login-open-url`, `login-fallback`, `copy-button`, `api-key-form`, `bundle-progress`, `bundle-step-${id}`, `bundle-connect-list`, `bundle-retry`, `cloud-connect-step`, `cloud-sign-in`, `cloud-show-paste`, `cloud-connected`, `first-task-step`, `first-task-send`, `first-task-sent`, `setup-skip`, `setup-done`, `setup-done-checklist`, `setup-bundle-first-week`; `google-signin-btn`, `email-input`, `email-signin-btn`, `benefits-list`.
- **Backend**: `/api/harness/*` (`src/hooks/useHarnessStatus.ts`), `src/services/bundle.service.ts`, `src/services/onboarding-checklist.service.ts`, `POST /api/cloud/connect`, `GET /api/cloud/google/start`, `GET /api/slack/cloud/status`.
- **Source**: `src/pages/Setup.tsx`, `src/components/Onboarding/`, `src/components/Harness/`, `src/pages/Auth.tsx`, `src/pages/AuthCallback.tsx`, `src/contexts/AuthContext.tsx`.

### Factory (`/factory`), Assignments (`/assignments`), Automations (`/scheduled-checkins`)

- **Reach**: Factory from the Dashboard menu; the other two only by URL. None is in the sidebar.
- **Expected**: Factory draws the agents at work as a 3D scene (a simplified view on phones). Assignments is the older per-agent assignment list over `/api/assignments` with live WebSocket updates. Automations is the older two-tab schedules page that `/triggers` replaced; it still works but new behaviour goes to Schedules.
- **Source**: `src/pages/Factory.tsx`, `src/components/Factory3D/`, `src/services/factory.service.ts`; `src/pages/Assignments.tsx`, `src/components/Assignments/`; `src/pages/ScheduledCheckins.tsx`, `src/components/ScheduledCheckins/`.

## Keeping it current

- A new route: add its row to **Routes** (and a section under **Features**) in the same PR, or the frontend tests fail.
- A removed or renamed route: remove or rename the row; add the old URL to `LEGACY_REDIRECTS` and to **Old URLs** when links to it may exist.
- A new `data-testid` an agent would need to drive the feature: add it to the feature's **Elements** line. Prose changes are not checked; read the page's header comment when the two disagree and fix the map.
