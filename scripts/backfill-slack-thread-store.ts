/**
 * Backfill orchestrator replies into `~/.crewly/slack-threads/{ch}/{ts}.md`
 * by reading them from the chat-v2 database.
 *
 * Background: prior to the PR that added step 4 of `recordSlackReplyBookkeeping`
 * (slack.controller.ts), agent replies sent via `/api/slack/send` were
 * persisted to chat-v2 but never appended to the slack-thread .md store.
 * On session-restart, orc reads the .md file (not chat-v2) and concludes
 * "no one replied" → re-replies to everything.
 *
 * This script reads the canonical reply history from chat-v2 and appends
 * any missing `**Crewly** (...)` entries onto the corresponding .md file.
 * It is idempotent — runs only insert lines that aren't already present
 * (matched by content hash).
 *
 * Usage:
 *   npx tsx scripts/backfill-slack-thread-store.ts             # dry-run
 *   npx tsx scripts/backfill-slack-thread-store.ts --apply     # write
 *   npx tsx scripts/backfill-slack-thread-store.ts --apply --thread 1778859267.970399
 */

import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

const apply = process.argv.includes('--apply');
const threadFilter = (() => {
  const idx = process.argv.indexOf('--thread');
  return idx >= 0 ? process.argv[idx + 1] : null;
})();

const CREWLY_HOME = path.join(os.homedir(), '.crewly');
const CHAT_DB = path.join(CREWLY_HOME, 'chat.db');
const SLACK_THREADS_DIR = path.join(CREWLY_HOME, 'slack-threads');

interface AgentMessage {
  content: string;
  createdAt: number; // epoch ms
  channelId: string; // chat-v2 conversation id, e.g. slack-D0AC7NF5N7L-1778859267-970399
}

function chatChannelIdToSlackParts(chatChannelId: string): { slackChannel: string; threadTs: string } | null {
  // Pattern: slack-{slackChannel}-{epoch}-{decimals}
  // OR    : slack-{slackChannel}-{epoch}.{decimals}-msg-{...}  (thread-reply form)
  const stripped = chatChannelId.replace(/-msg-\d+\.\d+$/, '');
  const m = stripped.match(/^slack-(.+)-(\d+)[.-](\d+)$/);
  if (!m) return null;
  const [, slackChannel, t1, t2] = m;
  return { slackChannel, threadTs: `${t1}.${t2}` };
}

function formatEntry(content: string, ts: Date): string {
  const tsStr = ts.toISOString().replace('T', ' ').slice(0, 16);
  return `\n**Crewly** (${tsStr}):\n${content}\n`;
}

async function main() {
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  if (threadFilter) console.log(`Thread filter: ${threadFilter}`);

  const db = new Database(CHAT_DB, { readonly: true });

  // chat-v2 channels for Slack threads have channel.metadata.legacyConversationId
  // formatted as `slack-{channelId}-{ts}`. The chat_channels table's `id` is the
  // chat-v2 internal id, distinct from the legacy conversation id. We need to
  // pull the agent messages then group by the original conversation id.
  // For Slack-sourced channels the chat_channels.id IS the legacy
  // conversation id (`slack-{channelId}-{tsWithHyphen}`); chat-v2's
  // `ensureChannelForLegacyConversation` writes the legacy id as the
  // primary key directly. See chat-v2.service.ts.
  const rows = db.prepare(`
    SELECT m.content, m.created_at as createdAt, c.id as channelId
    FROM chat_messages m
    JOIN chat_channels c ON c.id = m.channel_id
    WHERE m.sender_type = 'agent'
      AND c.id LIKE 'slack-%'
    ORDER BY m.created_at ASC
  `).all() as AgentMessage[];

  // Group by slack thread
  const byThread = new Map<string, AgentMessage[]>();
  for (const row of rows) {
    const parts = chatChannelIdToSlackParts(row.channelId);
    if (!parts) continue;
    if (threadFilter && parts.threadTs !== threadFilter) continue;
    const key = `${parts.slackChannel}/${parts.threadTs}`;
    if (!byThread.has(key)) byThread.set(key, []);
    byThread.get(key)!.push(row);
  }

  console.log(`Found ${rows.length} agent messages across ${byThread.size} threads`);

  let appendedTotal = 0;
  let filesUpdated = 0;

  for (const [key, msgs] of byThread.entries()) {
    const filePath = path.join(SLACK_THREADS_DIR, `${key}.md`);
    let existing: string;
    try {
      existing = await fs.readFile(filePath, 'utf-8');
    } catch {
      console.log(`SKIP: ${key} — no .md file (orc never had this thread mapped to disk)`);
      continue;
    }

    const missing: string[] = [];
    for (const msg of msgs) {
      // De-dup: skip if the first 60 chars of the content already appears
      // in the file (handles the rare case where the bridge path wrote it).
      const probe = msg.content.slice(0, 60).trim();
      if (probe.length === 0) continue;
      if (existing.includes(probe)) continue;
      missing.push(formatEntry(msg.content, new Date(msg.createdAt)));
    }

    if (missing.length === 0) {
      console.log(`OK:   ${key} — already in sync (${msgs.length} agent msgs)`);
      continue;
    }

    console.log(`DIFF: ${key} — ${missing.length} missing agent entries`);

    if (apply) {
      await fs.appendFile(filePath, missing.join(''), 'utf-8');
      filesUpdated++;
      appendedTotal += missing.length;
    }
  }

  db.close();

  console.log('');
  console.log(`Summary: ${appendedTotal} entries ${apply ? 'appended' : 'would append'} across ${filesUpdated} file(s)`);
  if (!apply) console.log('Run with --apply to write changes.');
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
