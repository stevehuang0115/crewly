/**
 * This machine's Drive mode conversations (specs/2026-10-08-drive-mode.md
 * §7): where each one is recorded (the agent's DM, or the room's thread), who
 * answers it, its turns (for the recap) and whether it is closed — in
 * `<crewlyHome>/drive-conversations.json`, so a restart mid-drive still
 * routes the agents' answers and recaps. Cloud keeps the session itself.
 *
 * @module services/drive/drive-conversation.store
 */

import * as fs from 'fs';
import * as path from 'path';
import { DRIVE_CONSTANTS } from '../../constants.js';
import { getCrewlyHomePath } from '../core/crewly-home.utils.js';
import type { DriveTargetKind } from './drive-cloud.contract.js';

/** One turn. */
export interface DriveLocalTurn {
  from: 'owner' | 'agent';
  name: string;
  text: string;
  /** ISO */
  at: string;
  interim?: boolean;
}

/** One Drive mode conversation on this machine. */
export interface DriveLocalConversation {
  sessionId: string;
  conversationId: string;
  kind: DriveTargetKind;
  /** "Ella", "CE", "#ce" */
  targetName: string;
  /** Who answers (the agent, the lead) */
  agentSession: string;
  /** Others who may answer (team / room members) */
  members?: string[];
  /** chat-v2 channel it is recorded in */
  channelId: string;
  /** Thread root (room conversations) */
  threadId?: string;
  /** ISO */
  startedAt: string;
  turns: DriveLocalTurn[];
  /** ISO — the recap was asked for */
  recapAskedAt?: string;
  /** ISO — the recap was posted; closed */
  closedAt?: string;
}

/** The file. */
interface DriveLocalFile {
  version: 1;
  conversations: Record<string, DriveLocalConversation>;
}

/**
 * The key of a conversation.
 *
 * @param sessionId - Session
 * @param conversationId - Conversation
 * @returns `<sessionId>:<conversationId>`
 */
export function localKey(sessionId: string, conversationId: string): string {
  return `${sessionId}:${conversationId}`;
}

/** Read / change local Drive mode conversations. Writes are serialised. */
export class DriveConversationStore {
  private chain: Promise<unknown> = Promise.resolve();

  /**
   * @param filePath - File; default `<crewlyHome>/drive-conversations.json` (resolved per call)
   */
  constructor(private readonly filePath?: string) {}

  /** @returns Absolute path */
  getFilePath(): string {
    return this.filePath ?? path.join(getCrewlyHomePath(), DRIVE_CONSTANTS.STATE_FILENAME);
  }

  /** @returns Every conversation (empty when missing or unreadable) */
  async list(): Promise<DriveLocalConversation[]> {
    await this.chain;
    return Object.values((await this.read()).conversations);
  }

  /**
   * One conversation.
   *
   * @param sessionId - Session
   * @param conversationId - Conversation
   * @returns It, or null
   */
  async get(sessionId: string, conversationId: string): Promise<DriveLocalConversation | null> {
    await this.chain;
    return (await this.read()).conversations[localKey(sessionId, conversationId)] ?? null;
  }

  /**
   * Change one conversation; `fn` gets it (or null) and returns the new one,
   * or null to leave it. Conversations older than
   * {@link DRIVE_CONSTANTS.KEEP_MS} are dropped on the way.
   *
   * @param sessionId - Session
   * @param conversationId - Conversation
   * @param fn - Updater
   * @param nowMs - Clock
   * @returns The new conversation (or null)
   */
  update(
    sessionId: string,
    conversationId: string,
    fn: (cur: DriveLocalConversation | null) => DriveLocalConversation | null,
    nowMs: number = Date.now(),
  ): Promise<DriveLocalConversation | null> {
    const run = this.chain.then(async () => {
      const state = await this.read();
      const key = localKey(sessionId, conversationId);
      const cur = state.conversations[key] ? structuredClone(state.conversations[key]) : null;
      const next = fn(cur);
      for (const [k, c] of Object.entries(state.conversations)) {
        if (nowMs - Date.parse(c.startedAt) > DRIVE_CONSTANTS.KEEP_MS) delete state.conversations[k];
      }
      if (next) state.conversations[key] = next;
      await this.write(state);
      return next;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<DriveLocalFile> {
    try {
      const raw = JSON.parse(await fs.promises.readFile(this.getFilePath(), 'utf8')) as Partial<DriveLocalFile>;
      if (raw && raw.version === 1 && raw.conversations && typeof raw.conversations === 'object') return { version: 1, conversations: raw.conversations };
    } catch {
      // missing or unreadable: start empty
    }
    return { version: 1, conversations: {} };
  }

  private async write(state: DriveLocalFile): Promise<void> {
    const file = this.getFilePath();
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.promises.rename(tmp, file);
  }
}
