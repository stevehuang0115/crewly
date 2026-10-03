# Usage ledger durability, corrupt-store quarantine and ledger backfill

Status: implemented on `fix/usage-ledger-durability`

## Problem

On 2026-10-03 the owner's Mac ran out of disk (ENOSPC). The token ledger
`~/.crewly/token-usage.json` lost its whole history: `/api/system/usage` only
showed 2026-10-03, the file was 13 KB, and a backup from 2026-09-21 was 2.8 MB.

Two defects combined:

1. `TokenUsageService.flushToDisk` wrote the ledger with a plain
   `fs.writeFile`. That truncates the file first and then writes, so a full
   disk leaves a truncated (invalid) file behind.
2. `loadFromDisk` swallowed the JSON parse error and "started fresh". The
   next flush (every 5 minutes) then overwrote the truncated file with the new,
   nearly empty ledger. What was left of the old file was gone too.

The same "plain write + start fresh on a parse error" pattern exists in other
stores.

## Rules for a persistent JSON store

1. **Writes are atomic.** Write a temp file in the same directory, fsync it,
   rename it over the target (`atomicWriteFile` / `atomicWriteFileSync` in
   `backend/src/utils/file-io.utils.ts`). A failed write leaves the old file
   as it was and logs an error. A write never truncates the live file.
2. **A missing file means "start fresh".** Nothing else does.
3. **A file that exists but cannot be read or parsed is quarantined.** It is
   copied to `<file>.corrupt-<ISO timestamp>` and an error is logged. Only
   then may the store start empty and overwrite the original.
4. **If the copy fails** (the disk is still full, permissions), the store must
   not overwrite the original. The load throws `CorruptJsonFileError`
   (or the store records that it is blocked and refuses to write), and the
   next attempt tries the copy again.

Helpers (`file-io.utils.ts`):

| Helper | Purpose |
|---|---|
| `atomicWriteFile`, `atomicWriteJson` | existing: temp + fsync + rename, per-path lock |
| `atomicWriteFileSync` | new: the same for synchronous stores |
| `readJsonStore`, `readJsonStoreSync` | new: `missing` / `ok` / `quarantined`; throws `CorruptJsonFileError` when the quarantine copy fails |
| `quarantineCorruptFile`, `quarantineCorruptFileSync` | new: copy a bad file aside as `<file>.corrupt-<ts>` |
| `safeReadJson` | existing: still returns the default for a corrupt file after backing it up as `<file>.corrupt.<ts>`, but now **throws `CorruptJsonFileError` when the backup fails** instead of returning the default (which callers would then write over the only copy) |

## Token ledger

- `flushToDisk` uses `atomicWriteFile`. A failure is logged as an error and
  rethrown; the periodic flush logs it (it used to be silent).
- `loadFromDisk`:
  - missing file: start fresh;
  - invalid or unreadable file: copy aside to `token-usage.json.corrupt-<ts>`,
    log an error, start fresh;
  - copy fails: log an error and mark the ledger **blocked**. While blocked,
    `flushToDisk` first retries the copy. If the copy still fails it refuses
    to write, so the bad file is never overwritten before it has been moved
    aside.
- A flush before any load (a shutdown racing startup) loads first, so it can
  never replace a good file with an in-memory ledger that never read it.
- Sessions already in memory when the file is loaded now get the file's
  events merged in (they used to be skipped entirely).
- New events from Claude transcripts carry the transcript `messageId`, so
  later imports can dedupe by id.

## Other stores (audit)

Fixed (atomic write and quarantine on a bad file):

| Store | File | Why it matters |
|---|---|---|
| Token ledger | `~/.crewly/token-usage.json` | the incident; not rebuildable for in-process / Codex / Antigravity runs |
| Claude transcript cursors | `~/.crewly/claude-transcript-cursors.json` | starting fresh re-reads every transcript from byte 0 and double counts; also the map the backfill needs. After a quarantine the re-read skips turns the ledger already holds. |
| Codex rollout cursors | `codex-rollout-cursors.json` | same double-count risk (quarantined; the re-read is not yet deduped against the ledger) |
| Antigravity usage cursors | `antigravity-usage-cursors.json` | same (quarantined; the re-read is not yet deduped against the ledger) |
| Experiments | `<crewly home>/experiments.json` | owner's experiment cards; not rebuildable |
| Token caps | `usage-caps.json` | owner's caps and boosts; a silent reset removes the caps |
| Sub-agent message queue | `sub-agent-message-queue.json` | the only record of undelivered owner messages |
| Trace index | `traces/index.json` | the list of traces; the per-trace files survive but nothing lists them |
| Everything on `safeReadJson` / `modifyJsonFile` (message queue, decisions, ticket threads, ticket autopilot settings, task pool, requests / open items, …) | various | already atomic and backed up; now refuse to fall back when the backup itself fails |

Left as they are, and why, is listed in the PR description.

## Backfill

`POST /api/system/usage/backfill` (owner only).

Body:

```json
{ "from": "2026-09-01", "to": "2026-10-02", "dryRun": true, "ledgerFiles": ["/abs/path/token-usage.json.bak"] }
```

- `from` / `to`: local days, inclusive. Required.
- `dryRun`: defaults to **true**. Only `dryRun: false` changes the ledger.
- `ledgerFiles`: optional. Earlier copies of `token-usage.json` (a backup, a
  `.corrupt-<ts>` file that still parses). Their events in the range are merged.

Sources:

1. **Claude Code transcripts the transcript sync already attributed.** The
   transcript cursors map each transcript path to the Crewly session that
   owns it (`filePath` and `fileOffsets`). Only those files are read, so the
   owner's own Claude Code sessions and other tools never enter the ledger.
   Each file is read only up to the offset the live sync has consumed, so a
   turn the live sync has not reached yet is left for it to count.
2. **Ledger backups** passed in `ledgerFiles`.

Dedupe (exactly-once):

- transcript turns: by `message.id`, the same rule the live sync uses
  (synthetic all-zero usage lines skipped, first occurrence wins);
- against the ledger: by message id when the ledger event has one, otherwise
  by the event key `timestamp|input|cachedInput|output|model` (the same key
  `dropCrossSessionDuplicates` uses). The check is ledger-wide, not per
  session, so a turn never ends up in two sessions;
- backups: by the same event key.

Imported events are added with `TokenUsageService.importEvents`, which skips
the trace lookup and the session's current task (both belong to the present,
not to the day being rebuilt), then the ledger is flushed.

Response: per day and per source, how many events were added (or would be,
in a dry run), how many were already present, and which transcripts were
missing.

Limits:

- Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default);
  older days come back only from a ledger backup.
- In-process (DeepSeek), Codex and Antigravity usage has no transcript here;
  it comes back only from a ledger backup.
- Session cost overrides (`cursor.cost`) are not changed; they were never
  lost.
