# UI redesign: tools pages (2026-10-02)

Page work under `specs/2026-10-02-ui-redesign.md` for Wiki, Schedules,
Browser, Marketplace (Browse / Installed / Submissions + item detail) and
Connections, at the approved "simple" density. Nothing is removed: every
old action and piece of information moved behind a click at most.

## Shared rules applied

- `PageHeader` (title + one-line subtitle, actions right, `UnderlineTabs`
  under it). Tabs live in `?tab=` via `useTabParam`.
- Lists are `CompactRow`s inside one surface: one 15px line, one quiet 13px
  meta line, at most two visible actions, everything else in "⋯". About five
  rows, then `ShowAll` ("Show all N").
- Filters sit behind one `FilterButton`; active filters show as removable
  chips. A search box stays only where people search often (Wiki,
  Marketplace, Installed).
- Status is a `StatusLabel` (colour + word) and only when it matters.
- No ids, cron strings, version numbers or raw timestamps on rows; those
  are in detail views (drawer, row expansion, detail page).
- Colours go through tokens (`text-text-2`, `bg-surface`, …). `Wiki.css`
  now reads the token variables (`--text`, `--border`, `rgb(var(--c-primary) / a)`).

## Pages

| Page | Job | Where things moved |
|---|---|---|
| Schedules (`/triggers`) | "What runs on a timer, and is anything about to stop?" | Tabs Schedules · Reminders · History in `?tab=` (`SCHEDULES_TABS`). Row: name; schedule in words · who · next run. Pause/Resume visible; Open details, Cancel schedule, Delete (finished triggers) in ⋯. Run counts, projected end, raw cron, ids, created-by and full description stay in the detail drawer. A row says "Expiring soon — renew", "Last run failed" or "Paused" only when true. Team and "System tasks" filters are behind Filter; the "N system tasks hidden · Show them" hint stays. History is paged 20 at a time (the extra collapse step is gone: it is its own tab). |
| Browser (`/browser`) | "What is each agent doing in Chrome?" | Header shows the live count. Each session: name + status word, last action · host, goal; Take control / Give control back and Stop on the row; the live picture, owner controls, pending-approval card and privacy note when opened. |
| Marketplace (`/marketplace`) | "Find, install and manage skills and tools" | Tabs Browse · Installed · Submissions (`MARKETPLACE_TABS` gains `submissions`). Browse: search, Filter (Type incl. Connectors, Sort), refresh. Row: name; type · author · description; Installed / Update available as a word; Install, Uninstall, or Update + Remove; View details in ⋯; the row opens `/marketplace/:id`. Version, rating, installs, licence, date, tags and README are on the detail page. |
| Marketplace › Installed | "Which skills do my agents have, and are they on?" | Former Settings › Skills (`components/Marketplace/InstalledSkills`). Search, Filter (Category), refresh, New Skill. Row: name; category · built-in/custom; enable switch (custom skills — built-in skills cannot be changed by the backend) and Edit; Delete in ⋯. A row opens to its description and setup notices (with links). Browser Automation settings are a collapsed section with an "On · headless" summary. |
| Marketplace › Submissions | "What is waiting for my review?" | Pending count as an attention tab pill. Row: name; author · category · relative time; status word; Approve / Reject on pending ones. A row opens to description, version, exact time and review notes. CLI hint kept. |
| Connections (`/connections`) | "What is connected, and set one up" | Two groups, each one surface of rows (icon, name, description, role-count when restricted). A row expands to the connector's own panel and, for data connectors, the role allowlist. `?platform=` still opens a card. |
| Wiki (`/wiki`) | "Find and read what the agents know" | Header: title, one-line subtitle (the "writes go through the agent flow" note is its tooltip), search (unchanged). Import banner is one line (Preview / Migrate now / dismiss); the per-type breakdown, already-migrated count and bootstrap note are in Preview. Vaults are grouped Global / Projects / Teams with page counts; queue backlog is quiet text. Install SOP stays visible; New SOP / New team norm are in ⋯. Page meta reads "edited 2 h ago" (size and exact time in its tooltip). Missing concepts and Recently updated show five, then Show all. On phones the three panes stack. |

## Code moves

- `components/Settings/SkillsTab.tsx` → `components/Marketplace/InstalledSkills.tsx`
  (`SkillsTab.tsx` remains a deprecated re-export).
- Skill editor + delete confirmation → `components/Marketplace/SkillEditorModal.tsx`.
- Browser Automation card → `components/Marketplace/BrowserAutomationSettings.tsx`.
- `pages/Marketplace.tsx` renders a panel (`view="browse" | "submissions"`);
  `pages/hubs/MarketplaceHub.tsx` owns the header and tabs.
