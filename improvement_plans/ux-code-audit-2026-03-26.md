# Crewly OSS UI — Code-Based UX Audit Report (Updated)

**Auditor:** Ava (UX Designer, crewly-product-ava-member-u)
**Date:** 2026-03-26
**Method:** Source code review (all pages, components, utils)
**Scope:** Dashboard, Teams, Projects, Chat, Marketplace, Settings, Security, Schedules, Navigation

---

## Executive Summary

Since the last audit, **several P0/P1 issues have been fixed**:
- Schedules page is no longer blank (full card-based UI with tabs)
- Settings/Integrations is no longer blank (5 messaging platform cards with expand/collapse)
- ProjectCard now maps "stopped" to "Idle" (neutral label instead of alarming red)
- Chat now masks JWTs, file paths, and API keys via `security.ts` utility
- All pages have loading spinners

**Remaining issues** are primarily P1-P2 consistency and UX polish items. 3 new issues identified.

**Severity Scale:** P0 = Broken/Unusable | P1 = Major usability gap | P2 = Moderate improvement | P3 = Polish/Enhancement

---

## Previous Issues — Status Update

| # | Issue | Previous Severity | Status | Notes |
|---|-------|:-:|:-:|-------|
| OLD-1 | Schedules page blank | P0 | FIXED | Full UI with tabs, cards, system checks, delivery logs |
| OLD-2 | Settings/Integrations blank | P0 | FIXED | 5 messaging platforms with expandable config panels |
| OLD-3 | All projects show "Stopped" | P1 | FIXED | `stopped` now maps to "Idle" with neutral slate color |
| OLD-4 | Chat leaks JWT tokens | P1 | FIXED | `segmentSensitiveData()` masks JWTs, paths, API keys with styled `[REDACTED]` spans |
| OLD-5 | No loading states anywhere | P2 | FIXED | Dashboard, Teams, Projects, Schedules all have loading spinners |

---

## Current Findings by Page

### 1. Dashboard (`/`)

| # | Severity | Issue | File | Recommendation |
|---|:-:|-------|------|----------------|
| 1.1 | P2 | **Avatar fallback uses picsum.photos** — External HTTP calls to `picsum.photos/seed/N/64` for team member avatars. This causes (a) external dependency for a local tool, (b) slow loading, (c) random nature photos that don't convey team identity. | `Dashboard.tsx:146-152` | Use generated initials (`member.name.charAt(0)`) as default avatars, not external URLs. The `ProjectCard` already does this as a fallback — make it the primary default. |
| 1.2 | P2 | **console.error in production** — `console.error('Error loading dashboard data:', error)` leaks to browser console. | `Dashboard.tsx:177` | Use `logSilentError()` utility (already used in Teams page) instead of raw console.error. |
| 1.3 | P3 | **No empty state for Dashboard** — If user has 0 projects and 0 teams, they see empty grids with just "Create" cards. No welcoming onboarding message. | `Dashboard.tsx:236-278` | Add an onboarding empty state when both projects and teams are empty: "Welcome to Crewly! Create your first project or team to get started." |
| 1.4 | P3 | **HealthBar "Secure" is hardcoded** — Security shield always shows green "Secure" regardless of actual security posture. | `HealthBar.tsx:149-152` | Wire to actual security data (e.g. from PTY status API). At minimum, link the shield icon to `/security` page. |
| 1.5 | P2 | **Top 2 projects only** — Dashboard shows `projects.slice(0, 2)` which is quite limiting. With 13 projects, users see very little at a glance. | `Dashboard.tsx:207` | Show top 3-4 projects (sorted by last updated) to give better overview. Or show a compact list view for >3 projects. |

### 2. Teams (`/teams`)

| # | Severity | Issue | File | Recommendation |
|---|:-:|-------|------|----------------|
| 2.1 | P2 | **window.confirm for delete** — Uses `window.confirm()` for team deletion which (a) breaks the dark theme, (b) is not customizable, (c) is inconsistent with other delete flows (Marketplace uses `ConfirmDialog`). | `Teams.tsx:395` | Use the same `ConfirmDialog` component already used in Marketplace. |
| 2.2 | P2 | **Inconsistent API usage** — Team creation uses raw `fetch('/api/teams')` while team listing uses `apiService.getTeams()`. | `Teams.tsx:171-178` | Use `apiService` consistently for all API calls. |
| 2.3 | P3 | **Project filter shows IDs** — The project dropdown uses `p.id` as value and `p.name` as label, but team matching uses `team.projectIds?.includes(projectFilter)` which matches against IDs. If IDs are UUIDs, this works, but the filter won't match teams that reference projects by name. | `Teams.tsx:78` | Ensure consistent ID-based matching (which is the correct pattern). |

