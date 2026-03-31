# UI Component Reuse Audit

**Auditor:** Ava (UX Designer, crewly-product-ava-member-u)
**Date:** 2026-03-27
**Scope:** Chat, Settings, Security pages vs shared UI Library (`frontend/src/components/UI/`)
**Baseline:** Post color-unification (primary blue #2a73ea confirmed consistent)

---

## Executive Summary

| Area | Components | UI Library Usage | Inline Duplicates | Severity |
|------|:----------:|:----------------:|:-----------------:|:--------:|
| **Chat** | 11 | **0 imports** | 7 button styles, 5 badge styles | Critical |
| **Settings** | 18 | Partial (Button, Input, Form) | 10+ error banners, 8+ spinners, 8+ section cards | High |
| **Security** | 9 | **0 imports** | 7 card styles, 5 badge/status styles | High |

**Bottom line:** The UI library has 15 well-built components (Button, Badge, Card, Modal, Input, Form, Toggle, Tabs, StatusBadge, Alert, Avatar, etc.) but Chat and Security pages use **zero** of them. Settings uses some but still duplicates error banners, loading spinners, and section cards 8-10x each. Extracting 6 new shared components would eliminate ~80% of the duplication.

---

## 1. Existing UI Library (What We Have)

| Component | Variants/Features | Used By |
|-----------|-------------------|---------|
| `Button` | primary, secondary, danger, ghost, success, warning, outline; sizes; icons | Settings (partial) |
| `Badge` | default, primary, success, warning, error, info; sizes | CronJobPanel only |
| `Card` | default, outlined, elevated; padding sizes | **Nobody** |
| `Modal` | title, size, closable; ModalFooter, ModalBody | CronJobPanel only |
| `Input` | label, error, helperText, fullWidth | Settings (partial) |
| `Form` | FormGroup, FormLabel, FormInput, FormSelect, FormTextarea, FormSection | Settings (partial) |
| `Toggle` | size, variant, label, description | Not audited |
| `Tabs` | TabList, TabTrigger, TabContent | Not audited |
| `StatusBadge` | active, running, stopped, error, idle, etc. | **Nobody in these 3 areas** |
| `Alert` | error, success, warning, info variants | **Nobody** |
| `Avatar` | sizes, fallback | **Nobody in these 3 areas** |
| `ScoreCard` | metric display | **Nobody** |

**Key finding:** Card, Alert, StatusBadge, and ScoreCard exist but have zero adoption in Chat, Settings, or Security.

---

## 2. Chat Components — Zero Library Integration

### Current State: All Custom

| Chat Component | Custom Buttons | Custom Badges | Custom Cards | Custom Status | Should Use |
|----------------|:-:|:-:|:-:|:-:|---|
| ChatPanel | retry-button | - | - | offline-banner, loading | Button, Alert |
| ChatMessage | toggle-raw-btn | skill-badge, task-badge, timing-badge | - | message-error | Button, Badge, Alert |
| ChatInput | send-button | - | - | error display | Button, Alert |
| ChatSidebar | new-chat-btn | - | - | - | Button, Input |
| ThreadPreview | - | - | button-as-card | - | Card |
| ThreadDetailPanel | scroll-to-bottom | - | - | offline-banner, loading | Button, Alert |
| QueueStatusBar | clear-all, cancel | source-badge | - | queue-spinner | Button, Badge |
| ChannelBadge | - | channel-badge (5 variants) | - | - | Badge |
| ChannelFilterBar | filter-chip (x5) | - | - | - | Button/ToggleGroup |
| TypingIndicator | - | - | - | typing-dots | (Specialized) |

**Impact:** 7 unique button styles, 5 unique badge styles — all built with custom CSS classes instead of using `Button` and `Badge` components.

### Specific Duplication Examples

```tsx
// CURRENT — ChatMessage.tsx (custom badge)
<span className="skill-badge">
  <span className="skill-badge-icon">S</span>
  {message.metadata.skillUsed}
</span>

// SHOULD BE
<Badge variant="primary" size="sm">S {message.metadata.skillUsed}</Badge>
```

```tsx
// CURRENT — ChatPanel.tsx (custom button)
<button className="retry-button" onClick={() => window.location.reload()}>Retry</button>

// SHOULD BE
<Button variant="primary" onClick={() => window.location.reload()}>Retry</Button>
```

---

## 3. Settings Components — Partial Library, Heavy Inline Duplication

### What's Good
Settings components **do** use `Button`, `Input`, `FormInput`, `FormLabel`, `FormSelect` from the UI library. CronJobPanel correctly uses `Modal` and `Badge`.

### What's Duplicated

#### Pattern A: Error/Success Banner (10+ duplicates)
Every integration tab rebuilds the same banner:
```tsx
// Appears in: GeneralTab, SlackTab, GoogleChatTab, TelegramTab, DiscordTab,
//             WhatsAppTab, CloudTab, RolesTab, SkillsTab, HeartbeatPanel, CronJobPanel
<div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 px-4 py-3 rounded-lg flex items-center gap-2">
  <AlertCircle className="w-5 h-5" />
  Error: {error}
</div>
```
**Note:** `Alert` component exists in UI library but is never used here.

#### Pattern B: Loading Spinner (8+ duplicates)
```tsx
// Appears in: GeneralTab, SlackTab, GoogleChatTab, TelegramTab, DiscordTab,
//             WhatsAppTab, RolesTab, SkillsTab, ApiKeysTab, CloudTab
<div className="flex flex-col items-center justify-center py-16">
  <div className="w-10 h-10 border-4 border-primary/20 border-t-primary rounded-full animate-spin mb-4" />
  <p className="text-text-secondary-dark">Loading...</p>
</div>
```

#### Pattern C: Section Card (8+ duplicates)
```tsx
// Appears in: GeneralTab, SlackTab, GoogleChatTab, TelegramTab, DiscordTab,
//             WhatsAppTab, RolesTab, SkillsTab, ApiKeysTab
<section className="bg-surface-dark border border-border-dark rounded-lg p-6">
  <h2 className="text-lg font-semibold mb-4">Title</h2>
  <div className="space-y-5">{/* content */}</div>
</section>
```
**Note:** `Card` component exists but is never used.

#### Pattern D: Connection Details List (6 duplicates)
```tsx
// Appears in: SlackTab, TelegramTab, DiscordTab, WhatsAppTab, GoogleChatTab, CloudTab
<div className="flex items-center justify-between py-2 border-b border-border-dark">
  <span className="text-sm text-text-secondary-dark">Label</span>
  <span className="text-sm font-medium">{value}</span>
</div>
```

#### Pattern E: Custom Modals (2 duplicates)
SkillsTab and RoleEditor build modals from scratch instead of using `Modal` component (which CronJobPanel uses correctly).

---

## 4. Security Components — Zero Library, Best Visual Design

### Current State: All Custom (But Well-Designed)

| Security Component | Custom Cards | Custom Badges | Custom Status | Should Use |
|--------------------|:-:|:-:|:-:|---|
| SecurityOverview | 3 summary cards | - | 3 status dots | Card, StatusBadge |
| SecurityPillarCard | pillar card | - | icon bg | Card |
| SecurityArchDiagram | agent boxes | approval states | pillar indicators | Card, Badge, StatusBadge |
| PtyIsolationMap | agent node cards | - | pulsing dots | Card, StatusBadge |
| ApprovalAuditLog | container card | outcome badges | filter buttons | Card, Badge, Button |
| DataSovereigntyReport | container card | - | status text | Card, StatusBadge |
| ComparisonStrip | comparison cards | - | - | Card |
| SecurityLandingSection | CTA card | - | - | Card |
| SecurityScoreWidget | score ring | score badge | - | ScoreCard |

### Specific Duplication: Expandable Section (3x)
PtyIsolationMap, ApprovalAuditLog, and DataSovereigntyReport all build the same expand/collapse pattern manually.

### Three Different Status Color Systems
```
System A (SecurityOverview): Record<string, string> mapping
System B (SecurityArchDiagram): Hardcoded per outcome
System C (ApprovalAuditLog): Object with className field
```
All three do the same thing differently. Should use `StatusBadge`.

---

## 5. Recommended New Shared Components

### Tier 1 — Extract Immediately (eliminates 25+ duplicates)

| Component | Replaces | Duplicate Count | Effort |
|-----------|----------|:---------------:|:------:|
| **AlertBanner** | All inline error/success/warning/info banners | 10+ | Low |
| **LoadingSpinner** | All inline spinner implementations | 8+ | Low |
| **SettingsSection** | All inline section cards with headers | 8+ | Low |

**AlertBanner** — wraps the existing `Alert` component or replaces it:
```tsx
<AlertBanner type="error" message={error} onClose={dismiss} />
<AlertBanner type="success" message="Connected to Slack" />
```

**LoadingSpinner** — standardized full-page loader:
```tsx
<LoadingSpinner message="Loading settings..." size="md" />
```

**SettingsSection** — replaces all `<section className="bg-surface-dark border...">`:
```tsx
<SettingsSection title="Connection" icon={Wifi}>
  {children}
</SettingsSection>
```

### Tier 2 — Extract Soon (eliminates 10+ duplicates)

| Component | Replaces | Duplicate Count | Effort |
|-----------|----------|:---------------:|:------:|
| **ConnectionDetailsCard** | Messenger tab connection details | 6 | Medium |
| **ExpandableSection** | Security expand/collapse patterns | 3 | Medium |
| **MetricCard** | SecurityOverview summary cards, Dashboard stats | 3+ | Medium |

### Tier 3 — Extract When Convenient

| Component | Replaces | Notes |
|-----------|----------|-------|
| **DataTable** | ApprovalAuditLog table, DataSovereigntyReport table | 2 components, medium effort |
| **ToggleGroup** | ChannelFilterBar filter chips | New pattern, useful elsewhere |
| **Textarea** | GoogleChatTab inline textarea | May already exist in Form.tsx |

---

## 6. Adoption Plan — Existing Components

These components **already exist** but need adoption:

| Existing Component | Current Users | Should Also Be Used By |
|--------------------|:------------:|------------------------|
| **Card** | 0 in scope | SecurityOverview (3x), PtyIsolationMap, ApprovalAuditLog, DataSovereigntyReport, ThreadPreview, all Settings section cards |
| **Alert** | 0 in scope | ChatPanel errors, ChatInput errors, ThreadDetailPanel errors, all Settings error banners |
| **Badge** | CronJobPanel | ChatMessage (skill/task/timing), QueueStatusBar (source), ChannelBadge, ApprovalAuditLog (outcomes), RolesTab (categories) |
| **StatusBadge** | 0 in scope | SecurityOverview status dots, PtyIsolationMap agent status, HeartbeatPanel agent status |
| **Modal** | CronJobPanel | SkillsTab custom modal, RoleEditor custom modal |
| **ScoreCard** | 0 in scope | SecurityScoreWidget |

---

## 7. Inconsistency Matrix

| Pattern | Chat | Settings | Security | UI Library |
|---------|------|----------|----------|:----------:|
| **Primary button** | `.send-button`, `.new-chat-btn` | `<Button variant="primary">` | None | `Button` |
| **Small action button** | `.toggle-raw-btn`, `.filter-chip` | `<Button size="sm">` | Inline `<button>` | `Button` |
| **Info badge** | `.skill-badge` (CSS) | `<Badge variant="info">` (rare) | Inline `<span>` | `Badge` |
| **Error display** | `.message-error` (CSS) | Inline `div.bg-rose-500/10` | None | `Alert` |
| **Card container** | Button-as-card | Inline `section.bg-surface-dark` | Inline `div.bg-surface-dark` | `Card` |
| **Loading state** | Custom CSS spinner | Inline border-spin div | None | (Missing) |
| **Status indicator** | `.orchestrator-offline-banner` | Inline span colors | 3 different systems | `StatusBadge` |

---

## 8. Metrics Summary

| Metric | Before (Current) | After (With Recommendations) |
|--------|:-:|:-:|
| Components with 0 UI library imports | 20 of 38 (53%) | ~5 of 38 (13%) |
| Duplicate error banner implementations | 10+ | 0 (use AlertBanner) |
| Duplicate loading spinners | 8+ | 0 (use LoadingSpinner) |
| Duplicate section card patterns | 8+ | 0 (use SettingsSection/Card) |
| Unique custom button styles | 7 (Chat alone) | 0 (use Button) |
| Unique custom badge styles | 10+ (across all) | 0 (use Badge) |
| Lines of duplicated styling | ~400+ | ~50 (component-specific overrides) |
| New shared components needed | - | 6 (Tier 1: 3, Tier 2: 3) |

---

## 9. Priority Recommendation

### Sprint A — Quick Wins (eliminate 25+ duplicates)
1. Create `AlertBanner`, `LoadingSpinner`, `SettingsSection`
2. Replace all Settings inline error banners with AlertBanner
3. Replace all Settings inline spinners with LoadingSpinner
4. Replace all Settings section cards with SettingsSection or Card

### Sprint B — Chat Integration (eliminate 12+ duplicates)
5. Replace Chat custom buttons with `Button` component
6. Replace Chat custom badges with `Badge` component
7. Replace Chat error displays with `Alert` component
8. Refactor ThreadPreview to use `Card`

### Sprint C — Security Standardization (eliminate 10+ duplicates)
9. Replace SecurityOverview cards with `Card` component
10. Replace approval badges with `Badge` component
11. Standardize status indicators to `StatusBadge`
12. Extract `ExpandableSection` for 3 Security components

### Sprint D — Advanced Extractions
13. Create `ConnectionDetailsCard` for 6 messenger tabs
14. Create `MetricCard` for Security + Dashboard
15. Create `DataTable` for audit logs
16. Consolidate custom modals in SkillsTab/RoleEditor to use `Modal`
