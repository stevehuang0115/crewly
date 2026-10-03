/**
 * Tests for one timeline row: titles, collapse / expand, routine folding,
 * stall highlight.
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TimelineGroupRow, groupMeta, groupTitle } from './TimelineGroupRow';
import { stallGroup, turnGroup } from '../../test/trace.fixtures';

const names = (s: string): string => ({ ella: 'Ella', sam: 'Sam' })[s] ?? s;

describe('TimelineGroupRow', () => {
	it('is one line until clicked, then shows the notable events with routine ones folded', () => {
		render(
			<ol>
				<TimelineGroupRow group={turnGroup()} nameOf={names} />
			</ol>,
		);
		expect(screen.getByText('You → Ella')).toBeInTheDocument();
		expect(screen.getByText('1 blocked')).toBeInTheDocument();
		expect(screen.queryByTestId('trace-group-events-g0')).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /You → Ella/ }));
		const events = screen.getAllByTestId('trace-event');
		expect(events).toHaveLength(2);
		expect(screen.getByText('ella was refused POST /slack/send: not allowed')).toBeInTheDocument();
		expect(screen.getByText('Blocked')).toBeInTheDocument();
		expect(screen.queryByText('ella called POST /task-pool/add')).not.toBeInTheDocument();

		fireEvent.click(screen.getByTestId('trace-group-show-all-g0'));
		expect(screen.getAllByTestId('trace-event')).toHaveLength(4);
		expect(screen.getByText('ella called POST /task-pool/add')).toBeInTheDocument();
		expect(screen.getByText('Hide routine events')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /You → Ella/ }));
		expect(screen.queryByTestId('trace-group-events-g0')).not.toBeInTheDocument();
	});

	it('highlights a stall with its cause and detail, and does not expand it', () => {
		render(
			<ol>
				<TimelineGroupRow group={stallGroup()} />
			</ol>,
		);
		const row = screen.getByTestId('trace-group-s0');
		expect(row).toHaveAttribute('data-kind', 'stall');
		expect(row.className).toContain('bg-attention-soft');
		expect(screen.getByText('Stalled 1h — waiting on you')).toBeInTheDocument();
		expect(screen.getByText(/Decision D-1 open/)).toBeInTheDocument();
		expect(screen.queryByRole('button')).not.toBeInTheDocument();
	});

	it('titles groups for the owner', () => {
		expect(groupTitle(turnGroup({ title: 'Work item → sam', session: 'sam' }), names)).toBe('Work item → Sam');
		expect(groupTitle(turnGroup({ title: 'sam working', session: 'sam' }), names)).toBe('Sam working');
		expect(groupTitle(turnGroup({ title: 'Harness → sam', session: 'sam' }), names)).toBe('Crewly → Sam');
		expect(groupTitle(turnGroup({ kind: 'owner', session: undefined, title: 'Owner' }), names)).toBe('You');
		expect(groupTitle(turnGroup({ kind: 'system', session: undefined, title: 'Harness' }), names)).toBe('Crewly');
		const base = stallGroup();
		const ongoing = stallGroup({ stall: base.stall && { ...base.stall, ongoing: true, cause: 'nobody_pushing' } });
		expect(groupTitle(ongoing, names)).toBe('Stalled 1h and counting — nobody pushing');
	});

	it('summarises a group in its meta line', () => {
		const now = new Date('2026-10-03T12:00:00Z');
		const meta = groupMeta(turnGroup(), now);
		expect(meta).toMatch(/4 events · 2 skill calls · 34k tokens \$1\.23$/);
		const base = stallGroup();
		const ongoing = stallGroup({ stall: base.stall && { ...base.stall, ongoing: true } });
		expect(groupMeta(ongoing, now)).toMatch(/^since /);
	});
});
