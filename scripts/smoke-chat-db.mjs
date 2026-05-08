/**
 * F-CYCLE7-1 chat-v2 SQLite boot smoke test.
 *
 * Runs the same path that ChatGateway boot uses: opens chat.db at a
 * temp path, writes a marker channel + message, reads them back,
 * asserts the round-trip values match.
 *
 * Pass condition: exits 0 with `[smoke] PASS` on stdout.
 * Fail condition: any non-zero exit (2 = channel readback mismatch,
 *                 3 = message readback mismatch, 1 = native dlopen
 *                 / arch failure surfacing as a thrown error).
 *
 * Usage (from repo root, after `npm run build:backend`):
 *   node scripts/smoke-chat-db.mjs
 *
 * The script intentionally lives at repo-root so `createBareModuleRequire`
 * (anchored to `process.argv[1]`) walks up to find `./node_modules/`.
 * If you run it from /tmp it will fail with `Cannot find module
 * 'better-sqlite3'` — that's a bug in the runner, not a regression.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const compiledChatDb = resolve(
	here,
	'..',
	'dist',
	'backend',
	'backend',
	'src',
	'services',
	'chat-v2',
	'sqlite',
	'chat-db.js',
);

const tmp = mkdtempSync(join(tmpdir(), 'crewly-cycle7-1-'));
const dbPath = join(tmp, 'chat.db');

const { openChatDatabase } = await import(compiledChatDb);

console.log('[smoke] opening chat.db at', dbPath);
const db = openChatDatabase({ dbPath });
console.log('[smoke] open OK — native better-sqlite3 loaded for this host');

const now = Date.now();
db.prepare(
	`INSERT INTO chat_channels (id, agent_session, owner_user_id, name, created_at)
	 VALUES (?, ?, ?, ?, ?)`,
).run('smoke-ch', 'smoke-agent', 'smoke-user', 'F-CYCLE7-1 Marker', now);

db.prepare(
	`INSERT INTO chat_messages
	   (id, channel_id, seq, sender_type, sender_id, content, content_type, created_at)
	 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
	'smoke-msg',
	'smoke-ch',
	1,
	'system',
	'smoke-bot',
	'cycle7-marker-' + now,
	'markdown',
	now,
);

const channel = db
	.prepare('SELECT * FROM chat_channels WHERE id = ?')
	.get('smoke-ch');
const message = db
	.prepare('SELECT * FROM chat_messages WHERE id = ?')
	.get('smoke-msg');

console.log('[smoke] readback channel:', JSON.stringify(channel));
console.log('[smoke] readback message:', JSON.stringify(message));

if (!channel || channel.name !== 'F-CYCLE7-1 Marker') {
	console.error('[smoke] FAIL — channel readback mismatch');
	process.exit(2);
}
if (!message || message.content !== 'cycle7-marker-' + now) {
	console.error('[smoke] FAIL — message readback mismatch');
	process.exit(3);
}

db.close();
rmSync(tmp, { recursive: true, force: true });
console.log('[smoke] PASS — write/read roundtrip verified, db closed cleanly');
