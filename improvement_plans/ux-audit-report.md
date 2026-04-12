# Crewly OSS UI — Full UX Audit Report

**Auditor:** Ava (UX Designer, crewly-product-ava-member-u)
**Date:** 2026-03-26
**Method:** Playwright headless browser (Chromium), desktop 1440x900 + mobile 375x812
**Target:** localhost:3456 (Vite dev server)
**Screenshots:** `/tmp/crewly-ux-audit/` (11 desktop + 2 mobile)

---

## Executive Summary

The Crewly OSS UI has a strong dark-theme foundation with a functional sidebar navigation and good information density. However, **3 critical issues** require immediate attention: two completely blank pages (Schedules, Settings/Integrations) and inconsistent data states across dashboards. Below are findings organized by page with severity ratings.

**Severity Scale:** P0 = Broken/Unusable | P1 = Major usability gap | P2 = Moderate improvement | P3 = Polish/Enhancement

---

## 1. Dashboard (`/`)

**Screenshot:** `/tmp/crewly-ux-audit/01-dashboard.png`

### Findings

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 1.1 | P1 | **"Active Projects: 0" contradiction** — Dashboard shows 13 Projects but 0 Active Projects. All projects show "Stopped" status. This feels broken even if technically accurate — users expect at least one active project when 3 agents are running. | Add a tooltip or subtitle explaining what "Active" means (e.g., "Projects with running agents"). Consider renaming to "Running Projects" for clarity. |
| 1.2 | P2 | **Stat cards lack visual hierarchy** — All 4 stat cards (Projects, Teams, Active Projects, Running Agents) use the same size, same border treatment. The most important metric (Running Agents = 3) doesn't stand out. | Use color accent or larger font for the primary metric. Consider a "hero stat" pattern where the most important number is visually dominant. |
| 1.3 | P2 | **Cloud Relay "Could not reach the server" error** — Red error banner sits below the stat cards with low contrast text. Easy to miss. | Move to a more prominent position (top banner or inline alert). Use red background with white text for visibility. Add a "Retry" button. |
| 1.4 | P2 | **"3D View / Factory" button** — Purpose unclear. Button label doesn't explain what it does. Placed prominently but feels experimental. | Add a tooltip or subtitle. If this is a beta/experimental feature, badge it as such. |
| 1.5 | P3 | **Project cards truncate paths** — Paths like `…/projects/justslash/business_os` are hard to read. Users can't tell which directory they're in. | Show full project name prominently, move path to a secondary line or tooltip. |
| 1.6 | P3 | **Team cards in bottom section** — Teams section shows team names but no useful metadata (member count, status) at a glance. | Add member count badges and active/inactive indicators to team pills. |
| 1.7 | P2 | **Terminal panel at bottom** — Shows "Disconnected" with no clear affordance to connect. Takes up vertical space even when inactive. | Auto-collapse when disconnected. Add a clear "Connect" CTA button. |

---

## 2. Teams (`/teams`)

**Screenshot:** `/tmp/crewly-ux-audit/02-teams.png`

### Findings

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 2.1 | P2 | **Inconsistent card content density** — Some cards show "Project X" and member avatars, others show "X sub-teams · Y member", and others are nearly empty. | Standardize card layout: always show project, member count, status badge, and last activity. |
| 2.2 | P2 | **Status filter chips ("All / Active / Inactive")** — Good pattern, but only "Active" appears to apply to any teams. Most cards don't show a status badge, making it unclear which are active vs inactive. | Every team card should display its status badge. Gray = inactive, Green = active. |
| 2.3 | P2 | **Project dropdown filter** — Dropdown lists 14+ projects in a long unstyled `<select>`. Hard to use with many projects. | Replace with a searchable dropdown or combobox component. |
| 2.4 | P3 | **Grid/List toggle icons** — The grid/list view toggle is present but small and has no tooltip. | Add tooltips ("Grid view" / "List view"). Remember user preference. |
| 2.5 | P3 | **Avatar images** — Some team cards show what appear to be placeholder/stock images that look like nature photos (trees, landscapes). These don't convey team identity. | Use generated team initials as default avatars (e.g., "OT" for Orchestrator Team). |
| 2.6 | P1 | **"Demo Team" and empty cards** — Several team cards have no project, no members, no status — they look abandoned. | Add an empty state within cards: "No project assigned" with an "Assign Project" action. Consider hiding teams with no activity after X days, or marking as archived. |

