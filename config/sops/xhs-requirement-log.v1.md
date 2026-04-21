# XHS Requirement Log (Spec-In → Result-Out)

> **Authority**: Steve (Founder) policy directive, 2026-04-17.
> **Effective**: 2026-04-17 — PERMANENT (supersedes every "check iriss-air / scrape / connect" pattern).
> **Scope**: Every XHS data need. No exceptions.
> **Owner**: Grace (Distribution & Growth). Co-maintainers: Ella (TL), Luna (Content Strategist).
> **Upstream counterparty**: iriss-air team (via `crewly-orc` → Rex `rednote-team-rex-*`).
> **Related policy**: `sop/xhs-remote-only-policy-v2.1.md`, `sop/POLICY-manual-execution-only.md`.

---

## 0. Hard rules (non-negotiable)

1. **NO local Chrome / iPad / Playwright / Patchright / CDP / MCP touches XHS.** Any URL under `*.xiaohongshu.com` from a local tool is a policy breach. This includes the `remote-browser` skill pointed at iriss-air when its own extension is `connected=false` (proxy can fall back to local Chrome — confirmed 2026-04-17T14:13Z breach).
2. **Zero iriss-air internal-state monitoring.** Don't poll `/api/browser/status`, Chrome CDP port 9222, iPad availability, etc. Those are iriss-air's problems.
3. **Only two legitimate interactions with iriss-air**:
   - Send a **Requirement Spec** (this log).
   - Receive a **Delivery** and run the **Verification Checklist** (§5).
4. **No workarounds** (VNC, stealth browser, agent-browser to iriss-air, Cloud Relay direct, etc.). If the spec-in/result-out channel is broken, file a Blocker entry and hand back to Ella.

---

## 1. What a Requirement Spec MUST contain

Every spec sent to iriss-air (via `send-message` → `crewly-orc`) must include these **10 fields** (v1.2 adds `job_size`). Anything missing → treated as ambiguous and NACK'd on return.

| # | Field | Format | Notes |
|---|-------|--------|-------|
| 1 | `spec_id` | `XHS-REQ-YYYYMMDD-HHMM-<slug>` | Unique, monotonically increasing. Example: `XHS-REQ-20260417-1308-daily-comments` |
| 2 | `origin` | Marketing role + task reference | Who asked and why (which task / cron) |
| 3 | `priority` | `P0a / P0b / P1 / P2` | **v1.2 split**: P0a = ship today, fast job; P0b = ship today, heavy job; P1 = within 24h; P2 = within this week. `priority` MUST be consistent with `job_size` (see field 10). |
| 4 | `window` | ISO8601 range | Hard time window the data must cover (e.g. `2026-04-10T13:08Z / 2026-04-17T13:08Z`) |
| 5 | `delta_anchor` | ISO8601 timestamp OR `none` | "Only new since X" anchor. If `none`, full window |
| 6 | `targets` | Post IDs or post titles (roster) | Explicit list — do NOT say "all active posts" without enumerating |
| 7 | `fields` | Schema list | The per-record columns you need (see §2 catalogue) |
| 8 | `deliverable_path` | Local path under `ops/marketing/tmp/` | Where iriss-air's `reply-remote` should inline-land the file |
| 9 | `policy_tags` | List | e.g. `data-collection-only`, `no-reply`, `dedupe-on=...` |
| **10** | **`job_size`** (v1.2) | **`fast-poll` \| `full-scrape`** | **Drives SLA routing in §3.** `fast-poll` = ≤ 4 targets AND no comments-scroll (headline metrics / spot checks / ban-signal). `full-scrape` = ≥ 5 targets OR any comments-scroll OR account-snapshot. Mismatch with `priority` (e.g. P0a + full-scrape) is rejected at dispatch. |

### Priority × job_size matrix (reference)

| `job_size` | Allowed `priority` | SLA (see §3) | Typical case |
|------------|--------------------|--------------|--------------|
| `fast-poll` | `P0a`, `P1`, `P2` | P0a: 20 min; P1: 4 h; P2: same day | Risk-signal check, one-post metric pull, "did this note go viral yet?" |
| `full-scrape` | `P0b`, `P1`, `P2` | P0b: 90–120 min; P1: 4 h; P2: same day | Cron #10 daily comment sweep, weekly account snapshot, 11-post delta roster |

