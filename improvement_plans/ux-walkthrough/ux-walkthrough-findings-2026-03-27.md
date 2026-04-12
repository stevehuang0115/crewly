# Autonomous UX Walkthrough — Findings & Improvement Plan

> **Date:** 2026-03-27
> **Method:** Playwright headless browser on http://localhost:8787 (desktop 1440x900)
> **Authors:** Ava (UX Designer) + Mia (PM, structural input)
> **Screenshots:** `improvement_plans/ux-walkthrough/*.png`

---

## Executive Summary

Walked through all 9 pages of the Crewly OSS app via Playwright, interacting with real data (50 chat threads, 20 teams, 10+ projects). Found **23 issues** across 4 severity levels. The most impactful problems center on the **Chat thread list** (no unread state, no avatars, wasted space), the **Schedules page** (Cron Jobs buried), and the **Dashboard** (static, no activity feed).

---

## Page-by-Page Findings

### 1. Dashboard

**Screenshot:** `01-dashboard.png`

| # | Sev | Issue | Details |
|---|-----|-------|---------|
| D1 | P1 | **"0 Active Projects" is misleading** | There ARE projects with progress bars visible below, but the stat card shows 0 "Active". The distinction between "Active" and "Idle/Stopped" is confusing to users who see project cards right below the stat. |
| D2 | P1 | **"14 Agents" vs "13 Running Agents" — unclear distinction** | Two stat cards show nearly identical numbers without explaining why they differ. Users wonder "what happened to agent #14?" |
| D3 | P1 | **Teams section truncated — no "View All"** | Only 4 of 20 teams visible. No button, link, or visual cue to see the rest. Users may think they only have 4 teams. |
| D4 | P2 | **No activity feed** | Dashboard is a static snapshot. No recent events, task completions, or agent activity. Users can't answer "what happened while I was away?" (Mia also flagged this.) |
| D5 | P2 | **"Create New Project" card blends in** | The CTA card for creating a project has no visual distinction from project data cards — same dark bg, same border. Should stand out more. |

### 2. Chat Page

**Screenshots:** `02-chat.png`, `02b-chat-sidebar-closeup.png`, `02c-chat-thread-open.png`

| # | Sev | Issue | Details |
|---|-----|-------|---------|
| C1 | P0 | **No unread indicators** | 50 threads in sidebar, no way to tell which have new messages. Every thread looks the same (read or unread). This is the single biggest usability gap. |
| C2 | P0 | **Thread cards are text walls — no visual anchoring** | Each card is: channel badge (tiny letter) + title + time + sender + preview + message count. All text, no avatars, no color coding. Scanning 50 threads is exhausting. |
| C3 | P1 | **Channel badges are cryptic single letters** | `S`, `C` letters in tiny pills. Users must memorize that S=Slack, C=Crewly. Badge should show full label or use recognizable icons. |
| C4 | P1 | **Footer row wastes vertical space** | Third row shows only "44 messages" — low-value information consuming ~20% of the card height. Could be inline with the time. |
| C5 | P1 | **Preview text truncated to single line** | Hardcoded 77-char slice. In a multi-agent context, the first line is often "You: " prefix, leaving almost no space for actual content. CSS `line-clamp: 2` would give more context. |
| C6 | P1 | **Active thread selection is too subtle** | Only a thin blue left border and title color change. In a list of 50 threads, the selected one is hard to spot visually. |
| C7 | P1 | **Right pane shows "Welcome to Crewly" even after thread select** | When a thread is clicked, the right pane still shows the empty state initially. May be a loading race condition. |
| C8 | P2 | **No hover actions on thread cards** | No overflow menu (pin, archive, delete) on ThreadPreview. The ChatSidebar component has MoreVertical menus but ThreadListPanel doesn't use them. |
| C9 | P2 | **Chinese/English mixed titles create readability issues** | Many thread titles mix languages. The font/size works well for English but CJK characters at 14px look cramped. Consider slightly larger font or CJK-specific adjustments. |

### 3. Teams Page

**Screenshot:** `03-teams.png`

| # | Sev | Issue | Details |
|---|-----|-------|---------|
| T1 | P1 | **All team cards use identical placeholder avatars** | Every member shows the same gold/brown stock photo from picsum.photos. No visual differentiation between agents. Makes all teams look identical. |
| T2 | P2 | **Status badges (Active/Inactive) are small** | Green "Active" badges are tiny and don't pop enough against the dark background. |
| T3 | P2 | **No quick-start action on card** | To start a team, users must click into detail then find the start button. A "Play" icon directly on the card header would save a click. |