### 3. Projects (`/projects`)

| # | Severity | Issue | File | Recommendation |
|---|:-:|-------|------|----------------|
| 3.1 | P2 | **Duplicate avatar migration logic** — The same `picsum.photos` avatar migration code is copy-pasted in Dashboard.tsx, Projects.tsx, and Teams.tsx. | `Projects.tsx:92-99`, `Dashboard.tsx:146-152` | Extract to a shared utility (Teams.tsx already uses `assignDefaultAvatars` from `team.utils`). Apply consistently across all pages. |
| 3.2 | P2 | **Mixed API patterns** — Uses `axios.get()` directly while other pages use `apiService`. Creates inconsistency and bypasses any centralized error handling/caching. | `Projects.tsx:48, 129` | Use `apiService.getProjects()` consistently (already used in Dashboard). |
| 3.3 | P2 | **Status filter mismatch** — Filter options are "Active / Paused / Completed" but actual project statuses include "stopped". The `statusColors` map handles it (maps to "Idle") but the filter won't catch stopped projects under any option. | `Projects.tsx:200-207` | Add "Idle" (for stopped) to filter options. Or better: filter by semantic status groups. |
| 3.4 | P3 | **No sort controls** — 13+ projects with no ability to sort by name, date, progress, or status. | `Projects.tsx` | Add sort dropdown matching the Marketplace pattern. |

### 4. Chat (`/chat`)

| # | Severity | Issue | File | Recommendation |
|---|:-:|-------|------|----------------|
| 4.1 | P3 | **Raw output toggle shows unmasked data** — The "Show raw output" toggle (`showRaw` state) displays `message.metadata.rawOutput` without applying `segmentSensitiveData()`. JWTs and paths could leak through raw view. | `ChatMessage.tsx:181-186` | Apply masking to raw output as well, or add a warning label: "Raw output may contain sensitive data." |
| 4.2 | P3 | **Thread list preview not masked** — The `segmentSensitiveData` masking is only applied in `ChatMessage` component. Thread list previews in `ThreadListPanel` may still show unmasked content. | `ThreadListPanel.tsx` (needs verification) | Apply `maskSensitiveData()` to thread preview text in the thread list. |
| 4.3 | P3 | **No chat search** — No way to search across messages or threads. | `Chat.tsx` | Add search bar to ThreadListPanel for filtering threads. |

### 5. Marketplace (`/marketplace`)

| # | Severity | Issue | File | Recommendation |
|---|:-:|-------|------|----------------|
| 5.1 | **GOOD** | **Well-structured page** — Clean tabs, search, sort, install/uninstall with confirmation dialog, toast notifications. Best page in the app. | — | Use as reference pattern for other pages. |
| 5.2 | P3 | **No detail/expand view** — Clicking a card doesn't show more details. Descriptions are truncated to 2 lines (`line-clamp-2`). | `Marketplace.tsx:355` | Add click-to-expand or a detail modal/page for items. |
| 5.3 | P2 | **Hardcoded gray colors** — Uses `bg-gray-900`, `text-gray-400`, `border-gray-800` etc. instead of theme tokens (`bg-surface-dark`, `text-text-secondary-dark`). | `Marketplace.tsx` (throughout) | Migrate to design tokens for theme consistency. Currently breaks if theme changes. |

### 6. Settings (`/settings`)

| # | Severity | Issue | File | Recommendation |
|---|:-:|-------|------|----------------|
| 6.1 | **GOOD** | **Well-structured tabs** — 7 tabs with proper ARIA roles, keyboard support, URL params for deep linking. | — | Good pattern. |
| 6.2 | P3 | **Tab overflow on mobile** — 7 tabs in a horizontal row will overflow on small screens. No scroll indicator or wrapping. | `Settings.tsx:93-112` | Add `overflow-x-auto` with scroll snap, or switch to vertical tab layout on mobile. |

### 7. Security (`/security`)

| # | Severity | Issue | File | Recommendation |
|---|:-:|-------|------|----------------|
| 7.1 | **EXCELLENT** | **Best-designed page** — PTY isolation map, approval audit log, data sovereignty report with status colors. Use as design reference. | — | This is the gold standard for other pages. |

