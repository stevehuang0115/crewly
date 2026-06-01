/**
 * MentionComposer — chip-pattern composer for the Slack-like surfaces.
 *
 * Wraps composer behavior with the @-mention chip + suggestion popover
 * described in design §7 (sealed 2026-04-25). Phase B does NOT route
 * mentions to the backend — that lands in Phase C alongside the @team
 * → TL resolver. This component is the UX shell:
 *
 *  - The textarea behaves like MessageInput (Enter to send, Shift+Enter
 *    for newline). It does NOT re-use MessageInput directly because
 *    MessageInput owns its own value state and ships via the chat API
 *    client; the team-chat surfaces want a mention-aware composer
 *    decoupled from the existing single-channel send path. Phase C
 *    swaps the local send for `useSendMessage` once the BE API supports
 *    mention payloads.
 *  - Typing `@` opens a suggestion popover, split into Teams + Agents
 *    groups per §7.2. Each suggestion row shows the label, a routing
 *    hint, and (for agents) a presence dot.
 *  - Selecting a suggestion adds the target to the `mentions` array and
 *    inserts `@<label>` text into the textarea so the rendered message
 *    keeps the routing intent legible (§7.3). The chip strip below the
 *    textarea is the structured view — chips are removable.
 *  - Routing-hint helper text under the textarea explains the next
 *    selected chip's behavior so the user understands whether they
 *    will broadcast (team) or directly ping (agent).
 *
 * @module components/MentionComposer
 */

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import type { MentionTarget } from '../types/team-chat.types';
import type { ChatPresenceStatus } from './AgentStatusBadge';

export interface MentionComposerSendPayload {
  content: string;
  mentions: MentionTarget[];
}

export interface MentionComposerProps {
  /** Pool of @-mention targets — both teams and agents in a flat list. */
  mentionables: MentionTarget[];
  placeholder?: string;
  disabled?: boolean;
  /** Helper text shown when the agent recipient is inactive (§9.4). */
  inactiveHelper?: string;
  /** Phase B handler — Phase C wires this to the chat API. */
  onSend?(payload: MentionComposerSendPayload): void;
  className?: string;
}

const DEFAULT_PLACEHOLDER = 'Message — try @ to mention a team or agent';
const PRESENCE_DOT: Record<ChatPresenceStatus, string> = {
  online: 'bg-emerald-400',
  busy: 'bg-amber-400',
  idle: 'bg-amber-400',
  offline: 'bg-gray-500',
  inactive: 'bg-gray-500',
};

