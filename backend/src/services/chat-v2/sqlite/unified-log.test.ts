/**
 * Tests for the unified conversation log: column derivation (incl. the O3
 * shared-channel filter), the legacy-row migration and the outbox triggers.
 *
 * @module services/chat-v2/sqlite/unified-log.test
 */

import { CHAT_V2_MIGRATION_SQL, applyPhaseAColumnUpgrades, openChatDatabase, type ChatDatabase } from './chat-db.js';
import { ChannelStore } from './channel.store.js';
import { MessageStore } from './message.store.js';
import {
  applyUnifiedLogUpgrades,
  deriveUnifiedColumns,
  reclassifyOwnerSlackRows,
  sourceFromChannelId,
  type DeriveUnifiedColumnsInput,
} from './unified-log.js';

const DM = { id: 'dm-ella', type: 'dm' as const, agentSession: 'ella' };
const HUDDLE = { id: 'huddle-daily', type: 'huddle' as const, agentSession: '' };

/** Build a derivation input with defaults. */
function input(over: Partial<DeriveUnifiedColumnsInput>): DeriveUnifiedColumnsInput {
  return { senderType: 'user', senderId: 'steve', metadata: {}, mentions: [], channel: DM, ...over };
}

describe('deriveUnifiedColumns', () => {
  it('maps a dashboard message (no source tag) to crewly-chat, owner, in', () => {
    expect(deriveUnifiedColumns(input({}))).toMatchObject({
      source: 'crewly-chat',
      senderKind: 'owner',
      direction: 'in',
      agentSession: 'ella',
      cloudSync: 1,
      extRef: null,
    });
  });

  it('maps web → crewly-chat and keeps cloud-talk distinct', () => {
    expect(deriveUnifiedColumns(input({ metadata: { source: 'web' } })).source).toBe('crewly-chat');
    expect(deriveUnifiedColumns(input({ metadata: { source: 'cloud-talk' } })).source).toBe('cloud-talk');
  });

  it('gives an agent reply the surface of the turn it answers', () => {
    const cols = deriveUnifiedColumns(
      input({ senderType: 'agent', senderId: 'ella', metadata: { source: 'reply-tool' }, latestInboundSource: 'cloud-talk' }),
    );
    expect(cols).toMatchObject({ source: 'cloud-talk', direction: 'out', senderKind: 'agent', agentSession: 'ella' });
  });

  it('falls back to runtime / crewly-chat for replies with no inbound turn', () => {
    expect(deriveUnifiedColumns(input({ senderType: 'agent', metadata: { source: 'pty-runtime' } })).source).toBe('runtime');
    expect(deriveUnifiedColumns(input({ senderType: 'agent', metadata: { source: 'reply-tool' } })).source).toBe('crewly-chat');
  });

  it('trusts a messenger channel name over a wrong legacy tag (WhatsApp tagged slack)', () => {
    const cols = deriveUnifiedColumns(
      input({ metadata: { source: 'slack', chatId: '123@s.whatsapp.net' }, channel: { id: 'whatsapp-123@s.whatsapp.net', type: 'dm', agentSession: 'crewly-orc' } }),
    );
    expect(cols).toMatchObject({ source: 'whatsapp', senderKind: 'owner', extRef: { whatsappChatId: '123@s.whatsapp.net' } });
  });

  it('keeps Slack ids, incl. the workspace, and falls back to the configured workspace', () => {
    const own = deriveUnifiedColumns(
      input({
        metadata: { source: 'slack', slackChannelId: 'D1', slackTs: '1.2', slackThreadTs: '1.0', slackUserId: 'U1', slackTeamId: 'T9' },
      }),
    );
    expect(own.extRef).toEqual({ slackTeamId: 'T9', slackChannelId: 'D1', ts: '1.2', threadTs: '1.0', slackUserId: 'U1' });
    const fallback = deriveUnifiedColumns(
      input({ metadata: { source: 'slack', slackChannelId: 'D1' }, owner: { slackTeamId: 'T-cfg' } }),
    );
    expect(fallback.extRef).toEqual({ slackTeamId: 'T-cfg', slackChannelId: 'D1' });
  });

  it('tells the owner from other people on Slack', () => {
    const owner = { slackUserId: 'U-owner' };
    expect(deriveUnifiedColumns(input({ metadata: { source: 'slack', slackUserId: 'U-owner' }, owner })).senderKind).toBe('owner');
    expect(deriveUnifiedColumns(input({ metadata: { source: 'slack', slackUserId: 'U-maya' }, owner })).senderKind).toBe('human');
    // Unknown owner: a DM is the owner's, a shared room is not assumed to be.
    expect(deriveUnifiedColumns(input({ metadata: { source: 'slack', slackUserId: 'U-x' } })).senderKind).toBe('owner');
    expect(deriveUnifiedColumns(input({ metadata: { source: 'slack', slackUserId: 'U-x' }, channel: HUDDLE })).senderKind).toBe('human');
  });

  it('marks an agent-authored user row as an agent', () => {
    expect(deriveUnifiedColumns(input({ metadata: { source: 'slack', remoteAgentSession: 'atlas' }, channel: HUDDLE })).senderKind).toBe('agent');
    expect(deriveUnifiedColumns(input({ metadata: { authorAgentSession: 'sam' } })).senderKind).toBe('agent');
  });

  describe('O3 — shared Slack channels sync only what involves our agents', () => {
    const owner = { slackUserId: 'U-owner' };
    const slack = (extra: Record<string, unknown>) => ({ source: 'slack', slackChannelId: 'C1', ...extra });

    it('does not sync another person\'s chatter', () => {
      expect(deriveUnifiedColumns(input({ channel: HUDDLE, owner, metadata: slack({ slackUserId: 'U-maya' }) })).cloudSync).toBe(0);
    });

    it('syncs the owner, a local agent, and a message that @-mentions one of our agents', () => {
      expect(deriveUnifiedColumns(input({ channel: HUDDLE, owner, metadata: slack({ slackUserId: 'U-owner' }) })).cloudSync).toBe(1);
      expect(deriveUnifiedColumns(input({ channel: HUDDLE, owner, senderType: 'agent', senderId: 'ella', metadata: slack({}) })).cloudSync).toBe(1);
      expect(
        deriveUnifiedColumns(input({ channel: HUDDLE, owner, mentions: ['ella'], metadata: slack({ slackUserId: 'U-maya' }) })).cloudSync,
      ).toBe(1);
    });

    it('does not sync a colleague agent from another account that addresses nobody here', () => {
      expect(deriveUnifiedColumns(input({ channel: HUDDLE, owner, metadata: slack({ remoteAgentSession: 'atlas' }) })).cloudSync).toBe(0);
    });

    it('never filters a DM', () => {
      expect(deriveUnifiedColumns(input({ owner, metadata: slack({ slackUserId: 'U-maya' }) })).cloudSync).toBe(1);
    });

    it('attributes a huddle message to the mentioned agent, or the agent who wrote it', () => {
      expect(deriveUnifiedColumns(input({ channel: HUDDLE, mentions: ['sam'] })).agentSession).toBe('sam');
      expect(deriveUnifiedColumns(input({ channel: HUDDLE, senderType: 'agent', senderId: 'ella' })).agentSession).toBe('ella');
      expect(deriveUnifiedColumns(input({ channel: HUDDLE })).agentSession).toBeNull();
    });
  });

  it('keeps messenger ids', () => {
    const cols = deriveUnifiedColumns(
      input({ channel: { id: 'telegram-42', type: 'dm', agentSession: 'crewly-orc' }, metadata: { source: 'telegram', telegramChatId: '42', telegramMessageId: 7 } }),
    );
    expect(cols.extRef).toEqual({ telegramChatId: '42', telegramMessageId: '7' });
  });
});

