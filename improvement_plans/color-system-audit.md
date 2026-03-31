# Crewly OSS Color System Audit

**Auditor:** Ava (UX Designer, crewly-product-ava-member-u)
**Date:** 2026-03-26

---

## 1. Current Color Sources

The app defines colors in **3 places** (already a problem):

| Source | Primary Color | Notes |
|--------|:------------:|-------|
| `tailwind.config.js` | `#2a73ea` (blue) | Defines `primary` token |
| `styles/tokens.css` | `#2a73ea` (blue) | CSS custom properties — matches tailwind |
| Inline Tailwind classes | Mixed blue/purple/indigo/violet | **NOT using the tokens** |

The tokens are well-defined and consistent. The problem is that **many components bypass the token system** and hardcode Tailwind color utilities directly.

---

## 2. The Blue vs Purple Problem — Where Each Appears

### Blue Family (`blue-*`, `#2a73ea`, `primary`)

**Intended role:** Primary brand color, interactive elements, info states

| Location | Usage | Color |
|----------|-------|-------|
| Design tokens | `--color-primary` | `#2a73ea` (blue) |
| `index.css` | `.btn-primary`, `.status-completed`, `.priority-badge`, `.edit-btn` | `bg-primary` / `blue-500` |
| `StatusBadge.tsx` | Completed status | `blue-500/10 text-blue-400` |
| `Alert.tsx`, `Badge.tsx`, `Toast.tsx` | Info variant | `blue-500` |
| `SecurityArchDiagram.tsx` | PTY isolation pillar | `blue-500` |
| `DashboardNavigation.tsx` | Active tab | `blue-500`, `blue-600` |
| `Marketplace.tsx` | Install button, search focus, skill badge | `indigo-600` (!!) |
| `Knowledge/*.tsx` | All interactive elements | `indigo-600`, `indigo-500` |
| `FactoryScene.tsx` | Action buttons | `blue-600` |
| `LoadingSpinner.tsx` | Spinner | `blue-600` |
| `ProjectInfoPanel.tsx` | Stats | `blue-600`, `blue-100` (LIGHT MODE!) |
| **Total occurrences** | | **~100+ across 30 files** |

### Purple/Violet/Indigo Family

**No defined role** — used ad-hoc across multiple contexts:

| Location | Usage | Color |
|----------|-------|-------|
| `Projects.tsx` | "Generate Tasks" CTA button | `from-indigo-500 to-purple-500` gradient |
| `Dashboard.tsx` | Onboarding card | `from-primary/20 to-purple-500/20` |
| `Marketplace.tsx` | Install button | `indigo-600` |
| `MarketplaceDetail.tsx` | Install button, model badge | `indigo-600`, `purple-500` |
| `Knowledge/*.tsx` | All focus/active states | `indigo-500`, `indigo-600` |
| `CloudConnectionBanner.tsx` | Cloud promo banner | `violet-500`, `violet-400`, `violet-300` |
| `SecurityOverview.tsx` | Storage icon | `purple-400` |
| `SecurityPillarCard.tsx` | Storage pillar | `purple-500` |
| `SecurityArchDiagram.tsx` | Storage layer | `purple-500` |
| `SkillsTab.tsx` | Automation/memory/claude-skill badges | `purple-500`, `violet-500` |
| `RolesTab.tsx` | Sales role | `purple-500` |
| `TeamMemberRow.tsx` | "Suspended" status | `purple-500` |
| `StatusBadge.tsx` | Suspended variant | `purple-500` |
| `HierarchyDashboard.tsx` | "Working" stat | `purple-500` |
| `TaskFlowView.tsx` | "Submitted" status | `purple-400` |
| `QuickActionsPanel.tsx` | Icon | `purple-600` |
| `TeamCard.tsx` | Orchestrator role color | `#8b5cf6` (purple-500) |
| **Total occurrences** | | **~50+ across 20+ files** |

### The 4-Way Split

The app effectively uses **4 different "accent" blues/purples**:

