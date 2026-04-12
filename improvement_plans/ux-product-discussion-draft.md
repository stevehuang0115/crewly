# Ava x Mia — Information Architecture & UI Design Discussion

**Participants:** Ava (UX Designer) + Mia (PM)
**Date:** 2026-03-26
**Focus:** Information Architecture — hierarchy, navigation, data distribution, page responsibilities, user flows
**Goal:** Agree on what each page owns, what data belongs where, and how users navigate between them

---

## 0. Global Alignment (CONSENSUS)

### Navigation Structure
- **Grouped Nav:** SUPPORTED (Work, Communicate, Tools, System).
- **Mobile Access:** Move to Settings > Cloud.
- **Schedules:** Hide until implemented.
- **Pinned Favorites:** Max 5 starred Project/Team links at top of "Work" group.

### Page Overlap
- Dashboard is the **Cockpit** (Actionable summary).
- Projects/Teams are the **Inventory** (Detail/Management).

---

## 1. Dashboard (CONSENSUS REACHED)

### 3-Zone Layout
- **Zone 1: Health Bar (Top):** Hero metrics (Agents, Relay). Visuals escalate only on errors.
- **Zone 2: Activity Feed (Center, 60%):** The "What happened?" engine. Stream of task completions, PRs, and critical alerts.
- **Zone 3: Quick Actions (Side/Bottom):** 2x2 grid for Start Team, Create Project, etc.

### Key Product Refinements
- **Activity Feed Content:** Should include **Chat Highlights** (decisions, direct user questions) alongside system events.
- **Terminal Panel:** **REMOVE** from Dashboard. Move to Team Detail page.
- **Onboarding:** A 3-step wizard (Project -> Team -> Start) replaces the Activity Feed for users with 0 projects.

---

## 2. Teams (CONSENSUS REACHED)

### View & Hierarchy
- **Flat by Default:** All teams listed, sorted by **Active-first**.
- **Tree View Toggle:** Indented hierarchy for Parent/Child relationships.

### Card Standardization
- **Fields:** [Initials Avatar] [Team Name + Status] [Agent/Task counts] [Member Row] [Project Link].
- **Stale Detection:** Add **Last Activity** timestamp.
- **Empty State:** Orange "Assign Project" CTA.

---

## 3. Projects (CONSENSUS REACHED)

### Core Differentiator: AI Task Generation
- **Visibility:** Move to a primary **AI Sparkle** button in the header and detail view.

### Inventory Management
- **Archiving:** Active Projects at top; "Completed" projects (100%) move to a collapsible bottom section.
- **Deep Search:** Search covers project names AND task names.

---

## 4. Chat (CONSENSUS REACHED)

### Interaction Model
- **Channel Priority:** Default to **Crewly** tab (local real-time).
- **Performance:** **Virtual Scrolling** (react-window) for thread list.

### Message Rendering & Security
- **Rich Content:** Code blocks (syntax highlight/copy), inline images (lightbox), Markdown.
- **Metadata Masking (P0):** Regex-based masking for context file paths and JWTs.
- **Mentions:** **@Agent** mentions with autocomplete.

---

## 5. Marketplace (CONSENSUS REACHED)

### Reliability & Discovery
- **Uninstall (P0):** Confirmation modal required for all uninstalls.
- **Skill Detail Page (P1):** Dedicated route `/marketplace/{id}` with README, config panel, and version history.
- **Feedback (P0):** Install/Uninstall success toast notifications.

### IA Proposals
- **Tab Counts:** Show item counts on categories (e.g., Skills (12)).
- **Badging (P2):** "Update available" badges and dependency warnings.

---

## 6. Security (CONSENSUS REACHED)

### Visibility & Trust
- **Dashboard Shield (P0):** Shield icon in Health Bar Zone 1; turns red with count badge on denials.
- **Expandable PTY (P1):** Click agent card to expand live terminal preview (last 5 lines) and resource usage.
- **Security Score (P2):** 0-100 score widget based on isolation, compliance, and sovereignty.

### Audit Log
- **Scroll:** Infinite scroll for history.
- **Filters:** Support saved filters (e.g., "Denied Actions").
