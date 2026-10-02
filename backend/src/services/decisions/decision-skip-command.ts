/**
 * The owner's "skip all old cards" / 「清掉旧卡片」 command in their DM with
 * the orc (specs/2026-10-01-decision-skip.md §3). It is handled by the
 * backend, not the orc: every open decision card from before today is
 * skipped, and the owner gets one line back in the same conversation.
 *
 * @module services/decisions/decision-skip-command
 */

import type { SlackIncomingMessage } from '../../types/slack.types.js';
import type { DecisionService, SkipAllResult } from './decision.service.js';

/** Whole-message phrasings of the command (lower-cased, punctuation stripped). */
const SKIP_ALL_PHRASES: readonly string[] = [
  'skip all old cards',
  'skip all the old cards',
  'skip old cards',
  'skip all old decisions',
  'skip all old decision cards',
  'clear old cards',
  'clear the old cards',
  'clear all old cards',
  'clear old decision cards',
  'dismiss old cards',
  'dismiss all old cards',
  '清掉旧卡片',
  '清掉旧卡',
  '清掉所有旧卡片',
  '清除旧卡片',
  '清理旧卡片',
  '旧卡片都清掉',
  '旧卡片都跳过',
  '跳过所有旧卡片',
  '跳过旧卡片',
];

/**
 * Whether a message is the skip-all command.
 *
 * @param text - Message text
 * @returns True for the command
 *
 * @example
 * isSkipAllCommand('Skip all old cards!') // true
 * isSkipAllCommand('清掉旧卡片') // true
 */
export function isSkipAllCommand(text: string | undefined): boolean {
  if (!text) return false;
  const norm = text
    .replace(/<@[A-Z0-9]+>/g, '')
    .toLowerCase()
    .replace(/[\s.。!！,，~～?？]+$/u, '')
    .replace(/^(?:please|pls|请|帮我|帮忙)\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
  return SKIP_ALL_PHRASES.includes(norm);
}

/**
 * Local midnight of the day `now` is in ("before today").
 *
 * @param now - Clock
 * @returns Start of today
 */
export function startOfToday(now: Date): Date {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * The owner's one-line answer.
 *
 * @param result - What the bulk skip did
 * @returns Text
 */
export function skipAllReply(result: SkipAllResult): string {
  if (result.matched === 0) return 'No open cards from before today — nothing to clear.';
  const n = result.settled.length;
  const declined = result.rows.filter((r) => r.outcome === 'declined' && result.settled.includes(r.id)).length;
  const cards = `${n} card${n === 1 ? '' : 's'}`;
  const extra = declined > 0 ? ` (${declined} that needed your OK ${declined === 1 ? 'was' : 'were'} answered "No")` : '';
  return `Skipped ${cards} from before today${extra}. Their agents were told to drop them and not ask again.`;
}

/** Collaborators of {@link createSkipAllCommandInterceptor}. */
export interface SkipAllCommandDeps {
  /** `orc` when the message is the owner writing in their DM with the orc */
  ownerDmScope: (message: SlackIncomingMessage) => 'orc' | 'agent' | null;
  /** Where to answer the message */
  replyTargetOf: (message: SlackIncomingMessage) => unknown;
  /** Answer the owner in that conversation */
  reply: (text: string, target: unknown) => Promise<unknown>;
  service: () => Pick<DecisionService, 'skipAll'> | null;
  now?: () => Date;
  onError?: (err: unknown) => void;
}

/**
 * The Slack bridge interceptor: consumes the command in the owner's orc DM
 * (the orc never sees it) and runs the bulk skip.
 *
 * @param deps - Collaborators
 * @returns Interceptor: true when the message was the command
 */
export function createSkipAllCommandInterceptor(deps: SkipAllCommandDeps): (message: SlackIncomingMessage) => boolean {
  return (message) => {
    if (message.hasFiles || !isSkipAllCommand(message.text)) return false;
    if (deps.ownerDmScope(message) !== 'orc') return false;
    const service = deps.service();
    if (!service) return false;
    const target = deps.replyTargetOf(message);
    const now = (deps.now ?? (() => new Date()))();
    void service
      .skipAll({ olderThan: startOfToday(now), source: 'all' })
      .then((result) => deps.reply(skipAllReply(result), target))
      .catch((err) => {
        deps.onError?.(err);
        return deps.reply("Couldn't clear the old cards — try again from the dashboard's Waiting on you section.", target).catch(() => undefined);
      });
    return true;
  };
}
