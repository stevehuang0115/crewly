# Crewly OSS UI Improvement — Sprint 2 Roadmap (P1)

**Goal:** Refine the "Cockpit" experience and simplify the onboarding flow for new "one-man company" operators.

## 1. Onboarding Wizard (The "Genesis" Flow)
- **Problem:** New users land on the dashboard and don't know how to start their first team.
- **Solution:** A 4-step wizard for first-time login:
  - **Step 1:** Connect Cloud (OAuth).
  - **Step 2:** Select Industry Template (Software, Marketing, Ops).
  - **Step 3:** Review Team Members & Skills.
  - **Step 4:** Launch first Project.
- **Tech:** Multi-step form component using `framer-motion` for transitions.

## 2. Card Standardization (The "Unity" System)
- **Problem:** Project cards and Team cards look different, creating cognitive load.
- **Solution:** Create a base `ActionCard` component with:
  - Header: Icon + Title + Status Badge.
  - Content: 2-3 key metrics (e.g., Progress %, Last Active).
  - Actions: Primary (Blue) + Secondary (Gray).
- **Files:** Refactor `ProjectCard.tsx` and `TeamCard.tsx` to use `ActionCard`.

## 3. Skill Detail Pages (The "Playbook")
- **Problem:** Users can install skills but don't know what parameters they take.
- **Solution:** Dynamic routes at `/marketplace/:skillId`:
  - Renders the `SKILL.md` from the local folder.
  - Shows parameter tables and example usage.
  - Inline "Configure" button to set required environment variables.

## 4. Expandable PTY Cards (The "Live Wire")
- **Problem:** Security page shows PTY status but logs are hidden in the terminal.
- **Solution:** Make PTY cards in `/security` expandable:
  - On click, open a mini-terminal (using `xterm.js`) showing the last 50 lines of activity.
  - Add a "Kill Process" button for emergency isolation.

---

## Task Breakdown

| Task ID | Description | Role | Priority |
| :--- | :--- | :--- | :--- |
| UI-S2-01 | Implement Onboarding Wizard Framework | UX/Dev | P0 |
| UI-S2-02 | Create standardized `ActionCard` component | UX | P1 |
| UI-S2-03 | Build Dynamic Skill Detail Pages (`/marketplace/:id`) | Dev | P1 |
| UI-S2-04 | Add live log view to PTY Security Cards | Dev | P1 |
| UI-S2-05 | Clean up legacy login UI remnants | Dev | P2 |
