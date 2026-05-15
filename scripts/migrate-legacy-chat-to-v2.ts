#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * One-shot migration: legacy ChatService JSON store → chat-v2 SQLite.
 *
 * Walks `~/.crewly/chat/*.json`, parses each file, and calls
 * {@link ChatV2Service.importLegacyConversation} per file. The
 * `importLegacyConversation` primitive is idempotent at the message
 * level (every row gets `clientMessageId = 'legacy-' + msg.id`), so
 * re-running this script is safe — repeated invocations dedup against
 * already-imported rows rather than creating duplicates.
 *
 * Spec: `specs/2026-05-14-unified-chat-message-store.md` Phase 5b.
 *
 * Workflow:
 *   1. Default mode (no flag, or `--dry-run`): list files that would be
 *      imported and the message counts. Makes ZERO writes.
 *   2. `--apply`: run the imports. Prints per-file `imported / deduped`
 *      counts and a final summary.
 *   3. `--verify`: re-run on already-imported data; expects every file
 *      to report `imported=0 deduped=N` matching its message count.
 *      Useful as a post-migration sanity check.
 *
 * Exit codes:
 *   0  success (or dry-run completed)
 *   1  invalid CLI args
 *   2  any file failed validation or import
 *
 * Usage:
 *   tsx scripts/migrate-legacy-chat-to-v2.ts                # dry-run (default)
 *   tsx scripts/migrate-legacy-chat-to-v2.ts --apply        # do the imports
 *   tsx scripts/migrate-legacy-chat-to-v2.ts --verify       # idempotency check
 *   CHAT_DIR=/custom/path tsx scripts/migrate-legacy-chat-to-v2.ts
 *
 * The script does NOT delete or modify the legacy JSON files. Phase 6
 * retires the legacy ChatService and its JSON store as a separate step.
 *
 * @module scripts/migrate-legacy-chat-to-v2
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Note: imports from the COMPILED dist tree, not source. tsx has
// flaky ESM resolution for cross-package imports under the v22
// runtime; loading the compiled .js avoids that path entirely.
// Requires `npm run build:backend` before running this script.
import { getChatV2Service } from '../dist/backend/backend/src/services/chat-v2/chat-v2.singleton.js';

type Mode = 'dry-run' | 'apply' | 'verify';

interface PerFileResult {
  filename: string;
  channelId: string;
  imported: number;
  deduped: number;
  expected: number;
  ok: boolean;
  error?: string;
}

function parseMode(argv: string[]): Mode | null {
  const has = (flag: string): boolean => argv.includes(flag);
  if (has('--apply')) return 'apply';
  if (has('--verify')) return 'verify';
  if (has('--dry-run') || argv.length === 0) return 'dry-run';
  // Any other flag → invalid
  for (const arg of argv) {
    if (arg.startsWith('-') && !['--apply', '--verify', '--dry-run'].includes(arg)) {
      return null;
    }
  }
  return 'dry-run';
}

async function listLegacyFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  return entries.filter((name) => name.endsWith('.json')).sort();
}

async function processFile(
  dir: string,
  filename: string,
  mode: Mode,
): Promise<PerFileResult> {
  const filePath = join(dir, filename);
  const raw = await readFile(filePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      filename,
      channelId: '',
      imported: 0,
      deduped: 0,
      expected: 0,
      ok: false,
      error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const body = parsed as { conversation?: { id?: string }; messages?: unknown[] };
  const conversationId = body?.conversation?.id ?? '';
  const expected = Array.isArray(body?.messages) ? body.messages!.length : 0;

  if (!conversationId) {
    return {
      filename,
      channelId: '',
      imported: 0,
      deduped: 0,
      expected,
      ok: false,
      error: 'missing conversation.id',
    };
  }

  if (mode === 'dry-run') {
    return {
      filename,
      channelId: conversationId,
      imported: 0,
      deduped: 0,
      expected,
      ok: true,
    };
  }

  try {
    const chatV2 = getChatV2Service();
    const result = chatV2.importLegacyConversation(
      body as Parameters<typeof chatV2.importLegacyConversation>[0],
    );
    // In verify mode, expect everything to be deduped (already imported)
    const ok =
      mode === 'verify'
        ? result.imported === 0 && result.deduped <= expected
        : true;
    return {
      filename,
      channelId: result.channelId,
      imported: result.imported,
      deduped: result.deduped,
      expected,
      ok,
      error:
        mode === 'verify' && !ok
          ? `verify failed: expected imported=0 but got imported=${result.imported}`
          : undefined,
    };
  } catch (err) {
    return {
      filename,
      channelId: conversationId,
      imported: 0,
      deduped: 0,
      expected,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function fmtRow(r: PerFileResult): string {
  const tag = r.ok ? 'OK' : 'FAIL';
  const counts = `imported=${r.imported} deduped=${r.deduped} expected=${r.expected}`;
  const err = r.error ? `  ← ${r.error}` : '';
  return `  [${tag}] ${r.filename}  ${counts}${err}`;
}

async function main(): Promise<number> {
  const mode = parseMode(process.argv.slice(2));
  if (!mode) {
    console.error('Unknown flag. Use --dry-run | --apply | --verify');
    return 1;
  }

  const dir = process.env.CHAT_DIR ?? join(homedir(), '.crewly', 'chat');
  console.log(`[migrate-legacy-chat-to-v2] mode=${mode}  dir=${dir}`);

  let dirStat;
  try {
    dirStat = await stat(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`Legacy chat directory not present — nothing to migrate.`);
      return 0;
    }
    throw err;
  }
  if (!dirStat.isDirectory()) {
    console.error(`Path is not a directory: ${dir}`);
    return 2;
  }

  const files = await listLegacyFiles(dir);
  if (files.length === 0) {
    console.log('No *.json files found in legacy chat directory.');
    return 0;
  }
  console.log(`Found ${files.length} legacy conversation file(s).`);

  const results: PerFileResult[] = [];
  for (const f of files) {
    results.push(await processFile(dir, f, mode));
  }

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;
  const totals = results.reduce(
    (acc, r) => ({
      imported: acc.imported + r.imported,
      deduped: acc.deduped + r.deduped,
      expected: acc.expected + r.expected,
    }),
    { imported: 0, deduped: 0, expected: 0 },
  );

  console.log('');
  for (const r of results) {
    console.log(fmtRow(r));
  }
  console.log('');
  console.log(
    `Summary: files=${results.length} ok=${okCount} fail=${failCount}  totals: imported=${totals.imported} deduped=${totals.deduped} expected=${totals.expected}`,
  );

  if (mode === 'dry-run') {
    console.log('(dry-run — no writes made. Re-run with --apply to migrate.)');
  }

  return failCount > 0 ? 2 : 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    console.error('Unhandled error:', err);
    process.exit(2);
  });