### 4. Projects Page

**Screenshot:** `04-projects.png`

| # | Sev | Issue | Details |
|---|-----|-------|---------|
| P1 | P1 | **Raw file paths shown on cards** | Cards display `.crewlyprojects/businesses...` — raw filesystem paths are not user-friendly. Should show project name or a shortened display path. |
| P2 | P2 | **Progress bars hard to distinguish** | Multiple blue progress bars at different percentages all look similar. No color variation (e.g., yellow for in-progress, green for near-complete). |

### 5. Schedules & Cron Page

**Screenshots:** `05-schedules-top.png`, `05-schedules-full.png`, `05-schedules-bottom.png`

| # | Sev | Issue | Details |
|---|-----|-------|---------|
| S1 | P0 | **CronJobPanel completely below the fold** | Users must scroll past empty scheduled messages + System Checks cards to find Cron Jobs. Many users will never discover this feature. |
| S2 | P1 | **No top-level tab for Cron Jobs** | The page has Active/Completed sub-tabs for messages but Cron is a completely separate concept buried at the bottom — should be a peer tab. |
| S3 | P2 | **"No active messages" empty state is the first thing users see** | If a user came to set up a cron job, the first screen they see says "No active messages" which is irrelevant to their goal. |

### 6. Security Page

**Screenshot:** `06-security.png`

| # | Sev | Issue | Details |
|---|-----|-------|---------|
| — | — | **Best-designed page in the app** | Score widget (100/100), PTY Status/Storage/Approvals cards, PTY Isolation Map — all well structured. Use as design reference for other pages. |

### 7. Settings Page

**Screenshot:** `07-settings.png`

| # | Sev | Issue | Details |
|---|-----|-------|---------|
| ST1 | P2 | **Tab bar has 8+ tabs — can be overwhelming** | General, Roles, Skills, Integrations, API Keys, Cloud, System. Consider grouping into Basic vs Advanced. |

### 8. Marketplace

**Screenshot:** `08-marketplace.png`

| # | Sev | Issue | Details |
|---|-----|-------|---------|
| M1 | P2 | **No skill icons or category coloring** | All cards look identical (dark bg + text). No visual distinction between AI skills, Browser tools, Quality tools, etc. |
| M2 | P2 | **"Installed" badge same blue as primary buttons** | Could be mistaken for a clickable button. Should use a softer green or outline style. |

### 9. Knowledge Page

| # | Sev | Issue | Details |
|---|-----|-------|---------|
| K1 | P1 | **Page 404s to Dashboard** | Navigating to /knowledge redirects to Dashboard. Either the route is broken or Knowledge has no nav entry. |

### 10. Global Issues

| # | Sev | Issue | Details |
|---|-----|-------|---------|
| G1 | P1 | **"Cloud Offline" banner always visible but non-actionable** | Grey banner at top of every page. No link to configure Cloud, no dismiss button. Adds visual noise. |
| G2 | P2 | **No breadcrumbs anywhere** | Detail pages (Team Detail, Project Detail) have no breadcrumb navigation — back button or sidebar are the only options. |
| G3 | P1 | **CSP blocks 3D texture loading** | Dashboard's 3D Factory scene throws 30+ console errors — `blob:` URLs blocked by Content Security Policy. The 3D scene loads but textures are missing. |

---

## Combined Improvement Plan (Ava + Mia)

### Sprint Priority: P0 (Must Fix)

| # | Item | Owner | Effort | Source |
|---|------|-------|--------|--------|
| 1 | **Chat: Unread indicators** (blue border + bold + dot) | Dev | 2h | C1 |
| 2 | **Chat: Agent avatars** with role-based colors in thread cards | Dev | 1.5h | C2 |
| 3 | **Chat: 2-row compact card layout** (CSS grid, remove footer row) | Dev | 2h | C2, C4 |
| 4 | **Schedules: Top-level tab layout** (Messages / Cron Jobs) | Dev | 1.5h | S1, S2 |
| 5 | **Chat: CSS line-clamp:2** for preview text | Dev | 0.5h | C5 |

### Sprint Priority: P1 (Should Fix)

