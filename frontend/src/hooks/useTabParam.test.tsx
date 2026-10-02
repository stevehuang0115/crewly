import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { resolveTab, useTabParam } from './useTabParam';

const TABS = ['board', 'requests', 'runs'] as const;
type Tab = (typeof TABS)[number];
let setter: (t: Tab) => void = () => {};

const Probe: React.FC = () => {
	const [tab, setTab] = useTabParam(TABS, { old: 'runs' });
	setter = setTab;
	const { search } = useLocation();
	return <div data-testid="probe">{`${tab}|${search}`}</div>;
};

function renderAt(url: string) {
	return render(
		<MemoryRouter initialEntries={[url]}>
			<Probe />
		</MemoryRouter>,
	);
}

describe('resolveTab', () => {
	it('accepts known ids, maps aliases, falls back to the first tab', () => {
		expect(resolveTab('runs', TABS)).toBe('runs');
		expect(resolveTab('old', TABS, { old: 'runs' })).toBe('runs');
		expect(resolveTab('nope', TABS)).toBe('board');
		expect(resolveTab(null, TABS)).toBe('board');
	});
});

describe('useTabParam', () => {
	it('reads ?tab=', () => {
		renderAt('/tickets?tab=requests');
		expect(screen.getByTestId('probe')).toHaveTextContent('requests|?tab=requests');
	});

	it('maps an alias and defaults unknown values', () => {
		renderAt('/tickets?tab=old');
		expect(screen.getByTestId('probe')).toHaveTextContent(/^runs\|/);
	});

	it('writes ?tab=, keeps other params, and drops it for the default tab', () => {
		renderAt('/tickets?status=failed');
		act(() => setter('runs'));
		expect(screen.getByTestId('probe')).toHaveTextContent('runs|?status=failed&tab=runs');
		act(() => setter('board'));
		expect(screen.getByTestId('probe')).toHaveTextContent('board|?status=failed');
	});
});
