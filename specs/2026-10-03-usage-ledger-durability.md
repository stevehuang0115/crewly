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
3. **A file that does not parse (or fails the store's shape check) is
   quarantined.** It is copied to `<file>.corrupt-<ISO timestamp>` and an
   error is logged. Only then may the store start empty and overwrite the
   original. Every quarantine and `safeReadJson` backup uses this one suffix.
3a. **A read error other than ENOENT (EMFILE, EIO, EACCES…) is not
   corruption.** The file may be good, so it is never quarantined: the read
   throws, and the store never writes over it unread: it reads again before
   its next write and merges what it finds (token ledger, token caps, both
   message queues), or simply retries the read and writes nothing meanwhile
   (cursors, experiments, trace index, cron). Only a file that then fails to
   parse is copied aside.
3b. **One bad store never stops the others.** Cron evaluates and
   recalculates each store (global, each team) in its own try/catch, and the
   backend always starts the cron loop even if the boot recalculation fails.
4. **If the copy fails** (the disk is still full, permissions), the store must
   not overwrite the original. The load throws `CorruptJsonFileError`
   (or the store records that it is blocked and refuses to write), and the
   next attempt tries the copy again.

Helpers (`file-io.utils.ts`):

| Helper | Purpose |
|---|---|
| `atomicWriteFile`, `atomicWriteJson` | existing: temp + fsync + rename, per-path lock |
| `atomicWriteFileSync` | new: the same for synchronous stores |
| `readJsonStore`, `readJsonStoreSync` | new: `missing` / `ok` / `quarantined`; throws `CorruptJsonFileError` when the quarantine copy fails, and rethrows any read error but ENOENT |
| `quarantineCorruptFile`, `quarantineCorruptFileSync` | new: copy a bad file aside as `<file>.corrupt-<ts>` |
| `safeReadJson` | existing: still returns the default for a corrupt file after backing it up (now as `<file>.corrupt-<ts>`), but **throws `CorruptJsonFileError` when the backup fails** instead of returning the default (which callers would then write over the only copy) |

## Token ledger

- `flushToDisk` uses `atomicWriteFile`. A failure is logged as an error and
  rethrown; the periodic flush logs it (it used to be silent).
- `loadFromDisk`:
  - missing file: start fresh;
  - invalid file: copy aside to `token-usage.json.corrupt-<ts>`, log an
    error, start fresh;
  - the copy fails, or the file cannot be read (EMFILE, EIO…): log an error
    and mark the ledger **blocked**. While blocked, `flushToDisk` first loads
    again (a good file is merged, a bad one set aside) and refuses to write
    until that works, so the file is never overwritten unread.
- A flush before any load (a shutdown racing startup) loads first, so it can
  never replace a good file with an in-memory ledger that never read it.
- Sessions already in memory when the file is loaded now get the file's
  events merged in, in time order (they used to be skipped entirely).
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
| Token caps | `usage-caps.json` | owner's caps and boosts; a silent reset removes the caps. After an unreadable start the service re-reads the file on its tick and before any write, and merges it (newer config wins, boosts union, same-day notices combine). |
| Sub-agent message queue | `sub-agent-message-queue.json` | the only record of undelivered owner messages; an unreadable file is re-read and merged on the next save |
| Trace index | `traces/index.json` | the list of traces; the per-trace files survive but nothing lists them |
| OKR missions and key results (writes only) | `missions/<id>.json`, KR files | owner-approved OKRs; plain `writeFile` replaced by `atomicWriteFile`. Loads unchanged. |
| Orchestrator message queue | `queue/message-queue.json` | a valid file of an unknown shape is copied aside before the next persist; an unreadable one is re-read before the next persist and merged (queue, history, counters) |
| Cron tasks | `teams/<id>/cron-tasks.json`, global store | owner schedules; atomic writes; corrupt store copied aside once; EMFILE or a failed copy throws so no save overwrites it, and only that store is skipped |
| Slack team channels / agent identities / cloud config | their JSON files | a failed load is no longer cached forever |
| Everything else on `safeReadJson` / `modifyJsonFile` (decisions, ticket threads, ticket autopilot settings, task pool, requests / open items, …) | various | already atomic; a parse error is backed up before the default is returned, and now they refuse to fall back when that backup fails. They do not check the shape of valid JSON. |

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
  Each must be a regular file under 200 MB named `*.json`, `*.corrupt-*`,
  `*.corrupt.*` or `*.bak-*`. Anything else (wrong name, missing, a
  directory, too big, unreadable, not JSON, not an array) gets the same
  fixed error, `not a usable ledger file`, so the response never quotes file
  contents and does not say which check failed.

Sources:

1. **Claude Code transcripts the transcript sync already attributed.** The
   transcript cursors map each transcript path to the Crewly session that
   owns it (`filePath` and `fileOffsets`). Only those files are read, so the
   owner's own Claude Code sessions and other tools never enter the ledger.
   Each file is read only up to the offset the live sync has consumed, so a
   turn the live sync has not reached yet is left for it to count.
2. **Ledger backups** passed in `ledgerFiles`.

Dedupe (exactly-once):

- after a lost cursor file the live sync checks the ledger for each turn
  until one pass has read every registered session's transcript, then stops;
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