| # | Item | Owner | Effort | Source |
|---|------|-------|--------|--------|
| 6 | **Chat: Channel badge with visible label** (not just letter) | Dev | 0.5h | C3 |
| 7 | **Chat: Stronger active thread highlight** (background color, not just border) | Dev | 0.5h | C6 |
| 8 | **Chat: Overflow menu on thread hover** (Pin/Archive/Delete) | Dev | 2h | C8 |
| 9 | **Dashboard: "View All Teams" link** below teams section | Dev | 0.5h | D3 |
| 10 | **Dashboard: Clarify stat cards** (rename to avoid confusion) | Dev | 0.5h | D1, D2 |
| 11 | **Teams: Replace placeholder avatars** with role-colored initials | Dev | 1h | T1 |
| 12 | **Projects: Display-friendly paths** (show project name, not raw path) | Dev | 1h | P1 |
| 13 | **Cloud Offline banner: Add "Configure" link or allow dismiss** | Dev | 0.5h | G1 |
| 14 | **Knowledge: Fix route/nav entry** | Dev | 0.5h | K1 |
| 15 | **CSP: Allow blob: in connect-src** for 3D texture loading | Dev | 0.5h | G3 |

### Sprint Priority: P2 (Nice to Have)

| # | Item | Owner | Effort | Source |
|---|------|-------|--------|--------|
| 16 | **Dashboard: Activity feed** (recent events, task completions) | Dev | 4h | D4, Mia |
| 17 | **Teams: Quick Start/Stop button on card** | Dev | 1h | T3 |
| 18 | **Projects: Color-coded progress bars** | Dev | 0.5h | P2 |
| 19 | **Marketplace: Skill category icons** | Dev | 1.5h | M1 |
| 20 | **Settings: Group tabs (Basic/Advanced)** | Dev | 1h | ST1 |
| 21 | **Breadcrumbs on detail pages** | Dev | 1.5h | G2 |

### Total Estimated Effort

| Priority | Items | Hours |
|----------|-------|-------|
| P0 | 5 | 7.5h |
| P1 | 10 | 7.5h |
| P2 | 6 | 9.5h |
| **Total** | **21** | **24.5h** |

---

## Mia's Structural Proposals — Assessment

Mia proposed a "Unified Workspace Architecture." My assessment:

| Proposal | Ava's Take | Priority |
|----------|------------|----------|
| Merge Dashboard/Projects/Teams into single Workspace | Too disruptive for one sprint. **Alternative:** Add cross-links (team cards show their projects, project cards show their team). Achieve "unified" feel without restructuring routes. | Future sprint |
| Project Home & Team Home detail pages | **Strong agree.** Current detail views are shallow lists. Should have summary header + tabs (Tasks/Members/Activity). | P1 next sprint |
| Global Activity Feed on Dashboard | **Agree — this is the #1 missing feature.** Dashboard should answer "what happened?" not just "what exists." | P2 this sprint |
| Role-based Chat themes | Interesting but lower priority than fixing fundamental thread list UX. | Future sprint |
| Fix empty Schedules & Mobile Access | **Schedules fixed by Tab layout (P0 this sprint).** Mobile Access page needs investigation — what should it show? | P0 / investigate |

---

## Detailed Spec: Chat Thread Card Redesign

(Full spec at `specs/tasks/phase2-ux/chat-thread-card-redesign.md`)

### Before (Current)
```
┌────────────────────────────────────────┐
│ [S]  Thread title here         2m ago  │  ← Row 1: badge + title + time
│ Sam: Preview text truncated at 77...   │  ← Row 2: sender + preview (1 line)
│ 44 messages                            │  ← Row 3: message count (wasted)
└────────────────────────────────────────┘
```

### After (Proposed)
```
┌────────────────────────────────────────┐
│ [A]  Thread title here     2m ago [..] │  ← Row 1: avatar + title + time + menu
│ [Slack] Sam: Preview text that can     │  ← Row 2: badge + sender + 2-line preview
│         span two lines for context     │     + message count pill (3)
└────────────────────────────────────────┘
  ↑ Blue left border = unread
  ↑ Background highlight = selected
```

### Key Visual Changes
1. **28px circle avatar** replacing empty space — colored by agent role
2. **Blue 3px left border + bold title + dot** for unread threads
3. **Background color** for selected thread (not just border)
4. **CSS line-clamp: 2** for preview (2 lines of context)
5. **Message count as small pill** inline with Row 2, not a full row
6. **Channel label visible** ("Slack" not just "S")
7. **MoreVertical menu on hover** (Pin / Archive / Delete)

---

## Next Steps

1. Share this doc with Sam/Leo for implementation review
2. P0 items can be a single PR (~7.5h total dev effort)
3. P1 items grouped as a follow-up PR
4. Mia to confirm structural proposals timeline for next sprint planning