### Spec template (copy when issuing a new request) — v1.2

```markdown
[TASK from <your-session> — <ISO8601 UTC>]

spec_id: XHS-REQ-YYYYMMDD-HHMM-<slug>
priority: P0a|P0b|P1|P2
job_size: fast-poll|full-scrape           # v1.2 — REQUIRED; drives SLA routing
origin:   <role> / <task-or-cron-ref>

window:        <startISO> / <endISO>
delta_anchor:  <ISO or "none">
targets:
  - <post_title_or_id>
  - <post_title_or_id>
  ...
fields: [<from §2 catalogue>]

deliverable_path (local landing):
  /Users/yellowsunhy/.../ops/marketing/tmp/<filename>.md
deliverable_path (iriss-air):
  /Users/irisran/projects/rednote-team/tmp/<same-filename>.md

policy_tags: [data-collection-only, no-reply, dedupe-on=(post_id,commenter_username,comment_date)]

On NO-NEW data, reply with an explicit "NO NEW <scope>" confirmation + dispatch id.
On partial failure (nav-blocked post, etc.), enumerate which targets failed and why.
DO NOT fall back to local scraping. If iPad/rednote-reader is down, report and stop.
```

---

## 2. Field-schema catalogue (what to put in `fields`)

Pick exactly the columns you need — don't over-ask.

### 2.1 Comment scrape (`kind: comments`)
```
commenter_username, commenter_relation (follower|friend|none|unknown),
comment_date (ISO8601), comment_body,
parent_post_title (or parent_post_id),
is_reply_to_steve (bool), has_unread_flag (bool),
parent_comment_id (for threaded replies, optional)
```

### 2.2 Post metrics (`kind: post-metrics`)
```
post_id, post_title, published_date, impressions, likes, saves,
comments_count, new_followers (if attributable), ces_score (if computed)
```

### 2.3 Account snapshot (`kind: account-snapshot`)
```
snapshot_time (ISO), follower_count, total_likes, total_saves, posts_visible,
verified_status, banner_changed (bool)
```

### 2.4 Competitor / trending (`kind: competitor`)
```
account_handle, topic, post_title, likes, comments, saves, posted_at,
content_hook (1 sentence), observed_pattern
```

### 2.5 DM / private inbox (`kind: dms`) — *only if Steve authorises*
```
sender_username, sender_relation, received_at, body, is_unread, thread_id
```

### 2.6 Ban / risk signals (`kind: risk-signal`)
```
signal_type (shadowban|rate-limit|captcha|login-wall|geo-block),
post_affected, observed_at, evidence_screenshot_path
```

---

## 3. Dispatch mechanics (spec → iriss-air)

