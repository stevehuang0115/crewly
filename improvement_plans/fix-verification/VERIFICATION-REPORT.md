# Fix Verification Report — Chat Masking + Pin Favorites

**Auditor:** Ava (UX Designer, crewly-product-ava-member-u)
**Date:** 2026-03-26
**Method:** Playwright headless Chromium (1440x900)
**Target:** localhost:3457
**Screenshots:** `improvement_plans/fix-verification/`

---

## 1. Chat — JWT / Path / API Key Masking

**Status: PARTIAL FIX — message body masked, thread previews still leak**

### Message Detail Panel (Right Side)

| Data Type | Before Fix | After Fix | Status |
|-----------|:----------:|:---------:|:------:|
| File paths (`/Users/...`) | 94 raw paths | `[PATH_REDACTED]` × 34 | **FIXED** |
| JWT tokens (`eyJ...`) | 4 visible | 0 visible | **FIXED** |
| API keys (`sk-...`) | 0 | 0 | Clean |

**Screenshot evidence:** `01-chat-msg-0.png` — Messages now show `[Thread context file: [PATH_REDACTED]]` instead of raw paths like `/Users/yellowsunhy/.crewly/slack-threads/...`. The masking is clearly visible with styled badges.

### Thread List Previews (Left Side)

| Data Type | Count | Status |
|-----------|:-----:|:------:|
| JWT tokens in previews | 4 | **NOT FIXED** |
| Raw paths in previews | 62 | **NOT FIXED** |

**Root cause:** `segmentSensitiveData()` is applied to message rendering in the detail panel, but the **thread list preview text** (ThreadListPanel / ThreadPreview) does not pass through the same masking pipeline. The 4 JWT leaks and 62 path leaks all originate from the left-side thread preview snippets, not from the message body.

**Recommendation:** Apply `segmentSensitiveData()` to thread preview text in `ThreadPreview.tsx` or `ThreadListPanel.tsx` before rendering the truncated snippet.

---

## 2. Projects / Teams Cards — Pin/Unpin on Hover

### Teams Cards

**Status: PASS**
**Screenshots:** `02-team-card-default.png`, `02-team-card-hover.png`, `02-team-pin-btn.png`, `02-team-unpin-btn.png`

| Feature | Verified | Notes |
|---------|:--------:|-------|
| Pin icon appears on hover | YES | Thumbtack icon visible on card header |
| Button title | YES | `title="Pin to favorites"` |
| Click toggles to unpin | YES | After click, shows crossed-out thumbtack with `title` changing to unpin |
| ARIA accessible | YES | `aria-label="Pin to favorites"` |

### Projects Cards

**Status: PASS**
**Screenshots:** `02-project-card-hover.png`, `02-project-pin-btn.png`

| Feature | Verified | Notes |
|---------|:--------:|-------|
| Pin icon appears on hover | YES | Thumbtack icon next to "More options" (⋮) |
| Button title | YES | `title="Pin to favorites"` `aria-label="Pin to favorites"` |
| Two buttons on hover | YES | Pin + More options |

Both card types have consistent pin affordance: thumbtack icon, same title text, same hover-reveal pattern.

---

## 3. Nav Sidebar — Pinned Items in Work Group

**Status: NOT WORKING — pin button exists but nav doesn't display pinned items**

**Screenshots:** `03-nav-after-pin.png`, `03-nav-after-project-pin.png`

| Test | Result |
|------|--------|
| Click "Pin to favorites" on team card | Button toggles to unpin state ✅ |
| Click "Pin to favorites" on project card | Button toggles to unpin state ✅ |
| Nav shows PINNED section after pin | **NO** — nav unchanged |
| Pinned team name appears in WORK group | **NO** — only Dashboard/Projects/Teams |
| Pinned project name appears in WORK group | **NO** — only Dashboard/Projects/Teams |

**Nav after pinning (unchanged):**
```
WORK: Dashboard, Projects, Teams
COMMUNICATE: Chat
TOOLS: Marketplace, Schedules
SYSTEM: Security, Settings
```

**Assessment:** The pin/unpin toggle on cards is functional (state toggles, icon changes), but the Navigation component does not read or render the pinned state. Either:
- The pin state is saved (localStorage/API) but Navigation doesn't subscribe to it, or
- The pin state is only in component state and doesn't persist or propagate

---

## Summary

| Fix | Card UI | Data Logic | Nav Display | Overall |
|-----|:-------:|:----------:|:-----------:|:-------:|
| Chat masking (message body) | — | **FIXED** | — | **PASS** |
| Chat masking (thread previews) | — | **NOT FIXED** | — | **FAIL** |
| Pin button on Teams | **PASS** | Toggle works | NOT CONNECTED | **PARTIAL** |
| Pin button on Projects | **PASS** | Toggle works | NOT CONNECTED | **PARTIAL** |
| Nav pinned items | — | — | **NOT IMPL** | **FAIL** |

### Remaining Work

| # | Priority | Item | Effort |
|---|:--------:|------|:------:|
| 1 | **P1** | Apply `segmentSensitiveData()` to thread preview text (ThreadPreview/ThreadListPanel) | Small — same util, new call site |
| 2 | **P2** | Connect pin state to Navigation sidebar — render pinned Projects/Teams above Dashboard in WORK group | Medium — needs state management (localStorage or API) + Navigation subscription |
