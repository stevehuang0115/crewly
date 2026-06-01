/**
 * Empty-state surfaces for the Slack-like Team Chat (design §9.1-§9.4).
 *
 * Each variant is a self-contained component with the headline,
 * secondary copy, and optional CTA from the design. They are pure
 * presentational pieces — the parent (TeamChatPage) decides which one
 * to mount based on selection state and presence.
 *
 * Phase B does NOT wire CTAs to actions. Phase A backend follow-up
 * adds: Create-team CTA → team-builder route, Open team lead CTA →
 * direct DM with the TL agent.
 *
 * @module components/Chat-team/EmptyStates
 */

import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface EmptyShellProps {
  headline: string;
  body: ReactNode;
  cta?: ReactNode;
  /** Distinct testid per variant so TeamChatPage tests can assert mounting. */
  testId: string;
}

/** Shared visual scaffold so every empty state has consistent spacing + tone. */
function EmptyShell({ headline, body, cta, testId }: EmptyShellProps): JSX.Element {
  return (
    <div
      role="status"
      data-testid={testId}
      className="flex h-full flex-col items-center justify-center gap-3 px-8 py-12 text-center"
    >
      <h3 className="text-base font-semibold text-text-primary-dark">{headline}</h3>
      <div className="max-w-md text-sm text-text-secondary-dark">{body}</div>
      {cta && <div className="mt-2">{cta}</div>}
    </div>
  );
}

/**
 * §9.1 — No teams yet. Mounted in the WorkspaceRail's center-canvas
 * fallback when the user has zero workspaces. Phase B uses mock data
 * so this won't normally fire; left for the future zero-state.
 */
export function NoTeamsEmptyState(): JSX.Element {
  return (
    <EmptyShell
      testId="empty-no-teams"
      headline="No teams yet."
      body="Chat appears once you create or join a team. Each team becomes a workspace in the rail on the left, with its own channels and direct-message threads."
      cta={
        <button
          type="button"
          className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-white hover:bg-primary/90"
        >
          Open team builder
        </button>
      }
    />
  );
}

/**
 * §9.2 — Team selected but no channels/conversations visible. Teaches
 * the team's chat structure rather than just saying "empty".
 */
export function NoChannelsEmptyState({ teamName }: { teamName: string }): JSX.Element {
  return (
    <EmptyShell
      testId="empty-no-channels"
      headline={`${teamName} has no conversations yet.`}
      body={
        <>
          Channels are project-level discussions; direct messages are private pings to a single
          agent. Try one of the quick actions below to get started.
        </>
      }
      cta={
        <div className="flex flex-wrap items-center justify-center gap-2 text-xs">
          <button
            type="button"
            className="rounded-lg bg-surface-dark px-3 py-1.5 font-medium text-text-primary-dark ring-1 ring-border-dark hover:bg-white/5"
          >
            Message team lead
          </button>
          <button
            type="button"
            className="rounded-lg bg-surface-dark px-3 py-1.5 font-medium text-text-primary-dark ring-1 ring-border-dark hover:bg-white/5"
          >
            Open project channel
          </button>
          <button
            type="button"
            className="rounded-lg bg-surface-dark px-3 py-1.5 font-medium text-text-primary-dark ring-1 ring-border-dark hover:bg-white/5"
          >
            Start DM
          </button>
        </div>
      }
    />
  );
}

/**
 * §9.3 — Conversation selected but no messages yet. Variant by kind so
 * the seed copy reinforces the right context (channel vs DM).
 */
export function NoMessagesEmptyState({
  kind,
  recipientName,
}: {
  kind: 'channel' | 'dm';
  recipientName?: string;
}): JSX.Element {
  if (kind === 'dm') {
    return (
      <EmptyShell
        testId="empty-no-messages-dm"
        headline={recipientName ? `Start a private chat with ${recipientName}` : 'Start a private chat'}
        body={
          <>
            Direct messages notify {recipientName ?? 'this agent'} without broadcasting to the team.
            Try a starter prompt:
            <ul className="mt-3 flex list-inside list-disc flex-col items-start gap-1 text-left">
              <li>"What are you working on right now?"</li>
              <li>"Pull the latest from main and share the diff"</li>
            </ul>
          </>
        }
      />
    );
  }
  return (
    <EmptyShell
      testId="empty-no-messages-channel"
      headline="No messages yet"
      body={
        <>
          Use this channel for project coordination and handoffs. Try a starter prompt:
          <ul className="mt-3 flex list-inside list-disc flex-col items-start gap-1 text-left">
            <li>"@team — kicking off the next sprint, blockers welcome"</li>
            <li>"Anyone able to review PR #326?"</li>
          </ul>
        </>
      }
    />
  );
}

/**
 * §9.4 — Active DM but the agent is currently inactive/offline. NOT a
 * dead end — the composer stays available. Sending activates the agent and
 * delivers the message; the banner sets that expectation.
 */
export function AgentOfflineBanner({ agentName }: { agentName: string }): JSX.Element {
  return (
    <div
      role="alert"
      data-testid="banner-agent-offline"
      className="mx-4 mt-3 flex items-center gap-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[13px] text-amber-200"
    >
      <AlertTriangle size={18} className="shrink-0 text-amber-300" aria-hidden="true" />
      <span>
        <strong>{agentName} is currently inactive.</strong> Sending a message will activate{' '}
        {agentName} and deliver it once the session is up.
      </span>
    </div>
  );
}