1. **Write the spec** using template above. Save a dispatch log to `ops/marketing/tmp/xhs-scrape-dispatch-<ISO>.md` (precedent: we've been doing this since 2026-04-14).
2. **Create placeholder**: `ops/marketing/tmp/<deliverable-filename>.md`.
   - **Required** (v1.1): the placeholder MUST contain the literal string `PLACEHOLDER — DO NOT VERIFY` in its first 5 lines. This is a fail-fast signal for the verification checklist (§5.1).
   - The placeholder should also carry: status header `⏳ PENDING`, the `spec_id`, the dispatch time, and the expected iriss-air-side path.
3. **Dispatch** via the `send-message` skill → `crewly-orc` on iriss-air. Body = the spec template body (§1).
4. **Update the Active Register** (§4) with an `OPEN` row, including the dispatch time (this becomes the SLA anchor).
5. **Do NOT poll** iriss-air. **Calibrated SLA (v1.2 — tiered, approved by Ella TL 2026-04-17)**:

   | Priority × job_size | Early-warning | SLA (hard breach) | Notes |
   |---|---|---|---|
   | **P0a** + `fast-poll` | 10 min | **20 min** | <5 targets AND no comments-scroll. Risk-signal, single-post metric, spot check. |
   | **P0b** + `full-scrape` | 90 min | **120 min** | ≥5 targets OR comments-scroll OR account-snapshot. Cron #10 daily sweeps, 11-post roster. |
   | **P1** (either `job_size`) | 2 h | **4 h** | Same-day-ish, not urgent. |
   | **P2** (either `job_size`) | noon next day | **end of same operating day** | Weekly/monthly batch work. |

   - **Early-warning** = log a note in the register row ("approaching SLA"), do nothing else — **no probe to iriss-air**.
   - **Hard breach** = file a `BLOCKED: no-ack` entry and escalate to Ella. Still no probe.
   - **Mismatch rejection**: if `priority=P0a` but `job_size=full-scrape` (or vice versa), verification treats the spec as malformed and marks `BLOCKED: malformed-spec`. Re-dispatch with corrected pairing.
   - **Back-compat**: legacy rows recorded with flat `P0` stay valid; promote them to `P0a`/`P0b` at the next scrub pass (no emergency re-dispatch required).

---

## 4. Active Register

> **Update rule**: one row per `spec_id`. States: `OPEN → DELIVERED → VERIFIED → ARCHIVED`, or `BLOCKED / CANCELLED`. Move ARCHIVED rows to §7 weekly.

| spec_id | Origin | Priority | Issued (UTC) | Window | Expected Landing Path | State | Delivered @ | Verified @ | Notes |
|---------|--------|----------|--------------|--------|-----------------------|-------|-------------|------------|-------|
| XHS-REQ-20260417-0028-daily-comments | Grace / Cron #10a | P1 | 2026-04-17 00:29 | 7d rolling | `tmp/xhs-raw-comments-2026-04-17.md` | **DELIVERED** (superseded) | ~00:40 | pending | See `tmp/xhs-raw-comments-2026-04-17.md` — earliest of today's 5 dispatches. |
| XHS-REQ-20260417-0050-daily-comments | Grace / Cron #10a | P1 | 2026-04-17 00:51 | 7d explicit | `tmp/xhs-raw-comments-2026-04-17T0050Z.md` | **DELIVERED** (superseded) | ~01:05 | pending | Superseded by 0306Z full pull. |
| XHS-REQ-20260417-0306-daily-comments | Grace / Cron #10a | P1 | 2026-04-17 03:06 | delta since 14:00 PT | `tmp/xhs-raw-comments-2026-04-17T0306Z.md` | **DELIVERED** | ~03:25 | **VERIFIED** by Mila (see `reports/2026-04-17-xhs-evening-reply-package-mila.md`) | 20 KB body; largest comment set today. |
| XHS-REQ-20260417-1248-daily-comments | Grace / Cron #10b | P1 | 2026-04-17 12:48 | delta since 03:06Z | `tmp/xhs-raw-comments-2026-04-17T1248Z.md` | **DELIVERED** (per orc 14:40Z; iriss-air-side) | ~14:10Z (iriss-air-side completion) | pending local-file verification | Original dispatch hit "Rex down 1/1". Rex came back, full-scrape ran ~80min (03:06Z→14:10Z window). Used as authoritative upstream source for the 13:08Z derivative output. No local file landed yet — awaiting iriss-air re-send or treating 1308Z as the sufficient VERIFIED superset. |
| XHS-REQ-20260417-1308-daily-comments | Grace / Cron #10a | **P0b** (promoted from legacy P0 under v1.2; job_size=`full-scrape`, 11 targets + comments-scroll) | 2026-04-17 13:09 | delta since 12:48Z (fallback: 7d) | `tmp/xhs-raw-comments-2026-04-17T1308Z.md` | **✅ VERIFIED** | 2026-04-17 14:39Z (after re-send — original 14:15Z attempt truncated 4,644B → 2,031B in transport) | 2026-04-17 14:42Z | All §5 layers PASS: early-exit (placeholder gone, size 5,211B > 2,223B placeholder, mtime 14:40Z > dispatch+60s) ✅; envelope (spec_id matches, source declared as rednote-reader iPad Accessibility API / 非 Chrome/9222) ✅; scope (delta 03:06Z→13:08Z honoured; all 11 posts enumerated; post #11 retry succeeded) ✅; records (3 new comments, all mandatory fields present, dedup key unique) ✅; policy (no replies/cookies/tokens) ✅. **Business verdict**: NO NEW COMMENTS vs 12:48Z run — the 3 delta comments are already in the 12:48Z output. Transport truncation bug logged; drove the §5.1 canary add-on. **v1.2 SLA analysis**: under P0b 120min hard-breach clock, delivery at 14:39Z (90 min after 13:09Z dispatch) = within SLA (would have hit "early-warning at 90min" right as delivery landed, no breach). This single case validated the tiered SLA choice. |

**Priority backlog (not yet dispatched)**: none. Cron #10a / #10b today are absorbed by the 1308Z dispatch. New dispatches only on next Cron fire or Ella override.

---

## 5. Verification Checklist (when iriss-air delivers)

Before marking a delivery `VERIFIED`, run every check. Any fail → NACK back to iriss-air with the failing row.

### 5.1 Envelope (metadata) — v1.1 additions in bold

**Early-exit (v1.1)** — run these FIRST and fail-fast:

1. **Fail-fast grep**: if the file's first 5 lines contain the literal string `PLACEHOLDER — DO NOT VERIFY`, immediately return `NOT DELIVERED`. Do not run any downstream check. (Protects against false-positive ACK of unchanged placeholder.)
2. **Size comparator**: if `current_size <= placeholder_size_at_dispatch` (recorded in the register row at §4), return `NOT DELIVERED`.
3. **mtime comparator**: if `file_mtime <= dispatch_time + 60s`, return `NOT DELIVERED` (delivery would have required iriss-air to overwrite the placeholder).

**Transport-integrity canary (v1.1, added 2026-04-17 after XHS-REQ-20260417-1308 transport bug)** — when the delivery header declares an upstream size (e.g. `iriss-air side: 4644 bytes`), compare it to `local_size`. If `|local_size - upstream_size| > 128 bytes`, treat as transport-truncation suspect → do NOT mark `VERIFIED`; request iriss-air re-send via single-message (not inline-split) and log as `TRUNCATED`. Root cause of 2026-04-17 truncation: Option-1 inline-split transport landed 2,031B of a 4,644B payload. Re-send via fresh single-message inline payload succeeded.

Only if all three early-exit checks pass, proceed to the original envelope checks:

- [ ] File landed at the exact `deliverable_path` from the spec (§1 field 8).
- [ ] File header contains the originating `spec_id` (§1 field 1).
- [ ] Timestamp in header is within ±30 min of dispatch time (sanity).
- [ ] Source tool declared (`rednote-reader` on iriss-air — NOT `Chrome`, `Playwright`, `local`).
- [ ] (v1.1) File does NOT still contain `PLACEHOLDER — DO NOT VERIFY` anywhere (defensive — catches partial overwrites where delivery appended instead of replaced).

### 5.2 Scope compliance
- [ ] Window matches (§1 field 4) — reject if any record falls outside.
- [ ] Delta anchor respected — no duplicates of records whose `comment_date < delta_anchor`.
- [ ] All `targets` (§1 field 6) either appear OR are explicitly listed as "failed/nav-blocked" with reason.
- [ ] Unrequested targets are NOT present (iriss-air did not silently expand scope).

### 5.3 Record integrity
- [ ] Every row has every required `field` (§2) — no blanks in required columns.
- [ ] `comment_date` parseable ISO8601; not in the future.
- [ ] `is_reply_to_steve` is a real bool (not "maybe" / empty string).
- [ ] Dedupe key `(post_id, commenter_username, comment_date)` is unique within file.
- [ ] UTF-8 clean — no mojibake on Chinese text; emoji preserved.

### 5.4 Policy compliance
- [ ] No reply-bodies, no like-actions, no auth tokens, no cookies in the delivery.
- [ ] No screenshots outside the `risk-signal` schema (§2.6).
- [ ] `policy_tags` echoed back in the delivery header.
- [ ] If `NO NEW <scope>`: delivery is a single-line confirmation matching spec_id — NO stub rows.

### 5.5 Sign-off
- [ ] Register row moved to `VERIFIED` with a timestamp.
- [ ] If comments delivered → spawn downstream `analyze + draft replies` task. That task is **local-allowed** (drafting is not interaction).
- [ ] If metrics delivered → update `reports/xhs-data-tracking-2026-04.md`.
- [ ] If risk-signal → immediate ping to Ella + Steve (Slack D0AC7NF5N7L).

---

## 6. Escalation / Blocker matrix

| Symptom | Owner | Action |
|---------|-------|--------|
| No ACK from `crewly-orc` within SLA | Grace | Mark register `BLOCKED: no-ack`. Notify Ella. Do **not** re-dispatch in <10 min (prevents flooding Rex). |
| iriss-air reports `rednote-reader` failure | iriss-air team | Register `BLOCKED: upstream-failure`. Do not suggest workarounds. Wait. |
| Delivery fails §5 checks | Grace | NACK with specific failing check. Register stays `DELIVERED` (not VERIFIED). Await re-delivery. |
| Login wall / captcha / shadowban signal | Grace | File as `kind: risk-signal`, ping Steve. Never attempt local login. |
| Anyone requests local Chrome/iPad/Playwright touching XHS | Grace | **Refuse.** Quote this doc §0. File the request as `CANCELLED: policy-breach-attempt` for audit. |

---

## 7. Archive (moved weekly from §4)

*Rows older than the current operating week land here. Next archive pass: Fri 16:00 during Cron #7 weekly report.*

---

## 8. Change log

| Version | Date | Author | Change |
|---------|------|--------|--------|
| v1.0 | 2026-04-17 | Grace | Initial draft after Steve's "spec-in / result-out" directive and the 14:13Z proxy-fallback breach. Consolidates ad-hoc dispatch pattern (2026-04-14 → today) into a formal register + verification checklist. |
| v1.1 | 2026-04-17 | Grace (on Ella TL sign-off) | **SLA recalibration + checklist tightening**. (a) §3 P0 SLA raised from 20 min → 90 min based on observed Rex ~80 min full-scrape runtime (prevents false breach reports on compliant-but-slow jobs). (b) §3 placeholder template now REQUIRES the literal `PLACEHOLDER — DO NOT VERIFY` string in first 5 lines. (c) §5.1 three early-exit checks added (PLACEHOLDER-string grep, size comparator vs placeholder_size_at_dispatch, mtime comparator vs dispatch_time+60s). Triggered by first live test (XHS-REQ-20260417-1308-daily-comments) where v1.0 checklist correctly flagged the placeholder but would have taken longer without a fail-fast signal. |
| v1.1 (addendum) | 2026-04-17 | Grace (on orc request) | **Transport-integrity canary** added to §5.1. Trigger: the 14:15Z Option-1 inline-split delivery for XHS-REQ-20260417-1308 landed truncated (2,031B local vs 4,644B upstream). Canary spec: if delivery header declares an upstream size and `\|local_size − upstream_size\| > 128 B`, mark `TRUNCATED` and request re-send via single-message (not inline-split). 14:39Z re-send succeeded — verification passed. |
| **v1.2** | **2026-04-17** | **Grace (on Ella TL sign-off)** | **Tiered SLA — approved.** (a) §1 spec template gains a new REQUIRED field #10 `job_size` with two values: `fast-poll` or `full-scrape`. Selection rule: `fast-poll` = <5 targets AND no comments-scroll; `full-scrape` = ≥5 targets OR comments-scroll OR account-snapshot. (b) §1 `priority` enum split from `P0/P1/P2` → `P0a/P0b/P1/P2`, with a mandatory priority × job_size consistency rule. P0a pairs with fast-poll; P0b pairs with full-scrape. (c) §3 SLA table rewritten as a 4-row matrix with separate early-warning and hard-breach thresholds. Flat v1.1 `P0 ≤ 90 min` is retired; replaced by P0a ≤ 20 min and P0b ≤ 120 min. (d) Mismatch rule added: a spec whose `priority` / `job_size` pairing is inconsistent is NACK'd as `BLOCKED: malformed-spec`. (e) Back-compat: legacy rows recorded with flat `P0` stay valid and are promoted at the next scrub pass. Closes the SOP baseline for spec-in/result-out. |
| **v1.2 candidate** | *pending Ella ruling* | (orc suggestion, 2026-04-17) | **Tiered SLA proposal**: split P0 into fast-poll (<5 posts) = 20 min and full-scrape (all posts + comments scroll) = 90–120 min. Rationale: single P0 SLA can't fit both lightweight and heavyweight jobs without either over-reporting breach on heavy jobs (v1.0 problem) or under-reporting on light ones (v1.1 risk). Requires adding a `job_size` field to §1 spec template and a P0a/P0b split in §3. Decision deferred to Ella's next SOP review. |
