import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MentionTarget } from '../types/team-chat.types';
import { MentionComposer } from './MentionComposer';

const mentionables: MentionTarget[] = [
  { id: 'team-product', kind: 'team', label: 'Crewly Product', routingHint: 'Team lead responds' },
  { id: 'team-marketing', kind: 'team', label: 'Crewly Marketing' },
  { id: 'sam', kind: 'agent', label: 'Sam', presence: 'online', routingHint: 'Direct ping' },
  { id: 'max', kind: 'agent', label: 'Max', presence: 'inactive' },
  { id: 'leo', kind: 'agent', label: 'Leo', presence: 'idle' },
];

describe('MentionComposer', () => {
  it('renders the textarea + send button + no popover by default', () => {
    render(<MentionComposer mentionables={mentionables} />);
    expect(screen.getByTestId('mention-textarea')).toBeInTheDocument();
    expect(screen.getByTestId('mention-send')).toBeInTheDocument();
    expect(screen.queryByTestId('mention-suggestions')).not.toBeInTheDocument();
  });

  it('opens the suggestion popover when the user types `@`', async () => {
    render(<MentionComposer mentionables={mentionables} />);
    await userEvent.type(screen.getByTestId('mention-textarea'), '@');
    expect(screen.getByTestId('mention-suggestions')).toBeInTheDocument();
    // Both groups appear since no filter is typed yet.
    expect(screen.getByTestId('mention-group-teams')).toBeInTheDocument();
    expect(screen.getByTestId('mention-group-agents')).toBeInTheDocument();
  });

  it('filters suggestions case-insensitively by the partial typed after `@`', async () => {
    render(<MentionComposer mentionables={mentionables} />);
    await userEvent.type(screen.getByTestId('mention-textarea'), '@sa');
    expect(screen.getByTestId('mention-suggestion-sam')).toBeInTheDocument();
    // Max should NOT match "sa"
    expect(screen.queryByTestId('mention-suggestion-max')).not.toBeInTheDocument();
  });

  it('hides the popover after a whitespace closes the trigger', async () => {
    render(<MentionComposer mentionables={mentionables} />);
    await userEvent.type(screen.getByTestId('mention-textarea'), '@s ');
    expect(screen.queryByTestId('mention-suggestions')).not.toBeInTheDocument();
  });

  it('does not open the popover when `@` is in the middle of a word', async () => {
    render(<MentionComposer mentionables={mentionables} />);
    await userEvent.type(screen.getByTestId('mention-textarea'), 'foo@bar');
    expect(screen.queryByTestId('mention-suggestions')).not.toBeInTheDocument();
  });

  it('inserts a chip and the @label text on suggestion click', async () => {
    render(<MentionComposer mentionables={mentionables} />);
    await userEvent.type(screen.getByTestId('mention-textarea'), '@sa');
    await userEvent.click(screen.getByTestId('mention-suggestion-sam'));
    expect(screen.getByTestId('mention-chip-sam')).toBeInTheDocument();
    expect(screen.getByTestId('mention-textarea')).toHaveValue('@Sam ');
    // Popover collapses after selection.
    expect(screen.queryByTestId('mention-suggestions')).not.toBeInTheDocument();
  });

  it('groups team chips with a workspace tint and agent chips with an agent tint', async () => {
    render(<MentionComposer mentionables={mentionables} />);
    // Add one of each.
    await userEvent.type(screen.getByTestId('mention-textarea'), '@product');
    await userEvent.click(screen.getByTestId('mention-suggestion-team-product'));
    await userEvent.type(screen.getByTestId('mention-textarea'), '@sam');
    await userEvent.click(screen.getByTestId('mention-suggestion-sam'));

    expect(screen.getByTestId('mention-chip-team-product')).toHaveAttribute('data-kind', 'team');
    expect(screen.getByTestId('mention-chip-sam')).toHaveAttribute('data-kind', 'agent');
  });

  it('renders the routing hint of the most recent mention as helper text', async () => {
    render(<MentionComposer mentionables={mentionables} />);
    await userEvent.type(screen.getByTestId('mention-textarea'), '@product');
    await userEvent.click(screen.getByTestId('mention-suggestion-team-product'));
    expect(screen.getByTestId('mention-helper')).toHaveTextContent('Team lead responds');
    await userEvent.type(screen.getByTestId('mention-textarea'), '@sam');
    await userEvent.click(screen.getByTestId('mention-suggestion-sam'));
    // Last mention is Sam — its routing hint takes over.
    expect(screen.getByTestId('mention-helper')).toHaveTextContent('Direct ping');
  });

  it('overrides helper text with the inactiveHelper prop when supplied', () => {
    render(
      <MentionComposer
        mentionables={mentionables}
        inactiveHelper="Sam is inactive. Message will queue for later delivery."
      />,
    );
    expect(screen.getByTestId('mention-helper')).toHaveTextContent('inactive');
  });

  it('removes a chip when its remove button is clicked', async () => {
    render(<MentionComposer mentionables={mentionables} />);
    await userEvent.type(screen.getByTestId('mention-textarea'), '@sa');
    await userEvent.click(screen.getByTestId('mention-suggestion-sam'));
    expect(screen.getByTestId('mention-chip-sam')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Remove mention of Sam/i }));
    expect(screen.queryByTestId('mention-chip-sam')).not.toBeInTheDocument();
  });

  it('disables Send when content + mentions are both empty', () => {
    render(<MentionComposer mentionables={mentionables} />);
    expect(screen.getByTestId('mention-send')).toBeDisabled();
  });

  it('enables Send when only mentions are present (no body text)', async () => {
    render(<MentionComposer mentionables={mentionables} />);
    await userEvent.type(screen.getByTestId('mention-textarea'), '@sa');
    await userEvent.click(screen.getByTestId('mention-suggestion-sam'));
    // After selection, textarea has "@Sam " — non-empty — Send is enabled.
    expect(screen.getByTestId('mention-send')).not.toBeDisabled();
  });

  it('invokes onSend with content + mentions and resets state', async () => {
    const onSend = vi.fn();
    render(<MentionComposer mentionables={mentionables} onSend={onSend} />);
    await userEvent.type(screen.getByTestId('mention-textarea'), '@sa');
    await userEvent.click(screen.getByTestId('mention-suggestion-sam'));
    await userEvent.type(screen.getByTestId('mention-textarea'), 'check the deploy logs');
    await userEvent.click(screen.getByTestId('mention-send'));

    expect(onSend).toHaveBeenCalledTimes(1);
    const payload = onSend.mock.calls[0][0];
    expect(payload.content).toMatch(/@Sam check the deploy logs/);
    expect(payload.mentions).toEqual([
      expect.objectContaining({ id: 'sam', kind: 'agent' }),
    ]);
    // After send the composer resets — chip strip + textarea empty.
    expect(screen.queryByTestId('mention-chip-sam')).not.toBeInTheDocument();
    expect(screen.getByTestId('mention-textarea')).toHaveValue('');
  });

  it('sends on Enter without Shift', async () => {
    const onSend = vi.fn();
    render(<MentionComposer mentionables={mentionables} onSend={onSend} />);
    await userEvent.type(screen.getByTestId('mention-textarea'), 'hello{Enter}');
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0].content).toBe('hello');
  });

  it('does NOT send on Enter while an IME composition is active (Chinese/JP/KR input)', async () => {
    const onSend = vi.fn();
    render(<MentionComposer mentionables={mentionables} onSend={onSend} />);
    const ta = screen.getByTestId('mention-textarea');
    await userEvent.type(ta, 'ni hao');
    // Mid-composition: Enter commits the IME candidate, it must NOT send.
    fireEvent.compositionStart(ta);
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    // After the composition ends, Enter sends as normal.
    fireEvent.compositionEnd(ta);
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0].content).toBe('ni hao');
  });

  it('does NOT send on Enter when nativeEvent.isComposing is set', async () => {
    const onSend = vi.fn();
    render(<MentionComposer mentionables={mentionables} onSend={onSend} />);
    const ta = screen.getByTestId('mention-textarea');
    await userEvent.type(ta, 'hello');
    // Some browsers don't fire compositionStart but flag the committing
    // keystroke via isComposing — guard on that too.
    fireEvent.keyDown(ta, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('does NOT send on Shift+Enter (newline behavior)', async () => {
    const onSend = vi.fn();
    render(<MentionComposer mentionables={mentionables} onSend={onSend} />);
    await userEvent.type(screen.getByTestId('mention-textarea'), 'hello{Shift>}{Enter}{/Shift}world');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByTestId('mention-textarea')).toHaveValue('hello\nworld');
  });

  it('closes the popover on Escape', async () => {
    render(<MentionComposer mentionables={mentionables} />);
    await userEvent.type(screen.getByTestId('mention-textarea'), '@');
    expect(screen.getByTestId('mention-suggestions')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('mention-suggestions')).not.toBeInTheDocument();
  });

  it('respects disabled — textarea + Send both disabled, popover never opens', async () => {
    render(<MentionComposer mentionables={mentionables} disabled />);
    expect(screen.getByTestId('mention-textarea')).toBeDisabled();
    expect(screen.getByTestId('mention-send')).toBeDisabled();
  });
});