### 8. Navigation (Sidebar)

| # | Severity | Issue | File | Recommendation |
|---|:-:|-------|------|----------------|
| 8.1 | **GOOD** | **Grouped navigation** — 4 groups (Work, Communicate, Tools, System) with dividers and labels. Matches IA review recommendations. | — | Well implemented. |
| 8.2 | P3 | **Project sub-nav uses hash routing** — `#detail`, `#editor`, `#tasks`, `#teams` are hash-based. This works but prevents deep linking from browser history and doesn't highlight in address bar. | `Navigation.tsx:161-231` | Consider migrating to route-based tabs (`/projects/:id/tasks`) for better UX and SEO. Low priority. |

### 9. ScheduledCheckins (`/scheduled-checkins`)

| # | Severity | Issue | File | Recommendation |
|---|:-:|-------|------|----------------|
| 9.1 | **GOOD** | **No longer blank** — Full card layout with active/completed tabs, system checks section, delivery logs table, create/edit modal. | — | Major improvement from previous audit. |
| 9.2 | P3 | **Extra px-6 padding** — Page adds its own `px-6 py-8` padding while other pages rely on layout container padding. May cause inconsistent margins. | `ScheduledCheckins.tsx:61` | Remove page-level padding if the layout already provides it. |

---

## Cross-Cutting Issues

| # | Severity | Issue | Recommendation |
|---|:-:|-------|----------------|
| X.1 | P1 | **Inconsistent API patterns** — Dashboard uses `apiService`, Projects uses `axios.get()` directly, Teams uses both `apiService` and raw `fetch()`. | Standardize on `apiService` everywhere. |
| X.2 | P2 | **Duplicated avatar migration** — The `picsum.photos` fallback is copy-pasted in 3 files. Teams.tsx correctly uses `assignDefaultAvatars()` from utils. | Use `assignDefaultAvatars()` in Dashboard and Projects too. |
| X.3 | P2 | **Inconsistent error handling** — Dashboard uses `console.error`, Teams uses `logSilentError`, Projects uses `console.error` and `console.warn`. | Standardize on `logSilentError()` everywhere. |
| X.4 | P2 | **Marketplace uses hardcoded gray colors** — Other pages use design tokens (`bg-surface-dark`, `text-text-secondary-dark`). Marketplace uses Tailwind grays directly. | Migrate Marketplace to use theme tokens. |
| X.5 | P2 | **No consistent confirmation dialog** — Teams uses `window.confirm()`, Marketplace uses `ConfirmDialog`, some places have no confirmation. | Use `ConfirmDialog` for all destructive actions. |
| X.6 | P3 | **No skeleton loading states** — All pages have spinners, but no skeleton/shimmer loading that preserves layout. | Consider adding skeleton states for cards and lists. |

---

## Priority Summary

### P1 — Should fix soon (1 issue)
1. **X.1** Inconsistent API patterns (functional risk: bypasses caching/error handling)

### P2 — Should fix in next sprint (10 issues)
1. **1.1** Avatar picsum.photos fallback
2. **1.2** console.error in production
3. **1.5** Only 2 projects shown on Dashboard
4. **2.1** window.confirm for delete
5. **2.2** Inconsistent API usage in Teams
6. **3.1** Duplicated avatar migration
7. **3.2** Mixed API patterns in Projects
8. **3.3** Status filter mismatch
9. **5.3** Marketplace hardcoded colors
10. **X.3-X.5** Cross-cutting consistency issues

### P3 — Polish (9 issues)
Low priority items: empty state for Dashboard, hardcoded "Secure", sort controls, chat search, detail view for Marketplace, Settings tab overflow, hash routing, padding inconsistency, skeleton loading.

---

## Comparison with Previous Audit

| Metric | Previous (2026-03-26 AM) | Current |
|--------|:-:|:-:|
| P0 issues | 2 | **0** |
| P1 issues | 3 | **1** |
| P2 issues | 12 | **10** |
| P3 issues | 8 | **9** |
| Pages with loading states | 0 | **6** |
| Sensitive data masking | None | **JWT + Path + API key** |
| Blank pages | 2 | **0** |

**Overall assessment:** The app has improved significantly. All critical (P0) issues are resolved. The remaining work is consistency and polish. The Security page is the design benchmark — other pages should aspire to its quality.