export function MentionComposer({
  mentionables,
  placeholder = DEFAULT_PLACEHOLDER,
  disabled = false,
  inactiveHelper,
  onSend,
  className = '',
}: MentionComposerProps): JSX.Element {
  const [value, setValue] = useState('');
  const [mentions, setMentions] = useState<MentionTarget[]>([]);
  const [popoverOpen, setPopoverOpen] = useState(false);
  /** Filter text inside the suggestion popover — what comes after the `@`. */
  const [filter, setFilter] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const grouped = useMemo(() => groupMentionables(mentionables, filter), [mentionables, filter]);
  const totalSuggestions = grouped.teams.length + grouped.agents.length;

  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      setValue(next);
      // Find the most recent unclosed `@token` chunk; popover stays open
      // and filters by the partial.
      const trigger = findActiveTrigger(next, e.target.selectionStart ?? next.length);
      if (trigger) {
        setPopoverOpen(true);
        setFilter(trigger.partial);
      } else {
        setPopoverOpen(false);
        setFilter('');
      }
    },
    [],
  );

  const handleSelectSuggestion = useCallback(
    (target: MentionTarget) => {
      setMentions((prev) => (prev.find((m) => m.id === target.id) ? prev : [...prev, target]));
      // Replace the active `@partial` with `@<label> ` in the textarea.
      const cursor = textareaRef.current?.selectionStart ?? value.length;
      const trigger = findActiveTrigger(value, cursor);
      if (trigger) {
        const before = value.slice(0, trigger.start);
        const after = value.slice(cursor);
        const inserted = `@${target.label} `;
        setValue(before + inserted + after);
      } else {
        setValue((v) => `${v}@${target.label} `);
      }
      setPopoverOpen(false);
      setFilter('');
      // Return focus to the textarea so users can keep typing after a click.
      textareaRef.current?.focus();
    },
    [value],
  );

  const removeMention = useCallback((id: string) => {
    setMentions((prev) => prev.filter((m) => m.id !== id));
  }, []);

  const canSend = !disabled && (value.trim().length > 0 || mentions.length > 0);

  const handleSend = useCallback(() => {
    if (!canSend) return;
    onSend?.({ content: value.trim(), mentions });
    setValue('');
    setMentions([]);
    setPopoverOpen(false);
    setFilter('');
  }, [canSend, mentions, onSend, value]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape' && popoverOpen) {
        e.preventDefault();
        setPopoverOpen(false);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend, popoverOpen],
  );

  const helperText = useMemo(() => {
    if (inactiveHelper) return inactiveHelper;
    const last = mentions[mentions.length - 1];
    if (!last) return null;
    if (last.routingHint) return last.routingHint;
    return last.kind === 'team'
      ? 'Sent to team channel; TL is primary responder'
      : `Directly notifies ${last.label}`;
  }, [inactiveHelper, mentions]);

  return (
    <div
      className={`relative border-t border-border-dark bg-surface-dark p-3 ${className}`}
      data-testid="mention-composer"
    >
      {mentions.length > 0 && (
        <ul
          className="mb-2 flex flex-wrap gap-1.5"
          aria-label="Pending mentions"
          data-testid="mention-chip-strip"
        >
          {mentions.map((m) => (
            <li key={m.id}>
              <MentionChip target={m} onRemove={() => removeMention(m.id)} />
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          rows={2}
          data-testid="mention-textarea"
          className="flex-1 resize-none rounded-lg border border-border-dark bg-background-dark px-3 py-2 text-sm text-text-primary-dark placeholder:text-text-secondary-dark shadow-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          data-testid="mention-send"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Send
        </button>
      </div>

      {helperText && (
        <p
          className="mt-1 text-[11px] text-text-secondary-dark"
          data-testid="mention-helper"
        >
          {helperText}
        </p>
      )}

      {popoverOpen && totalSuggestions > 0 && (
        <SuggestionPopover
          teams={grouped.teams}
          agents={grouped.agents}
          onSelect={handleSelectSuggestion}
        />
      )}
    </div>
  );
}

// =============================================================================
// Suggestion popover
// =============================================================================

function SuggestionPopover({
  teams,
  agents,
  onSelect,
}: {
  teams: MentionTarget[];
  agents: MentionTarget[];
  onSelect: (t: MentionTarget) => void;
}): JSX.Element {
  return (
    <div
      role="listbox"
      data-testid="mention-suggestions"
      className="absolute bottom-[110%] left-3 right-3 z-10 max-h-72 overflow-y-auto rounded-lg border border-border-dark bg-surface-dark shadow-lg"
    >
      {teams.length > 0 && (
        <SuggestionGroup label="Teams" items={teams} onSelect={onSelect} testid="teams" />
      )}
      {agents.length > 0 && (
        <SuggestionGroup label="Agents" items={agents} onSelect={onSelect} testid="agents" />
      )}
    </div>
  );
}

function SuggestionGroup({
  label,
  items,
  onSelect,
  testid,
}: {
  label: string;
  items: MentionTarget[];
  onSelect: (t: MentionTarget) => void;
  testid: string;
}): JSX.Element {
  return (
    <div data-testid={`mention-group-${testid}`}>
      <div className="border-b border-border-dark bg-background-dark px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary-dark">
        {label}
      </div>
      <ul role="list">
        {items.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              onClick={() => onSelect(it)}
              data-testid={`mention-suggestion-${it.id}`}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-background-dark"
            >
              <MentionKindGlyph target={it} />
              <span className="min-w-0 flex-1 truncate text-text-primary-dark">
                {it.label}
              </span>
              {it.routingHint && (
                <span className="shrink-0 text-[11px] text-text-secondary-dark">
                  {it.routingHint}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// =============================================================================
// Chip + glyph
// =============================================================================

function MentionChip({
  target,
  onRemove,
}: {
  target: MentionTarget;
  onRemove: () => void;
}): JSX.Element {
  const isTeam = target.kind === 'team';
  return (
    <span
      data-testid={`mention-chip-${target.id}`}
      data-kind={target.kind}
      className={[
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1',
        isTeam
          ? 'bg-primary/15 text-primary ring-primary/30'
          : 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
      ].join(' ')}
    >
      <MentionKindGlyph target={target} compact />
      <span>@{target.label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove mention of ${target.label}`}
        className="text-current opacity-60 hover:opacity-100"
      >
        ×
      </button>
    </span>
  );
}

function MentionKindGlyph({
  target,
  compact = false,
}: {
  target: MentionTarget;
  compact?: boolean;
}): JSX.Element {
  if (target.kind === 'team') {
    return (
      <span
        aria-hidden="true"
        className={`inline-flex items-center justify-center rounded ${
          compact ? 'h-3 w-3 text-[8px]' : 'h-5 w-5 text-[10px]'
        } bg-primary/20 font-semibold text-primary`}
      >
        T
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex items-center justify-center rounded-full bg-emerald-500/20 font-semibold text-emerald-300 ${
        compact ? 'h-3 w-3 text-[8px]' : 'h-5 w-5 text-[10px]'
      }`}
    >
      {target.label[0]?.toUpperCase() ?? '?'}
      {target.presence && (
        <span
          aria-hidden="true"
          className={`absolute -bottom-0.5 -right-0.5 inline-block h-1.5 w-1.5 rounded-full ring-2 ring-surface-dark ${
            PRESENCE_DOT[target.presence]
          }`}
        />
      )}
    </span>
  );
}

// =============================================================================
// Helpers — mention-trigger detection + filter / group
// =============================================================================

interface MentionTrigger {
  /** Position of the `@` character in the textarea content. */
  start: number;
  /** Text typed after the `@` (used to filter the popover). */
  partial: string;
}

/**
 * Find the most recent unclosed `@token` immediately preceding the
 * caret. Returns null if the caret is not on or after an `@` at a word
 * boundary, or if a whitespace already closes the trigger.
 */
function findActiveTrigger(value: string, caret: number): MentionTrigger | null {
  const slice = value.slice(0, caret);
  const at = slice.lastIndexOf('@');
  if (at < 0) return null;
  // The `@` must be at start-of-string or preceded by whitespace.
  if (at > 0 && !/\s/.test(slice[at - 1])) return null;
  const after = slice.slice(at + 1);
  // Whitespace closes the trigger — popover stays closed once the user
  // types a space after the partial.
  if (/\s/.test(after)) return null;
  return { start: at, partial: after };
}

interface GroupedMentionables {
  teams: MentionTarget[];
  agents: MentionTarget[];
}

/**
 * Split the flat `mentionables` list into the two suggestion sections.
 * `filter` is matched case-insensitively against `label`.
 */
function groupMentionables(input: MentionTarget[], filter: string): GroupedMentionables {
  const f = filter.trim().toLowerCase();
  const matches = (t: MentionTarget) => !f || t.label.toLowerCase().includes(f);
  return {
    teams: input.filter((t) => t.kind === 'team' && matches(t)),
    agents: input.filter((t) => t.kind === 'agent' && matches(t)),
  };
}
