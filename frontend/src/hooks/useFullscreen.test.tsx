/**
 * useFullscreen tests: real fullscreen where the element supports it, a
 * fixed overlay where it does not (iPhone Safari), and leaving either.
 *
 * @module hooks/useFullscreen.test
 */

import React, { useRef } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { canUseNativeFullscreen, useFullscreen } from './useFullscreen';

/** A surface with enter/exit buttons that reports its mode. */
function Harness({ onEl }: { onEl?: (el: HTMLDivElement) => void }) {
	const ref = useRef<HTMLDivElement | null>(null);
	const fs = useFullscreen(ref);
	return (
		<div
			ref={(el) => {
				ref.current = el;
				if (el) onEl?.(el);
			}}
			data-testid="surface"
			data-mode={fs.active ? (fs.native ? 'native' : 'overlay') : 'off'}
		>
			<button type="button" onClick={() => void fs.enter()}>enter</button>
			<button type="button" onClick={() => void fs.exit()}>exit</button>
		</div>
	);
}

afterEach(() => {
	Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
});

describe('useFullscreen', () => {
	it('uses the overlay where elements cannot go fullscreen, and Escape leaves it', async () => {
		render(<Harness />);
		expect(canUseNativeFullscreen(screen.getByTestId('surface'))).toBe(false);

		fireEvent.click(screen.getByText('enter'));
		await waitFor(() => expect(screen.getByTestId('surface')).toHaveAttribute('data-mode', 'overlay'));
		expect(document.body.style.overflow).toBe('hidden');

		fireEvent.keyDown(document, { key: 'Escape' });
		await waitFor(() => expect(screen.getByTestId('surface')).toHaveAttribute('data-mode', 'off'));
		expect(document.body.style.overflow).toBe('');
	});

	it('uses real fullscreen when the element offers it, and follows the browser leaving it', async () => {
		const requestFullscreen = vi.fn(async function (this: HTMLElement) {
			Object.defineProperty(document, 'fullscreenElement', { value: this, configurable: true });
		});
		const exitFullscreen = vi.fn(async () => {
			Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
		});
		Object.defineProperty(document, 'exitFullscreen', { value: exitFullscreen, configurable: true });
		render(<Harness onEl={(el) => Object.assign(el, { requestFullscreen })} />);

		fireEvent.click(screen.getByText('enter'));
		await waitFor(() => expect(screen.getByTestId('surface')).toHaveAttribute('data-mode', 'native'));
		expect(requestFullscreen).toHaveBeenCalledTimes(1);

		// The user leaves with the browser's own control.
		Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
		act(() => {
			document.dispatchEvent(new Event('fullscreenchange'));
		});
		await waitFor(() => expect(screen.getByTestId('surface')).toHaveAttribute('data-mode', 'off'));
	});

	it('exit leaves real fullscreen too', async () => {
		const requestFullscreen = vi.fn(async function (this: HTMLElement) {
			Object.defineProperty(document, 'fullscreenElement', { value: this, configurable: true });
		});
		const exitFullscreen = vi.fn(async () => {
			Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
		});
		Object.defineProperty(document, 'exitFullscreen', { value: exitFullscreen, configurable: true });
		render(<Harness onEl={(el) => Object.assign(el, { requestFullscreen })} />);

		fireEvent.click(screen.getByText('enter'));
		await waitFor(() => expect(screen.getByTestId('surface')).toHaveAttribute('data-mode', 'native'));
		fireEvent.click(screen.getByText('exit'));
		await waitFor(() => expect(screen.getByTestId('surface')).toHaveAttribute('data-mode', 'off'));
		expect(exitFullscreen).toHaveBeenCalledTimes(1);
	});

	it('falls back to the overlay when the browser refuses', async () => {
		const requestFullscreen = vi.fn(async () => {
			throw new Error('Permissions check failed');
		});
		render(<Harness onEl={(el) => Object.assign(el, { requestFullscreen })} />);
		fireEvent.click(screen.getByText('enter'));
		await waitFor(() => expect(screen.getByTestId('surface')).toHaveAttribute('data-mode', 'overlay'));
	});
});