---

## 3. Projects (`/projects`)

**Screenshot:** `/tmp/crewly-ux-audit/03-projects.png`

### Findings

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 3.1 | P1 | **All 13 projects show "Stopped"** — Even though the Dashboard says 3 agents are running. The bright red "Stopped" badge on every card creates a sense of system failure. | Distinguish between "Stopped" (intentionally paused) and "Idle" (no agents running but healthy). Use neutral gray for idle, red only for error states. |
| 3.2 | P2 | **Progress bars misleading** — Several projects show 0% progress but have been "updated" recently (e.g., Business OS at 0% updated 2/12). Progress doesn't seem to reflect actual work done. | Either calculate progress meaningfully (tasks completed / total) or remove the progress bar. A misleading progress bar is worse than no progress bar. |
| 3.3 | P2 | **Status filter: "Active / Paused / Completed"** — But actual statuses are "Stopped" and "Completed". The filter labels don't match the data. | Align filter options with actual status values. Add "Stopped" to filters. |
| 3.4 | P3 | **Path truncation** — Same issue as Dashboard (1.5). `…/projects/crewly-projects/crewly` is not informative. | Show project name prominently, full path on hover. |
| 3.5 | P3 | **"New Project" card** at bottom — Visually blends in with project cards. Should be more clearly a CTA. | Use a dashed border card pattern with a prominent "+" icon, distinct from data cards. |
| 3.6 | P2 | **No sort options** — Cannot sort by name, date, progress, or status. With 13+ projects, finding the right one requires scrolling. | Add sort controls: Name (A-Z), Last Updated, Progress, Status. |

---

## 4. Chat (`/chat`)

**Screenshot:** `/tmp/crewly-ux-audit/04-chat.png`

### Findings

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 4.1 | P2 | **Thread list dominates left panel** — Shows many threads but with long truncated previews that are hard to scan. | Use a more compact thread list: show sender, timestamp, and first line only. Use bold for unread threads. |
| 4.2 | P2 | **Source filter tabs (All/Slack/Crewly)** — Good concept, but the numbers (50/48/2) are small and hard to read against the dark background. | Use badge-style counters with higher contrast background. |
| 4.3 | P1 | **Right panel "Chat with Orchestrator"** — Shows messages with raw file paths and thread context references that are not user-friendly. Lines like `[Thread context file: /Users/yellowsunhy/.crewly/...]` are internal system data leaking into UI. | Parse and hide thread context metadata. Show clean message text only. Optionally show "Context attached" as a small indicator users can expand. |
| 4.4 | P2 | **Message timestamps** — "3 minutes ago", "5 minutes ago" etc. are good for recent, but "Yesterday" is too vague for older messages. | Show relative time for <24h, then "Mar 25, 3:15 PM" format for older messages. |
| 4.5 | P3 | **No search functionality** visible in chat. | Add a search bar to find messages across threads. |
| 4.6 | P2 | **JWT token visible in thread list** — A thread preview shows `eyJhbGciOiJIUzI1NiI...` which is a JWT. This is a security concern — tokens should never be displayed in message previews. | Detect and mask sensitive patterns (JWTs, API keys) in message previews. Show "[Sensitive content]" instead. |

---

## 5. Marketplace (`/marketplace`)

**Screenshot:** `/tmp/crewly-ux-audit/05-marketplace.png`

### Findings

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 5.1 | P3 | **Good overall layout** — Cards are well-structured with version, description, author, rating, and install count. This is the most polished page. | Minor: consider adding skill icons/logos to differentiate cards visually. |
| 5.2 | P2 | **Rating stars not visible** — Ratings show as "4.8" text but no visual star representation. | Add star icons (filled/half/empty) for quick visual scanning. |
| 5.3 | P2 | **"Install" vs "Uninstall" buttons** — Both use similar styling. "Uninstall" should be visually distinct (e.g., outline style, red text) to prevent accidental uninstalls. | Use filled blue for Install, outline/ghost red for Uninstall. |
| 5.4 | P3 | **Category tabs ("All / Skills / 3D Models / Roles / MCP Tools")** — Good filtering. The "Popular / Highest Rated / Newest" sort is also well-placed. | Consider making the active tab more visually distinct. |
| 5.5 | P3 | **Description truncation** — Some skill descriptions are cut off mid-sentence. | Add "Read more" expansion or a hover card with full details. |