| Color | Hex | Tailwind | Where |
|-------|-----|----------|-------|
| Primary Blue | `#2a73ea` | `primary` | Tokens, buttons, borders |
| Tailwind Blue | `#3b82f6` | `blue-500` | Status badges, info alerts |
| Indigo | `#6366f1` | `indigo-500/600` | Marketplace, Knowledge, CTA |
| Purple | `#8b5cf6` | `purple-500` | Security storage, roles, gradients |
| Violet | `#8b5cf6` | `violet-500` | Cloud banner (one-off) |

These are **4 different hues** competing for user attention with no semantic distinction.

---

## 3. Recommendation: Unify to a Single Primary with Semantic Accents

### Why Blue (not Purple)

1. **Already the defined primary** — `#2a73ea` is in both `tailwind.config.js` and `tokens.css`
2. **Trust/reliability associations** — Blue is the standard for developer tools (GitHub, VS Code, Linear, Vercel)
3. **Accessibility** — Blue on dark backgrounds has better contrast ratios than purple
4. **Purple = premium/creative** — If Crewly ever distinguishes OSS vs Pro, purple can be the Pro accent
5. **Scope of change** — Blue is already the token; fixing means removing overrides, not changing the system

### Recommended Design Palette

```
┌─────────────────────────────────────────────────────────┐
│  CREWLY OSS COLOR SYSTEM                                │
├─────────────┬───────────┬───────────────────────────────┤
│  Token      │  Hex      │  Usage                        │
├─────────────┼───────────┼───────────────────────────────┤
│  PRIMARY    │           │                               │
│  primary    │ #2a73ea   │ Buttons, links, focus rings   │
│  primary-h  │ #1e5fc7   │ Hover states                  │
│  primary/10 │ opacity   │ Subtle backgrounds            │
│             │           │                               │
│  SECONDARY  │           │                               │
│  secondary  │ #6366f1   │ AI/premium features ONLY      │
│  (indigo)   │           │ "Generate Tasks", Cloud CTA   │
│             │           │                               │
│  STATUS     │           │                               │
│  success    │ #22c55e   │ Active, healthy, approved      │
│  warning    │ #f59e0b   │ Activating, paused, caution   │
│  error      │ #ef4444   │ Error, denied, stopped        │
│  info       │ #3b82f6   │ Informational, completed      │
│  neutral    │ #6b7280   │ Inactive, idle, disabled      │
│             │           │                               │
│  SURFACE    │           │                               │
│  bg-primary │ #111721   │ Page background               │
│  bg-surface │ #1a222c   │ Cards, panels                 │
│  bg-hover   │ #232d3b   │ Hover states                  │
│  border     │ #313a48   │ Borders, dividers             │
│             │           │                               │
│  TEXT       │           │                               │
│  text-1     │ #f6f7f8   │ Primary text                  │
│  text-2     │ #9ab0d9   │ Secondary text                │
│  text-3     │ #6b7a94   │ Muted text                    │
└─────────────┴───────────┴───────────────────────────────┘
```

### Key Design Rules

1. **Primary (`#2a73ea`)** — ALL interactive elements: buttons, links, focus borders, active states, hover borders
2. **Secondary/Indigo (`#6366f1`)** — ONLY for AI-powered features ("Generate Tasks" sparkle button, Cloud CTA). This signals "this is AI magic" vs normal actions
3. **Never use `purple-*`, `violet-*`** as standalone colors. Remove all ad-hoc purple usage
4. **Status colors are semantic only** — green=good, yellow=warning, red=bad, blue=info, gray=neutral. Never use status colors for decoration
5. **Role/category differentiation** — Use the primary blue + opacity variations, not different hues. If you must differentiate categories (like skill types), use icon shapes, not colors

---

## 4. Scope of Changes

### Files Requiring Color Unification

