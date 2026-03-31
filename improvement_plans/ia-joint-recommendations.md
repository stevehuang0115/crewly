# Crewly OSS Information Architecture — Joint Recommendations (Mia x Ava)

**Date:** 2026-03-26
**Status:** FINAL CONSENSUS
**Participants:** Mia (Product Manager) + Ava (UX Designer)

## Executive Summary
This document outlines the agreed-upon Information Architecture (IA) overhaul for Crewly OSS. Our goal is to transform the UI from a collection of status pages into an **actionable cockpit** that answers "What happened?" and "What is the team doing now?".

---

## 1. Global Navigation (The "Workplace" Model)
Current flat 9-item nav is overwhelming. We recommend functional grouping:

| Group | Pages | Responsibility |
| :--- | :--- | :--- |
| **Work** | Dashboard, Projects, Teams | Primary monitoring and management. |
| **Communicate** | Chat | Internal/External messaging hub. |
| **Tools** | Marketplace, Schedules | Extension of capabilities. |
| **System** | Security, Settings | Trust, compliance, and configuration. |

**Key Changes:**
- **Mobile Access:** Move to *Settings > Cloud*.
- **Favorites:** Allow "Pinning" (max 5) Projects/Teams to the top of the Work group.

---

## 2. The Dashboard (The "Cockpit")
Transition from a static status page to an **Activity-First** overview.

- **Zone 1: Health Bar (Top, 10%):** Single compact row showing Agent Health, Relay Status, and a **Security Shield** (red on alert).
- **Zone 2: Activity Feed (Center, 60%):** A chronological "Daily Standup" feed. Includes task completions, PR merges, and **Chat Highlights** (decisions/questions).
- **Zone 3: Quick Actions (Bottom/Side, 30%):** 2x2 grid for *Start Team*, *Create Project*, *View Chat*.
- **Terminal Removal:** Remove global terminal from Dashboard; move to *Team Detail*.

---

## 3. Projects & Teams (The "Inventory")
Clearly separate **WHAT** is being done from **WHO** is doing it.

### Projects (WHAT)
- **AI Sparkle:** Move "Generate Tasks from Goal" to a primary header button.
- **Archive Strategy:** Active projects first; completed (100%) projects move to a collapsible bottom section.
- **Deep Search:** Search project names AND internal task names.

### Teams (WHO)
- **Flat vs Tree:** Default to a flat list (Active-first); add a **Tree View Toggle** for organizational hierarchy.
- **Standard Cards:** Consistent layout showing Member Row, Project Link, and **Last Activity** timestamp.
- **Quick Controls:** Start/Stop icons directly on the card header.

---

## 4. Chat (The "Interaction Hub")
Focus on performance, rich content, and security.

- **Virtual Scrolling:** Mandatory use of `react-window` for the thread list to handle high message volume.
- **Rich Rendering:** Support for syntax-highlighted code blocks, inline images (with lightbox), and task chips.
- **Metadata Masking (P0):** Regex-based redaction of JWT tokens and file paths in messages.
- **Mentions:** Full support for **@Agent** mentions with autocomplete and priority routing.

---

## 5. Marketplace & Security (The "Trust Anchors")

### Marketplace
- **Uninstall Safety (P0):** Confirmation modals for all uninstalls.
- **Skill Detail Pages (P1):** Dedicated `/marketplace/{id}` routes with full READMEs and configuration guides.

### Settings & System
- **Deep Linking (P0):** Fix broken direct URL routing for settings tabs (e.g., accessing `/settings/integrations` directly).
- **Organization:** Group toggles into *Basic* vs. *Advanced* sections with a sticky Save/Reset bar.

---

## Implementation Roadmap
- **Sprint 1 (P0):** Nav Grouping, Dashboard Activity Feed logic, Chat Metadata Masking, Marketplace Uninstall Modals.
- **Sprint 2 (P1):** Card Standardization, Onboarding Wizard, Skill Detail Pages, Expandable PTY Cards.
- **Sprint 3 (P2):** Tree View Toggle, Security Score, Pinned Favorites.
