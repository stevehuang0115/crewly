/**
 * TeamMemberLine — one member of a team on the redesigned team page
 * (specs/2026-10-02-ui-redesign.md, `simple/TeamDetail`).
 *
 * One line: "Owen — lead — working on CE-81", an optional quiet meta line
 * (sign-in needed, fallback runtime, expert), then at most one visible
 * action (Message when running, Start when stopped) and everything else in
 * "⋯": make lead, view/edit agent, open terminal, start/stop, remove.
 *
 * @module components/TeamDetail/TeamMemberLine
 */

import React, { useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@crewly/ui/Button';
import { OverflowMenu, type OverflowMenuItem } from '@crewly/ui/OverflowMenu';
import { StatusLabel, type StatusTone } from '@crewly/ui';
import type { TeamMember } from '@/types';
import { SignInNeededChip } from '@/components/SignInNeededChip';

export interface TeamMemberLineProps {
  member: TeamMember;
  /** This member leads the team */
  isLead?: boolean;
  /** The team is starting: members not yet up show "Starting…" */
  isStartingTeam?: boolean;
  onStart?: (memberId: string) => Promise<void>;
  onStop?: (memberId: string) => Promise<void>;
  /** Omitted for the orchestrator (no lead toggle there) */
  onMakeLead?: (memberId: string) => Promise<void>;
  onViewAgent?: (member: TeamMember) => void;
  onViewTerminal?: (member: TeamMember) => void;
  /** Message this member (a DM with the agent; the page picks the link) */
  onMessage?: (member: TeamMember) => void;
  /** Remove the member from the team (asks first; the page owns the confirm) */
  onRemove?: (member: TeamMember) => void;
}

/** Lifecycle of a member as the row shows it. */
export interface MemberState {
  running: boolean;
  /** Short word for the status label */
  label: string;
  tone: StatusTone;
  /** "working on CE-81", "idle, nothing assigned", "stopped" */
  doing: string;
}

/**
 * Derive what the row says about a member.
 *
 * @param member - Team member
 * @param busy - Local start/stop in flight ('start' | 'stop' | null)
 * @param isStartingTeam - The whole team is starting
 * @returns Display state
 */
export function getMemberState(
  member: TeamMember,
  busy: 'start' | 'stop' | null = null,
  isStartingTeam = false,
): MemberState {
  const s = member.agentStatus;
  const isActive = s === 'active';
  const isStarted = s === 'started';
  const isStartingStatus = s === 'starting' || s === 'activating';
  const running = isActive || isStarted || isStartingStatus;

  if (busy === 'stop') return { running, label: 'Stopping…', tone: 'attention', doing: 'stopping' };
  if (busy === 'start' || isStartingStatus || (isStartingTeam && !isActive && !isStarted)) {
    return { running: true, label: 'Starting…', tone: 'primary', doing: 'starting up' };
  }
  if (s === 'suspended') return { running: false, label: 'Suspended', tone: 'attention', doing: 'suspended' };
  if (!running) return { running: false, label: 'Stopped', tone: 'neutral', doing: 'stopped' };

  const tickets = member.currentTickets ?? [];
  let doing: string;
  if (tickets.length > 0) {
    doing = `working on ${tickets[0]}${tickets.length > 1 ? ` +${tickets.length - 1}` : ''}`;
  } else if (member.workingStatus === 'in_progress') {
    doing = 'working';
  } else {
    doing = 'idle, nothing assigned';
  }
  return { running: true, label: isActive ? 'Active' : 'Started', tone: 'success', doing };
}

/**
 * One member line with Message/Start and a "⋯" menu.
 *
 * @param props - {@link TeamMemberLineProps}
 * @returns The row
 */
export const TeamMemberLine: React.FC<TeamMemberLineProps> = ({
  member,
  isLead = false,
  isStartingTeam = false,
  onStart,
  onStop,
  onMakeLead,
  onViewAgent,
  onViewTerminal,
  onMessage,
  onRemove,
}) => {
  const [busy, setBusy] = useState<'start' | 'stop' | 'lead' | null>(null);
  const state = getMemberState(member, busy === 'lead' ? null : busy, isStartingTeam);

  const run = async (kind: 'start' | 'stop' | 'lead', fn?: (id: string) => Promise<void>) => {
    if (!fn || busy) return;
    setBusy(kind);
    try {
      await fn(member.id);
    } finally {
      setBusy(null);
    }
  };

  const items: OverflowMenuItem[] = [];
  if (onMakeLead && !isLead) {
    items.push({ label: busy === 'lead' ? 'Making lead…' : 'Make lead', onClick: () => void run('lead', onMakeLead), disabled: busy !== null });
  }
  if (onViewAgent) items.push({ label: state.running ? 'View agent' : 'Edit agent', onClick: () => onViewAgent(member) });
  if (state.running && member.sessionName && onViewTerminal) {
    items.push({ label: 'Open terminal', onClick: () => onViewTerminal(member) });
  }
  if (state.running && onStop) {
    items.push({ label: `Stop ${member.name}`, onClick: () => void run('stop', onStop), disabled: busy !== null });
  }
  if (!state.running && onStart && onMessage) {
    // Start is the visible action on a stopped row; Message stays reachable here.
    items.push({ label: 'Message', onClick: () => onMessage(member) });
  }
  if (onRemove && member.role !== 'orchestrator') {
    items.push({ label: 'Remove from team', danger: true, separator: items.length > 0, onClick: () => onRemove(member) });
  }

  const primaryAction = state.running
    ? onMessage && (
        <Button variant="secondary" size="sm" onClick={() => onMessage(member)} data-testid={`member-message-${member.id}`}>
          Message
        </Button>
      )
    : onStart && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void run('start', onStart)}
          loading={busy === 'start'}
          disabled={busy !== null}
          data-testid={`member-start-${member.id}`}
        >
          Start
        </Button>
      );

  const metaBits: React.ReactNode[] = [];
  if (member.runtimeOverride) {
    const until = member.runtimeOverride.until
      ? ` until ~${new Date(member.runtimeOverride.until).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
      : '';
    metaBits.push(
      <span key="override" className="text-attention" data-testid="runtime-override-badge" title="Running on a fallback runtime while its own is out of usage">
        {member.runtimeOverride.badge}{until}
      </span>,
    );
  }
  if (member.expertId) metaBits.push(<span key="expert" data-testid="expert-badge">Expert</span>);

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border-soft py-3.5 sm:flex-nowrap"
      data-testid={`member-line-${member.id}`}
    >
      <div className="min-w-0 flex-1 basis-56">
        <p className="truncate text-[15px] leading-[22px]">
          <span className="font-semibold text-text" title={`Session: ${member.sessionName || 'Inactive'}`}>{member.name}</span>
          <span className="text-text-3"> — </span>
          <span className="text-text-2" data-testid={isLead ? 'lead-badge' : undefined}>{isLead ? 'lead' : member.role}</span>
          <span className="text-text-3"> — </span>
          <span className={state.tone === 'attention' ? 'text-attention' : 'text-text-2'}>{state.doing}</span>
        </p>
        {metaBits.length > 0 && (
          <p className="mt-0.5 flex flex-wrap gap-x-2 text-[13px] leading-[18px] text-text-2">
            {metaBits.map((b, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="text-text-3">·</span>}
                {b}
              </React.Fragment>
            ))}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {member.loginRequired && (
          <SignInNeededChip loginRequired={member.loginRequired} agentLabel={member.name} align="right" runtimeType={member.runtimeType} />
        )}
        {state.label !== 'Active' && state.label !== 'Stopped' && <StatusLabel tone={state.tone} size="sm">{state.label}</StatusLabel>}
        {primaryAction}
        {items.length > 0 && (
          <OverflowMenu
            items={items}
            icon={MoreHorizontal}
            label={`More actions for ${member.name}`}
            buttonClassName="inline-flex h-8 w-8 items-center justify-center rounded-[0.5rem] text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
          />
        )}
      </div>
    </div>
  );
};

export default TeamMemberLine;