---

## 6. Schedules (`/schedules`)

**Screenshot:** `/tmp/crewly-ux-audit/06-schedules.png`

### Findings

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 6.1 | **P0** | **COMPLETELY BLANK PAGE** — The entire page renders as a dark empty screen. No sidebar, no header, no content whatsoever. The route exists in navigation but renders nothing. | **Critical fix needed.** Either: (a) implement the Schedules page with a proper empty state, or (b) hide the nav item until the feature is ready. A blank page signals a broken application. |

---

## 7. Settings (`/settings`)

**Screenshot:** `/tmp/crewly-ux-audit/07-settings.png`

### Findings

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 7.1 | P2 | **Long scrolling form** — Settings page is one long vertical scroll with many toggles and inputs. No visual grouping or section breaks. | Group settings into collapsible sections with clear headers. Use cards or horizontal dividers between groups. |
| 7.2 | P2 | **Tab navigation (General / Roles / Skills / Integrations / API Keys / Cloud / System)** — 7 tabs is a lot. Some may be empty or incomplete. | Consider progressive disclosure — show only relevant tabs, or combine related ones. |
| 7.3 | P3 | **Toggle states** — Toggle switches work but don't clearly show labels for ON/OFF states. | Add text labels ("Enabled" / "Disabled") next to toggles for accessibility. |
| 7.4 | P3 | **"Reset to Defaults" and "Save Changes" buttons** — Positioned at the bottom of a long scroll. User may not see them. | Add a sticky footer bar with Save/Reset buttons that's always visible. |
| 7.5 | P2 | **Runtime command text inputs** — Show editable CLI command strings. These are power-user settings mixed with simple toggles. | Separate "Basic" and "Advanced" settings. Move runtime commands to an "Advanced" collapsible section. |

---

## 8. Settings/Integrations (`/settings/integrations`)

**Screenshot:** `/tmp/crewly-ux-audit/08-settings-integrations.png`

### Findings

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 8.1 | **P0** | **COMPLETELY BLANK PAGE** — Same issue as Schedules. The Integrations tab under Settings renders nothing — no sidebar, no header. | **Critical fix needed.** This is a sub-route of Settings but renders blank instead of showing integration options (Slack, Telegram, GitHub, etc.) or an empty state. |

---

## 9. Security (`/security`)

**Screenshot:** `/tmp/crewly-ux-audit/11-security.png`

### Findings

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 9.1 | P3 | **Excellent page overall** — Security Overview with PTY Status, Storage, and Approvals cards is well-designed. The PTY Isolation Map and Audit Log are information-rich and useful. | This is the best-designed page in the app. Use it as the design reference for other pages. |
| 9.2 | P2 | **PTY Isolation Map cards** — Good information density but text is small. Process details (pid, mem, uptime, fs, net) may overwhelm non-technical users. | Consider a simplified view by default with an "expand details" toggle for technical info. |
| 9.3 | P3 | **Audit Log table** — Clean layout with time, agent, tool/command, and outcome columns. Color-coded outcomes (green Approved, red Denied) are effective. | Add pagination or virtual scrolling for long audit histories. |
| 9.4 | P3 | **"(no lateral access)" label** — Good security messaging, but could be more user-friendly. | Rephrase to "Isolated — no access to other agents" for clarity. |

---

## 10. Mobile — Dashboard

**Screenshot:** `/tmp/crewly-ux-audit/09-mobile-dashboard.png`

### Findings

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 10.1 | P3 | **Good responsive layout** — Hamburger menu, stacked stat cards, and proper spacing. The sidebar correctly hides on mobile. | This validates the mobile sidebar work done in previous sessions. |
| 10.2 | P2 | **Stat cards take too much vertical space** — Each card is very tall on mobile (Projects: 13 takes ~120px). User has to scroll far to reach content. | Reduce card height on mobile. Consider a 2x2 grid for stat cards even at 375px width. |
| 10.3 | P2 | **"Cloud Offline" bar** — Takes horizontal space at top but provides no actionable information on mobile. | On mobile, collapse to just an icon (cloud with X) to save space. |
| 10.4 | P3 | **Floating action button (blue circle, bottom-right)** — Good pattern for mobile quick actions, but no label or tooltip. | Add a tooltip or label on first visit to explain what it does. |