| Change Type | Files | Est. Lines |
|-------------|:-----:|:----------:|
| **Purple → Primary blue** (role colors, status, icons) | ~15 | ~40 |
| **Violet → Primary blue** (Cloud banner) | 1 | 4 |
| **Indigo → Primary blue** (Marketplace, Knowledge) | ~8 | ~30 |
| **Blue-600 → primary** (DashboardNav, LoadingSpinner, Factory) | ~5 | ~10 |
| **Gray-700/900 → surface tokens** (Marketplace, Knowledge) | ~6 | ~20 |
| **Gradient simplification** (Generate Tasks) | 1 | 2 |
| **Light mode artifacts** (ProjectInfoPanel, Summary.css) | 2 | ~10 |
| **Test file updates** | ~5 | ~15 |
| **Total** | **~35 files** | **~130 lines** |

### Priority Order

1. **P0 — Remove light-mode artifacts** (2 files) — `ProjectInfoPanel.tsx` uses `blue-100`, `bg-blue-100` which are light-mode colors on a dark app
2. **P0 — Unify interactive elements** (8 files) — Marketplace and Knowledge pages use `indigo-600` instead of `primary` for buttons/focus
3. **P1 — Remove ad-hoc purple** (15 files) — Replace `purple-*` with `primary` or semantic status colors
4. **P1 — Remove violet** (1 file) — Cloud banner should use `primary` styling
5. **P2 — Hardcode → Token migration** (6 files) — Replace `gray-700/900` with `surface-dark`/`border-dark` tokens
6. **P2 — Update tests** (5 files) — Update color assertions in test files

### Specific File Changes

| File | Current | Should Be |
|------|---------|-----------|
| `Projects.tsx:223` | `from-indigo-500 to-purple-500` | `from-primary to-indigo-500` (AI secondary) |
| `Dashboard.tsx:218` | `from-primary/20 to-purple-500/20` | `from-primary/20 to-primary/10` |
| `Marketplace.tsx:365` | `bg-indigo-600` | `bg-primary` |
| `MarketplaceDetail.tsx:208` | `bg-indigo-600` | `bg-primary` |
| `CloudConnectionBanner.tsx:105-109` | `violet-500/400/300/200` | `primary` variants |
| `SecurityOverview.tsx:130` | `text-purple-400` | `text-primary` or `text-blue-400` |
| `TeamCard.tsx:25` | `'#8b5cf6'` (orchestrator) | `'#2a73ea'` (primary) |
| `TeamMemberRow.tsx:39` | `purple-500` (suspended) | `yellow-500` (use warning semantic) |
| `StatusBadge.tsx:21` | `purple-500` (suspended) | `yellow-500` (warning) |
| `QuickActionsPanel.tsx:78` | `text-purple-600` | `text-primary` |
| `HierarchyDashboard.tsx:201` | `purple-500` (working stat) | `primary` |
| `Knowledge/*.tsx` (5 files) | `indigo-600/500` | `primary` |
| `DashboardNavigation.tsx:22` | `blue-500/600` | `primary` |
| `ProjectInfoPanel.tsx` | `blue-100/600` (light mode!) | `primary/10 text-primary` |
| `LoadingSpinner.tsx:11` | `blue-600` | `primary` |

### Exception: Security Page

The Security page uses blue/green/purple to differentiate **3 security pillars** (PTY=blue, Approval=green, Storage=purple). This is an intentional data visualization pattern and should remain — but should be documented as "the Security pillar palette" so it's not copied elsewhere.

---

## 5. Summary

| Metric | Current | After Fix |
|--------|:-------:|:---------:|
| Distinct accent hues | 4 (blue, indigo, purple, violet) | 2 (primary blue + indigo for AI) |
| Files with hardcoded colors | ~35 | ~5 (Security page exceptions) |
| Token usage compliance | ~60% | ~95% |
| Visual consistency | Low (user-reported confusion) | High |

**Bottom line:** The token system is already correct (`#2a73ea` blue). The problem is ~35 files bypassing it with hardcoded Tailwind color utilities. The fix is mechanical — find-and-replace each instance with the token equivalent. No design system redesign needed.
