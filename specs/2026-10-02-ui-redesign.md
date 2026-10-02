# UI redesign (2026-10-02)

The owner approved a restructure and simplification of the web UI on one
condition: **every feature that exists today still exists**. Simplifying means
moving things behind a click (a tab, a "⋯" menu, "Show all", a collapsed "More"
or "Advanced" section, a detail page), never deleting them. Anything that
genuinely cannot be kept is flagged to the owner, never dropped silently.

The design sources (Claude Design artboards) are `plan/IA` (one row per old
page), `current/*` (the 1:1 recreation of today's UI, used as the parity
checklist), `new/*` (every page restructured) and `simple/*` (the approved
target density). This spec records the decisions the code follows.

Delivery is in phases. **Phase 0 (this spec's first PR)** builds the shared
pieces: tokens, navigation, routes and redirects, the component kit, the system
status bar. Page work (Dashboard, Chat, Tickets, Teams, Settings, …) follows in
separate PRs that start from it.

## 1. Information architecture

The sidebar goes from 17 items to 12:

| Group | Items |
|---|---|
| WORK | Dashboard · Chat · Tickets · Projects · Teams · Wiki |
| TOOLS | Schedules · Browser · Marketplace · Connections |
| SYSTEM | Usage · Settings |

Where the removed items went:

| Old page | Now |
|---|---|
| Requests (`/tasks`) | Tickets › Requests tab |
| Work Items (`/workitems`) | Tickets › Runs tab (detail page unchanged) |
| Missions (`/missions`) | Teams › Goals tab; each team page shows its own goals |
| Cloud Portal (`/cloud`) | Settings › Cloud & devices |
| Security (`/security`) | Settings › Security (mock-data cards hidden or marked) |
| Settings › Skills | Marketplace › Installed |
| Settings › Integrations | dropped (it only pointed at Connections) |
| Settings › System › token usage | Usage (rebuilt on the token stats) |
| `/monitoring/costs` ($ dashboard) | Usage |

Project › Tasks becomes the Tickets board filtered to that project. The
project sub-nav (Detail / Editor / Tasks / Teams) that today sits under
Projects in the sidebar moves into the project page header as tabs; until
the Projects page work lands it stays in the sidebar.

Badges: Dashboard shows the number of open decisions ("waiting on you") in the
attention colour; Chat shows conversations with unread messages; Schedules
keeps its active count. Pinned favourites, Mobile Access, collapse, the
version line with the "Update available" chip and the cloud sign-in indicator
stay in the sidebar.

## 2. Routes

Top-level paths (`frontend/src/constants/routes.constants.ts`, `ROUTES`):

| Page | Path | Tabs (`?tab=`, first = default, omitted from the URL) |
|---|---|---|
| Dashboard | `/` | |
| Chat | `/team-chat` | |
| Tickets | `/tickets` | `board` · `requests` · `runs` |
| Projects | `/projects`, `/projects/:id` | (project tabs: later) |
| Teams | `/teams`, `/teams/:id` | `teams` · `goals` |
| Wiki | `/wiki` | |
| Schedules | `/triggers` | |
| Browser | `/browser` | |
| Marketplace | `/marketplace`, `/marketplace/:id` | `browse` · `installed` |
| Connections | `/connections` (`?platform=` opens a card) | |
| Usage | `/usage` | |
| Settings | `/settings` | `general` · `runtimes` · `roles` · `api-keys` · `credentials` · `cloud` · `security` · `system` |

Detail pages live under their new home, so the sidebar highlights the right
item:

| Detail | Path | Helper |
|---|---|---|
| Request | `/tickets/requests/:id` | `LINKS.request(id)` |
| Run (work item) | `/tickets/runs/:id` | `LINKS.run(id)` |
| Goal (mission) | `/teams/goals/:id` | `LINKS.goal(id)` |

### Old URLs

Bookmarks, Slack links and decision cards point at the old URLs, so every one
redirects (`LEGACY_REDIRECTS`). The old query string and hash are carried over;
the target's own `?tab=` wins.

| Old | New |
|---|---|
| `/tasks`, `/requests` | `/tickets?tab=requests` |
| `/tasks/:id`, `/requests/:id` | `/tickets/requests/:id` |
| `/workitems` | `/tickets?tab=runs` |
| `/workitems/:id` | `/tickets/runs/:id` |
| `/missions` | `/teams?tab=goals` |
| `/missions/:id` | `/teams/goals/:id` |
| `/cloud` | `/settings?tab=cloud` |
| `/security` | `/settings?tab=security` |
| `/monitoring/costs` | `/usage` |
| `/chat`, `/agents` | `/team-chat` |
| `/settings?tab=skills` | `/marketplace?tab=installed` |
| `/settings?tab=integrations` | `/connections` |
| `/settings?tab=slack` | `/connections?platform=slack` |
| `/settings?tab=harness` | `/settings?tab=runtimes` (alias) |

`/settings?tab=cloud` used to bounce to `/cloud`; that loop is gone, the Cloud
tab is real.

### Tab convention

- A page with tabs keeps the active tab in `?tab=<id>` via
  `useTabParam(TABS, aliases?)` (`frontend/src/hooks/useTabParam.ts`), which
  returns `[tab, setTab]`. Unknown values fall back to the default tab; the
  default is left out of the URL; switching replaces the history entry and
  keeps other query parameters (filters, OAuth flags).
- Render the strip with `<UnderlineTabs idPrefix="<page>">` inside
  `<PageHeader tabs={…}>`, and the panel as
  `<div role="tabpanel" id="<page>-panel-<tab>" aria-labelledby="<page>-tab-<tab>">`.

### Interim containers

So nothing is unreachable between phases, a redirect target may render the
**old** page inside the new tab container: `pages/hubs/TicketsHub.tsx`
(Tickets / RequestsPage / WorkItems), `pages/hubs/TeamsHub.tsx` (Teams /
Missions), `pages/hubs/MarketplaceHub.tsx` (Marketplace / Settings SkillsTab)
and Settings' Cloud & devices / Security tabs (CloudPortal / SecurityOverview).
Each page PR replaces its container's panels with the redesigned page.

## 3. Tokens

`packages/ui/tokens.css` is the single source of colours, radii and fonts. The
OSS frontend imports it from `src/index.css`; `theme.css` (the Cloud portal's
Tailwind v4 entry) imports it; `dist/styles.css` inlines it.

- Colours are RGB channels (`--c-surface: 26 34 44`) plus a usable form
  (`--surface: rgb(var(--c-surface))`). Tailwind maps names onto the channels,
  so opacity modifiers keep working (`bg-primary/10`).
- Tokens: `--bg`, `--surface`, `--surface-2`, `--surface-hover`, `--border`,
  `--border-soft`, `--text`, `--text-2`, `--text-3`, `--primary`,
  `--primary-text`, `--primary-soft`, `--on-primary`, `--attention(-soft)`,
  `--success(-soft)`, `--danger(-soft)`, `--muted-dot`; radii, fonts and
  shadow are prefixed because Tailwind v4 reads `--radius-*`, `--font-*` and
  `--shadow*` on `:root` for its own utilities: `--crewly-radius-sm` (8px),
  `--crewly-radius` (16px), `--crewly-radius-lg` (24px), `--crewly-font`,
  `--crewly-font-display`, `--crewly-font-mono`, `--crewly-shadow`.
- Tailwind names (v3 preset and v4 theme): `bg-bg`, `bg-surface`,
  `bg-surface-2`, `hover:bg-surface-hover`, `border-border`,
  `border-border-soft`, `text-text`, `text-text-2`, `text-text-3`,
  `text-primary-text`, `bg-primary-soft`, `text-on-primary`,
  `text-attention` / `bg-attention-soft`, `text-success` / `bg-success-soft`,
  `text-danger` / `bg-danger-soft`, `bg-muted-dot`. Arbitrary
  `bg-[var(--surface)]` also works.
- The legacy names (`bg-background-dark`, `bg-surface-dark`,
  `text-text-primary-dark`, `text-text-secondary-dark`, `border-border-dark`,
  `primary`) resolve to the same tokens with unchanged values, so old pages
  look the same.
- Themes: the variables sit under `:root` and `[data-theme="dark"]`. A light
  theme is added by filling the (empty, documented) `[data-theme="light"]`
  block with the `--c-*` channels and setting `data-theme="light"` on `<html>`.
  Dark is the only theme for now.
- Rule for new code: every colour goes through a token. No new hex in
  components.

Pre-existing frontend variables that shared a name were reconciled: the
frontend's own `--radius-sm` (4px) / `--radius-lg` (8px) keep their values
(the theme radii are `--crewly-*`), and `Dashboard.css` reads `--color-error`
instead of `--danger`, so those screens are unchanged.

The Cloud portal vendors this package with `web/scripts/sync-crewly-ui.sh`;
since `theme.css` imports `tokens.css`, that script's `cp` line must include
`"$src/tokens.css"`.

## 4. Components (`@crewly/ui`, additive)

| Component | API | Use |
|---|---|---|
| `PageHeader` | `title`, `subtitle?`, `actions?`, `eyebrow?` (back link), `tabs?` | Every page: title 24px/800 + one-line subtitle left, actions right, tabs under it |
| `UnderlineTabs` | `tabs: {value,label,count?,attention?,icon?,disabled?}[]`, `value`, `onChange`, `idPrefix?`, `aria-label?` | The one tab style; counts as pills (attention-coloured when flagged) |
| `OverflowMenu` | existing props + `label?`, `defaultOpen?`; items gain `icon?`, `disabled?`, `separator?` | "⋯" (pass `icon={MoreHorizontal}`); secondary actions |
| `CompactRow` | `primary`, `meta?`, `leading?`, `trailing?`, `actions?: [a] \| [a, b]`, `overflow?: OverflowMenuItem[]`, `onClick?`, `selected?` | List rows: one 15px/600 line, one 13px meta line, ≤2 actions, the rest in ⋯ |
| `ShowAll` | `children`, `limit=5`, `total?`, `onShowAll?`, `showAllLabel?`, `as?` | First N rows + "Show all N" |
| `CollapsibleSection` | `title`, `summary?`, `defaultOpen?`, `open?`/`onOpenChange?`, `unmountWhenClosed?` | "More" / "Advanced" |
| `StatusLabel` + `statusTone()` | `tone: success\|attention\|danger\|neutral\|primary`, `children`, `pulse?`, `size?` | Status = colour + word |
| `FilterButton` | `groups: {id,label,options,single?}[]`, `value: Record<id,string[]>`, `onChange`, `showChips?` | One Filter popover, active filters as removable chips |
| `SystemStatusBar` | `items: {id,tone,title,message?,actions?,onDismiss?,icon?}[]` | One line, only when something is wrong; most severe first, others behind "+N more" |

Existing component APIs and visuals are unchanged (the Cloud portal vendors
this package). The design-sync previews for each new component are in
`packages/ui/.design-sync/previews/`.

## 5. System status bar

`AppLayout` renders one `AppStatusBar` above the page instead of three stacked
banners. Sources, each keeping its wording, actions and dismiss:

| Item | Source | Tone | Actions |
|---|---|---|---|
| Orchestrator not running / initializing | `useOrchestratorStatus` | danger / attention | Refresh status, dismiss |
| N agents need you to sign in | `GET /api/oauth/pending` + harness re-check | attention | per-session "Sign-in needed" chip (URL, code, in-place sign-in), dismiss until the set changes |
| Runtime out of usage | `GET /api/system/runtime-fallback` (60 s poll) | attention | "Runtimes" link (`/settings?tab=runtimes`), dismiss until the set changes |
| Update available | `/health` | primary | "Upgrade in Settings → System" link, dismiss |

`OrchestratorStatusBanner`, `PendingLoginsBanner` and `UpdateBanner` remain as
components (each now renders its single item through `SystemStatusBar`) and
export the hooks `AppStatusBar` uses.

## 6. Phone

Below `md` there is no sidebar and no hamburger. A fixed bottom tab bar shows
**Dashboard · Chat · Tickets · More** with the same badges (Dashboard in the
attention colour, Chat unread). "More" opens a bottom sheet with every other
page (grouped Work / Tools / System, one-line hint each), the pinned
favourites, Mobile Access (QR code), the cloud sign-in indicator and the
version with the "Update available" chip. The sheet closes on navigation,
its close button, the backdrop or Escape. Page content is padded by the bar's
height (64 px + safe-area inset); the terminal button sits above the bar.

## 7. Chat unread

The backend keeps no read state. The badge counts conversations whose
`lastMessageAt` (from `GET /api/chat/channels`) is newer than the time the
owner last had Chat open, stored per browser in localStorage
(`crewly.chat.seen`). The Chat page can refine it per conversation with
`markChatSeen(channelId)`.