---

## 11. Mobile — Teams

**Screenshot:** `/tmp/crewly-ux-audit/10-mobile-teams.png`

### Findings

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| 11.1 | P2 | **Filter controls take too much space** — Search, Status chips, Project dropdown, and Grid/List toggle consume ~40% of the viewport before any team cards appear. | Collapse filters behind a "Filter" button on mobile. Show only the search bar by default. |
| 11.2 | P3 | **Team cards stack well** — Good single-column layout with adequate spacing. | Cards are well-adapted for mobile. |
| 11.3 | P3 | **"+ New Team" button** — Full-width green button is prominent and accessible. Good mobile CTA pattern. | Keep this pattern. |

---

## Cross-Cutting Issues

| # | Severity | Issue | Recommendation |
|---|----------|-------|----------------|
| C1 | P1 | **Navigation item "Mobile Access"** — Present in sidebar but unclear what it does. No screenshot was taken because it wasn't in the initial page list. Needs investigation. | Clarify purpose or rename. If it's a QR code pairing feature, label it "Pair Device" or "Remote Access". |
| C2 | P2 | **Terminal panel at bottom of every page** — Shows "Disconnected / Session: Orchestrator" on every page. Takes up ~100px of vertical space even when not in use. | Make collapsible and remember collapsed state. Auto-hide after 30s of no activity. |
| C3 | P2 | **"Cloud Offline" banner** — Appears on every page. For OSS users who don't use Cloud features, this is noise. | Allow dismissing. Show only on pages where Cloud connectivity matters. |
| C4 | P2 | **Sidebar "Collapse" button** — Good that it exists, but the collapsed state should show icons-only sidebar, not hide navigation entirely. | Implement an icon-only collapsed sidebar mode like VS Code or GitHub. |
| C5 | P1 | **No loading states visible** — Pages either show content or show blank. No skeleton screens, spinners, or loading indicators observed. | Add skeleton loading patterns for all data-driven pages. This is especially important for pages that fetch from APIs. |
| C6 | P3 | **Color consistency** — Most elements use the dark blue theme well, but some accent colors (green for "Active", blue for buttons, purple for "3D View") feel inconsistent. | Define a consistent accent color palette: Primary (blue), Success (green), Warning (amber), Error (red). Apply consistently. |
| C7 | P2 | **No breadcrumbs or page context** — Navigating to `/settings/integrations` shows no indication of parent context. | Add breadcrumbs for nested routes (Settings > Integrations). |

---

## Priority Summary

### P0 — Must Fix Immediately (2 issues)
1. **Schedules page completely blank** (6.1)
2. **Settings/Integrations page completely blank** (8.1)

### P1 — High Priority (5 issues)
3. Active Projects "0" contradiction on Dashboard (1.1)
4. All projects showing "Stopped" status creates panic feeling (3.1)
5. Raw system metadata leaking in Chat messages (4.3)
6. Empty team cards with no affordance (2.6)
7. No loading states across the app (C5)

### P2 — Medium Priority (17 issues)
- Stat card visual hierarchy (1.2)
- Cloud Relay error visibility (1.3)
- Terminal panel always visible (1.7, C2)
- Team card content inconsistency (2.1, 2.2)
- Project dropdown unsearchable (2.3)
- Progress bars misleading (3.2)
- Status filter mismatch (3.3)
- No sort options on Projects (3.6)
- Chat thread list density (4.1)
- JWT token visible in chat (4.6)
- Install/Uninstall button similarity (5.3)
- Settings form too long (7.1, 7.5)
- Mobile stat cards too tall (10.2)
- Mobile filters too spacious (11.1)
- Cloud Offline noise (C3)
- No breadcrumbs (C7)

### P3 — Polish (12 issues)
- Path truncation, tooltips, avatars, color consistency, and other polish items

---

## Recommended Next Steps

1. **Sprint fix:** Address P0 blank pages — either implement empty states or hide nav items
2. **Quick wins:** Fix status labels ("Stopped" → "Idle"), mask JWT in chat, add loading skeletons
3. **Design system pass:** Standardize card layouts, button styles, and spacing across all pages
4. **Security page as reference:** Use the Security page design quality as the benchmark for redesigning other pages

---

*Report generated via Playwright automated screenshots + visual analysis. All screenshots saved to `/tmp/crewly-ux-audit/`.*
