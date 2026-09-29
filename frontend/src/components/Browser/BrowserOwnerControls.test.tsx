/**
 * BrowserOwnerControls tests.
 *
 * @module components/Browser/BrowserOwnerControls.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import { BrowserOwnerControls, OWNER_SCROLL_STEP_PX } from './BrowserOwnerControls';

/** Render with an input handler that succeeds. */
function setup(ok = true) {
	const onInput = vi.fn(async () => ok);
	render(<BrowserOwnerControls onInput={onInput} />);
	return onInput;
}

describe('BrowserOwnerControls', () => {
	it('sends typed text and clears the field straight away', () => {
		const onInput = setup();
		const field = screen.getByLabelText('Text to type into the page') as HTMLInputElement;

		fireEvent.change(field, { target: { value: 'hunter2' } });
		fireEvent.click(screen.getByText('Send'));

		expect(onInput).toHaveBeenCalledWith({ kind: 'type', text: 'hunter2' });
		// Not kept after sending: it is usually a password.
		expect(field.value).toBe('');
	});

	it('sends on Enter in the field too, not a page Enter', () => {
		const onInput = setup();
		const field = screen.getByLabelText('Text to type into the page');
		fireEvent.change(field, { target: { value: 'me@example.com' } });
		fireEvent.submit(field.closest('form')!);

		expect(onInput).toHaveBeenCalledWith({ kind: 'type', text: 'me@example.com' });
		expect(onInput).not.toHaveBeenCalledWith({ kind: 'key', key: 'Enter' });
	});

	it('hides what is typed on request, and never offers autocomplete', () => {
		setup();
		const field = screen.getByLabelText('Text to type into the page') as HTMLInputElement;
		expect(field.type).toBe('text');
		expect(field.getAttribute('autocomplete')).toBe('off');

		fireEvent.click(screen.getByText('Hide'));
		expect(field.type).toBe('password');
		fireEvent.click(screen.getByText('Show'));
		expect(field.type).toBe('text');
	});

	it('uses a 16px field so a phone does not zoom in on focus', () => {
		setup();
		expect(screen.getByLabelText('Text to type into the page').className).toContain('text-base');
		expect(screen.getByLabelText('Address to open').className).toContain('text-base');
	});

	it('presses keys, scrolls and goes back', () => {
		const onInput = setup();
		fireEvent.click(screen.getByLabelText('Press Enter'));
		fireEvent.click(screen.getByLabelText('Press Tab (next field)'));
		fireEvent.click(screen.getByLabelText('Press Backspace'));
		fireEvent.click(screen.getByLabelText('Press Escape'));
		fireEvent.click(screen.getByLabelText('Scroll up'));
		fireEvent.click(screen.getByLabelText('Scroll down'));
		fireEvent.click(screen.getByText('Back'));

		expect(onInput.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
			{ kind: 'key', key: 'Enter' },
			{ kind: 'key', key: 'Tab' },
			{ kind: 'key', key: 'Backspace' },
			{ kind: 'key', key: 'Escape' },
			{ kind: 'scroll', dy: -OWNER_SCROLL_STEP_PX },
			{ kind: 'scroll', dy: OWNER_SCROLL_STEP_PX },
			{ kind: 'back' },
		]);
	});

	it('opens an address and clears it once it worked', async () => {
		const onInput = setup();
		const field = screen.getByLabelText('Address to open') as HTMLInputElement;
		fireEvent.change(field, { target: { value: 'login.gov' } });
		fireEvent.click(screen.getByText('Go'));

		expect(onInput).toHaveBeenCalledWith({ kind: 'navigate', url: 'login.gov' });
		await waitFor(() => expect(field.value).toBe(''));
	});

	it('does not send empty text', () => {
		const onInput = setup();
		fireEvent.submit(screen.getByLabelText('Text to type into the page').closest('form')!);
		expect(onInput).not.toHaveBeenCalled();
	});
});