describe('sourceFromChannelId', () => {
  it('reads the surface from messenger channel prefixes (case-insensitive)', () => {
    expect(sourceFromChannelId('slack-C1-1.2')).toBe('slack');
    expect(sourceFromChannelId('TELEGRAM-42')).toBe('telegram');
    expect(sourceFromChannelId('gchat-spaces-A')).toBe('google-chat');
    expect(sourceFromChannelId('whatsapp-1@s')).toBe('whatsapp');
    expect(sourceFromChannelId('3f0c-uuid')).toBeNull();
  });
});

describe('applyUnifiedLogUpgrades — existing databases', () => {
  /** A database on the schema before this migration, with rows of every kind. */
  function openLegacy(): ChatDatabase {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    const db = new Database(':memory:') as ChatDatabase;
    db.pragma('foreign_keys = ON');
    db.exec(CHAT_V2_MIGRATION_SQL);
    applyPhaseAColumnUpgrades(db);
    const ch = db.prepare(
      `INSERT INTO chat_channels (id, agent_session, owner_user_id, name, created_at, type) VALUES (?, ?, 'u', ?, 1, ?)`,
    );
    ch.run('slack-C1-100', 'crewly-orc', 'Slack thread', 'dm');
    ch.run('whatsapp-9@s.whatsapp.net', 'crewly-orc', 'WA', 'dm');
    ch.run('dm-ella', 'ella', 'Ella', 'dm');
    ch.run('huddle-1', '', 'daily', 'huddle');
    const msg = db.prepare(
      `INSERT INTO chat_messages (id, channel_id, seq, sender_type, sender_id, content, created_at, metadata, mentions)
       VALUES (?, ?, ?, ?, ?, 'x', ?, ?, ?)`,
    );
    msg.run('m1', 'slack-C1-100', 1, 'user', 'U1', 10, JSON.stringify({ source: 'slack', slackChannelId: 'C1', slackThreadTs: '100' }), null);
    msg.run('m2', 'slack-C1-100', 2, 'agent', 'crewly-orc', 11, JSON.stringify({ source: 'reply-tool' }), null);
    msg.run('m3', 'whatsapp-9@s.whatsapp.net', 1, 'user', '9', 12, JSON.stringify({ source: 'slack', chatId: '9@s.whatsapp.net' }), null);
    msg.run('m4', 'dm-ella', 1, 'user', 'dev-user-001', 13, null, null);
    msg.run('m5', 'dm-ella', 2, 'agent', 'ella', 14, JSON.stringify({ source: 'in-process-runtime' }), null);
    msg.run('m6', 'huddle-1', 1, 'user', 'maya', 15, JSON.stringify({ source: 'slack', slackUserId: 'U-maya' }), null);
    msg.run('m7', 'huddle-1', 2, 'user', 'maya', 16, JSON.stringify({ source: 'slack', slackUserId: 'U-maya' }), JSON.stringify(['ella']));
    msg.run('m8', 'dm-ella', 3, 'user', 'x', 17, '[1,2]', null);
    return db;
  }

  /** Read one row's unified columns. */
  function cols(db: ChatDatabase, id: string) {
    return db
      .prepare('SELECT source, direction, sender_kind, agent_session, ext_ref, cloud_sync FROM chat_messages WHERE id = ?')
      .get(id) as Record<string, unknown>;
  }

  it('adds the columns and backfills every legacy row, best effort', () => {
    const db = openLegacy();
    const report = applyUnifiedLogUpgrades(db);
    expect(report.columnsAdded).toEqual(['source', 'direction', 'sender_kind', 'agent_session', 'ext_ref', 'cloud_sync']);
    expect(report.rowsBackfilled).toBe(8);

    expect(cols(db, 'm1')).toMatchObject({ source: 'slack', direction: 'in', sender_kind: 'owner', agent_session: 'crewly-orc', cloud_sync: 1 });
    expect(JSON.parse(cols(db, 'm1').ext_ref as string)).toEqual({ slackChannelId: 'C1', threadTs: '100' });
    expect(cols(db, 'm2')).toMatchObject({ source: 'slack', direction: 'out', sender_kind: 'agent' });
    expect(cols(db, 'm3')).toMatchObject({ source: 'whatsapp' });
    expect(cols(db, 'm4')).toMatchObject({ source: 'crewly-chat', sender_kind: 'owner', agent_session: 'ella' });
    expect(cols(db, 'm5')).toMatchObject({ source: 'crewly-chat', direction: 'out' });
    expect(cols(db, 'm6')).toMatchObject({ source: 'slack', direction: 'internal', sender_kind: 'human', cloud_sync: 0 });
    expect(cols(db, 'm7')).toMatchObject({ sender_kind: 'human', cloud_sync: 1, agent_session: 'ella' });
    expect(cols(db, 'm8')).toMatchObject({ source: 'crewly-chat' });
    db.close();
  });

  it('does not enqueue backfilled history (the first-sign-in backfill uploads it)', () => {
    const db = openLegacy();
    applyUnifiedLogUpgrades(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM cloud_outbox').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('is idempotent', () => {
    const db = openLegacy();
    applyUnifiedLogUpgrades(db);
    const again = applyUnifiedLogUpgrades(db);
    expect(again).toEqual({ columnsAdded: [], rowsBackfilled: 0 });
    db.close();
  });

  it('reclassifies the owner\'s shared-channel rows once the owner is known, and enqueues them', () => {
    const db = openLegacy();
    applyUnifiedLogUpgrades(db);
    expect(reclassifyOwnerSlackRows(db, 'U-maya')).toBe(2);
    expect(cols(db, 'm6')).toMatchObject({ sender_kind: 'owner', cloud_sync: 1, direction: 'in' });
    const queued = db.prepare('SELECT message_id, op FROM cloud_outbox').all();
    // m6 became syncable (0 → 1); m7 was already syncable and is not re-sent.
    expect(queued).toEqual([{ message_id: 'm6', op: 'upsert' }]);
    expect(reclassifyOwnerSlackRows(db, 'U-maya')).toBe(0);
    db.close();
  });
});

describe('outbox triggers on a fresh database', () => {
  let db: ChatDatabase;
  let messages: MessageStore;

  beforeEach(() => {
    db = openChatDatabase({ dbPath: ':memory:', inMemory: true, skipIntegrityCheck: true });
    const channels = new ChannelStore(db);
    channels.create({ id: 'dm-ella', agentSession: 'ella', ownerUserId: 'u', name: 'Ella', nowMs: 1 });
    channels.create({ id: 'huddle-1', agentSession: '', ownerUserId: 'u', name: 'daily', nowMs: 1, type: 'huddle' });
    messages = new MessageStore(db);
    messages.setOwnerIdentityProvider(() => ({ slackUserId: 'U-owner', slackTeamId: 'T1' }));
  });

  afterEach(() => db.close());

  /** The outbox as [message_id, op] pairs. */
  const outbox = () =>
    (db.prepare('SELECT message_id, op FROM cloud_outbox ORDER BY seq').all() as Array<{ message_id: string; op: string }>).map(
      (r) => [r.message_id, r.op],
    );

  it('enqueues every syncable insert, whichever writer made it', () => {
    messages.insert({ id: 'a', channelId: 'dm-ella', senderType: 'user', senderId: 'u', content: 'hi', nowMs: 5 });
    db.prepare(
      `INSERT INTO chat_messages (id, channel_id, seq, sender_type, sender_id, content, created_at) VALUES ('raw', 'dm-ella', 99, 'system', 's', 'x', 6)`,
    ).run();
    expect(outbox()).toEqual([
      ['a', 'upsert'],
      ['raw', 'upsert'],
    ]);
    const row = db.prepare('SELECT enqueued_at FROM cloud_outbox WHERE message_id = ?').get('a') as { enqueued_at: number };
    expect(row.enqueued_at).toBe(5);
  });

  it('skips other people\'s chatter in a shared Slack channel (O3) but keeps it locally', () => {
    messages.insert({
      id: 'chatter',
      channelId: 'huddle-1',
      senderType: 'user',
      senderId: 'maya',
      content: 'lunch?',
      metadata: { source: 'slack', slackUserId: 'U-maya', slackChannelId: 'C1' },
    });
    messages.insert({
      id: 'to-ella',
      channelId: 'huddle-1',
      senderType: 'user',
      senderId: 'maya',
      content: '@ella status?',
      mentions: ['ella'],
      metadata: { source: 'slack', slackUserId: 'U-maya', slackChannelId: 'C1' },
    });
    expect(outbox()).toEqual([['to-ella', 'upsert']]);
    expect(messages.getById('chatter')).not.toBeNull();
  });

  it('enqueues a content edit and a delete, not a metadata-only change', () => {
    messages.insert({ id: 'sys', channelId: 'dm-ella', senderType: 'system', senderId: 'system', content: 'receipt' });
    messages.updateMetadata('sys', { slackDeliveryStatus: 'sent' });
    messages.updateContent('sys', 'receipt (cancelled)');
    db.prepare('DELETE FROM chat_messages WHERE id = ?').run('sys');
    expect(outbox()).toEqual([
      ['sys', 'upsert'],
      ['sys', 'upsert'],
      ['sys', 'delete'],
    ]);
  });

  it('writes the unified columns on insert', () => {
    messages.insert({
      id: 'q',
      channelId: 'dm-ella',
      senderType: 'user',
      senderId: 'Steve',
      content: 'hi',
      metadata: { source: 'slack', slackChannelId: 'D1', slackTs: '1.1', slackUserId: 'U-owner' },
    });
    messages.insert({ id: 'r', channelId: 'dm-ella', senderType: 'agent', senderId: 'ella', content: 'hello', metadata: { source: 'reply-tool' } });
    const q = db.prepare('SELECT source, sender_kind, ext_ref FROM chat_messages WHERE id = ?').get('q') as Record<string, string>;
    expect(q).toMatchObject({ source: 'slack', sender_kind: 'owner' });
    expect(JSON.parse(q.ext_ref)).toEqual({ slackTeamId: 'T1', slackChannelId: 'D1', ts: '1.1', slackUserId: 'U-owner' });
    const r = db.prepare('SELECT source, direction, agent_session FROM chat_messages WHERE id = ?').get('r');
    expect(r).toEqual({ source: 'slack', direction: 'out', agent_session: 'ella' });
  });
});
