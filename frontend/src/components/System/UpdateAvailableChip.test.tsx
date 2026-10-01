/**
 * UpdateAvailableChip tests.
 *
 * @module components/System/UpdateAvailableChip.test
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect } from 'vitest';
import { UpdateAvailableChip } from './UpdateAvailableChip';

describe('UpdateAvailableChip', () => {
	it('links to the System settings and names the version in its tooltip', () => {
		render(
			<MemoryRouter>
				<UpdateAvailableChip latestVersion="1.20.175" />
			</MemoryRouter>,
		);
		const chip = screen.getByTestId('update-available-chip');
		expect(chip).toHaveTextContent('Update available');
		expect(chip).toHaveAttribute('href', '/settings?tab=system');
		expect(chip.getAttribute('title')).toContain('1.20.175');
	});

	it('calls onNavigate when followed (closes the mobile drawer)', () => {
		const onNavigate = vi.fn();
		render(
			<MemoryRouter>
				<UpdateAvailableChip latestVersion={null} onNavigate={onNavigate} />
			</MemoryRouter>,
		);
		fireEvent.click(screen.getByTestId('update-available-chip'));
		expect(onNavigate).toHaveBeenCalled();
	});
});
