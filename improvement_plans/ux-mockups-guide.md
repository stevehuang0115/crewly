# UI Improvement Mockups — Design Guide

**Designer:** Ava (UX Designer)
**Date:** 2026-03-26
**Method:** HTML/CSS mockups rendered via Playwright at 1440x900
**Source HTML:** `/tmp/crewly-ux-audit/mockups/`

---

## Mockup 1: Dashboard (Improved)

**File:** `improvement_plans/mockup-dashboard-improved.png`
**HTML Source:** `/tmp/crewly-ux-audit/mockups/dashboard-improved.html`

### What Changed & Why

| Change | Before | After | Why |
|--------|--------|-------|-----|
| **Hero stat card** | All 4 stats identical style | "Running Agents" has green accent border + gradient background | Most important metric (agent health) should be immediately visible. Resolves "what's the system status?" in <1 second. |
| **"Active Projects: 0" removed** | Showed 0 active (confusing) | Replaced with "Tasks Today: 7" | Eliminates contradiction. "Tasks Today" is more actionable — users care about what's happening now, not a stale project count. |
| **Stat subtitles** | No context | "3 with active tasks", "2 active now", "4 completed, 3 in progress" | Gives immediate context without clicking. Users understand the numbers without guessing. |
| **Cloud banner** | Red error text below cards, easy to miss | Yellow inline banner with "↻ Retry Connection" CTA | Visible but not alarming (yellow = warning, not red = error). Retry button gives users agency. |
| **Project cards** | Showed "Stopped" in red, truncated paths | Show "Active" badge, clean project names, task count, progress bar | Eliminates panic-inducing "Stopped" red badges. Shows meaningful progress (19/29 tasks). |
| **Team pills** | Just team names, no metadata | Show agent count + activity status with green/grey dot | Users can see team health at a glance without clicking. |
| **"New Project" card** | Blended with project cards | Dashed border + "+" icon, visually distinct | Clear CTA affordance — users immediately recognize it as an action, not data. |

---

## Mockup 2: Teams (Improved)

**File:** `improvement_plans/mockup-teams-improved.png`
**HTML Source:** `/tmp/crewly-ux-audit/mockups/teams-improved.html`

### What Changed & Why

| Change | Before | After | Why |
|--------|--------|-------|-----|
| **Standardized card layout** | Cards had inconsistent content — some showed project, some showed members, some were nearly empty | Every card shows: initials avatar, name, status badge, agent count, metadata, member avatars, project link | Consistency builds trust. Users can scan and compare teams quickly when all cards follow the same template. |
| **Initials avatars** | Stock nature photos (trees, landscapes) | Generated initials (OT, CP, SP, BT, DT) with color-coded backgrounds | Team identity is clear. Active teams get blue/green bg, inactive get grey. No confusing stock photos. |
| **Status badges** | Only some cards had badges | Every card has "● Active" (green) or "○ Inactive" (grey) | Users can instantly see which teams are running. No ambiguity. |
| **Member avatars with activity dots** | No member indicators | Small circular avatars with green ring for active agents | Shows who's online at a glance without opening the team. |
| **Empty team handling** | Empty cards looked identical to active ones | Shows "⚠️ No project assigned — Assign Project" with action link | Guides users to fix the gap. Reduces "why is this team here?" confusion. |
| **Kebab menu (⋮)** | Not visible on cards | Top-right on every card | Provides access to Edit, Archive, Delete without navigating to detail page. |
| **Grid/List toggle** | No aria-labels | Buttons have `aria-label="Grid view"` and `title` tooltips | Accessibility fix. Screen readers and hover users can identify the buttons. |
| **Filter chips** | Separate styling | Pill-shaped with active state (blue border + text) | Clearer visual feedback for which filter is active. |

---

## Mockup 3: Chat (Improved)

**File:** `improvement_plans/mockup-chat-improved.png`
**HTML Source:** `/tmp/crewly-ux-audit/mockups/chat-improved.html`

### What Changed & Why

| Change | Before | After | Why |
|--------|--------|-------|-----|
| **Thread list: compact items** | Long message previews, cluttered | Source badge (Slack/Crewly) + one-line preview + message count + timestamp | Scannable in 1 second per item. Users find threads by source, time, and preview. |
| **Active thread indicator** | No visual distinction | Blue left border + darker background | Users always know which thread is selected. |
| **Unread threads** | No unread state | Bold white preview text for unread threads | Mimics email/chat UX. Users know what's new. |
| **JWT token masked** | Raw `eyJhbGciOiJIUzI1NiI...` visible in preview | Shows "🔒 Sensitive content" badge | **Security fix.** Tokens should never be displayed in message previews. Prevents shoulder-surfing and accidental exposure. |
| **Timestamp format** | "Yesterday" (too vague for older) | Relative for <24h ("3 min ago"), absolute for older ("Mar 25, 2:30 PM") | Users can accurately identify when messages were sent. |
| **Raw system metadata hidden** | `[Thread context file: /Users/...]` shown inline | Collapsed "📎 Thread context attached · Click to expand" badge | System data is available but not cluttering the message view. Clean messages focus on content. |
| **Slack images rendered** | Raw file paths `[Slack Image: /Users/...]` | Inline image placeholder with 🖼️ icon | Images should render visually, not as file paths. Placeholder shown when image is loading. |
| **Visible Send button** | No Send button, only "Enter ↵" hint | Green ➤ Send button next to input | Users expect a clickable Send button. Not everyone knows keyboard shortcuts. Critical for mobile. |
| **Source badges** | Text "🔷 Slack" | Colored pill badges (purple for Slack, blue for Crewly) | Quick visual source identification without reading text. |

---

## Design System Notes

### Color Palette Used

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-primary` | `#111721` | Main background |
| `--bg-secondary` | `#161b22` | Cards, panels |
| `--bg-tertiary` | `#0d1117` | Sidebar, inputs |
| `--border` | `#1e2a3a` | Card borders |
| `--text-primary` | `#f6f7f8` | Main text |
| `--text-secondary` | `#8b949e` | Labels, meta |
| `--text-muted` | `#484f58` | Timestamps |
| `--accent-blue` | `#58a6ff` | Active states, links |
| `--accent-green` | `#3fb950` | Success, active |
| `--accent-yellow` | `#d29922` | Warning, cloud offline |
| `--accent-red` | `#f85149` | Error, destructive |
| `--accent-orange` | `#f0883e` | Warning badges |

### Consistent Patterns

1. **Cards:** `bg-secondary` + `border` + `12px border-radius` + `20px padding`
2. **Badges:** `12px border-radius` pill with colored bg + text
3. **CTAs:** Green bg for primary, blue text for secondary
4. **Empty states:** Dashed border + muted text + action link
5. **Destructive actions:** Red text/bg, always with confirmation dialog

---

## Implementation Priority

1. **Quick CSS wins** (< 1 day): Hero stat card accent, status badge colors, compact thread items
2. **Component changes** (1-2 days): Send button, context badge, masked tokens, standardized team cards
3. **Feature additions** (2-3 days): Retry connection CTA, team initials avatars, thread unread state

---

*All mockup HTML source files are in `/tmp/crewly-ux-audit/mockups/` and can be opened directly in a browser for interactive review.*
