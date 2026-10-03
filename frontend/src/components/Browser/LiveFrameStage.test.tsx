/**
 * LiveFrameStage tests: what a tap, a drag, a pinch and a mouse wheel on the
 * frame picture turn into.
 *
 * jsdom has no layout, so each test gives the stage and image the geometry a
 * phone would: a 1280x800 frame drawn 320x200 at the top-left of the screen.
 *
 * @module components/Browser/LiveFrameStage.test
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { LiveFrameStage } from './LiveFrameStage';
import { layOut, touch } from './frame-stage-test-utils';

/** Render a driving stage with an input handler that succeeds. */
function setup(driving = true) {
	const onInput = vi.fn(async () => true);
	render(<LiveFrameStage src="data:image/jpeg;base64,AAAA" alt="frame" driving={driving} onInput={onInput} />);
	const stage = screen.getByTestId('frame-stage');
	const img = screen.getByTestId('frame-image');
	layOut(stage, img);
	return { onInput, stage, img };
}

describe('LiveFrameStage', () => {
	it('a tap clicks the same spot on the frame, in frame pixels', async () => {
		const { onInput, stage } = setup();

		touch(stage, 'pointerDown', 1, 160, 50);
		touch(stage, 'pointerUp', 1, 161, 51);

		expect(onInput).toHaveBeenCalledWith({ kind: 'tap', x: 640, y: 200, frameWidth: 1280, frameHeight: 800 });
		expect(screen.getByTestId('tap-ripple')).toBeInTheDocument();
	});

	it('a mouse click works the same way (desktop dashboard, mouse on a laptop)', () => {
		const { onInput, stage } = setup();
		fireEvent.pointerDown(stage, { pointerId: 9, pointerType: 'mouse', button: 0, clientX: 80, clientY: 100 });
		fireEvent.pointerUp(stage, { pointerId: 9, pointerType: 'mouse', button: 0, clientX: 80, clientY: 100 });
		expect(onInput).toHaveBeenCalledWith({ kind: 'tap', x: 320, y: 400, frameWidth: 1280, frameHeight: 800 });
	});

	it('a one-finger drag scrolls the remote page instead of tapping, and the picture follows the finger', async () => {
		const { onInput, stage, img } = setup();

		touch(stage, 'pointerDown', 1, 160, 150);
		touch(stage, 'pointerMove', 1, 160, 120);
		expect(img.style.transform).toBe('translate(0px, -30px) scale(1)');
		touch(stage, 'pointerMove', 1, 160, 100);
		touch(stage, 'pointerUp', 1, 160, 100);

		await waitFor(() => expect(onInput).toHaveBeenCalledTimes(1));
		const [input] = onInput.mock.calls[0] as unknown as [Record<string, number | string>];
		expect(input).toMatchObject({ kind: 'swipe', x: 640, y: 600, dx: 0, frameWidth: 1280, frameHeight: 800 });
		// Finger moved 50 CSS px up on a 4x-downscaled picture: at least 200 frame px, more if it was a flick.
		expect(input.dy).toBeLessThanOrEqual(-200);
		expect(onInput).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'tap' }));
		// The preview is dropped once the scroll comes back.
		await waitFor(() => expect(img.style.transform).toBe(''));
	});

	it('a pinch zooms the picture only, and a tap afterwards still lands on the right spot', async () => {
		const { onInput, stage, img } = setup();

		touch(stage, 'pointerDown', 1, 140, 100);
		touch(stage, 'pointerDown', 2, 180, 100);
		touch(stage, 'pointerMove', 1, 120, 100);
		touch(stage, 'pointerMove', 2, 200, 100);
		touch(stage, 'pointerUp', 1, 120, 100);
		touch(stage, 'pointerUp', 2, 200, 100);

		expect(onInput).not.toHaveBeenCalled();
		expect(img.style.transform).toMatch(/scale\(2\)/);
		expect(screen.getByTestId('reset-zoom')).toHaveTextContent('Reset zoom (2.0×)');

		// The centre of the screen is still the centre of the frame.
		touch(stage, 'pointerDown', 3, 160, 100);
		touch(stage, 'pointerUp', 3, 160, 100);
		expect(onInput).toHaveBeenCalledWith({ kind: 'tap', x: 640, y: 400, frameWidth: 1280, frameHeight: 800 });

		fireEvent.click(screen.getByTestId('reset-zoom'));
		expect(screen.queryByTestId('reset-zoom')).not.toBeInTheDocument();
		expect(img.style.transform).toBe('');
	});

	it('a finger left down after a pinch neither taps nor scrolls', () => {
		const { onInput, stage } = setup();
		touch(stage, 'pointerDown', 1, 140, 100);
		touch(stage, 'pointerDown', 2, 180, 100);
		touch(stage, 'pointerUp', 2, 180, 100);
		touch(stage, 'pointerMove', 1, 140, 40);
		touch(stage, 'pointerUp', 1, 140, 40);
		expect(onInput).not.toHaveBeenCalled();
	});

	it('a long hold does nothing', () => {
		const { onInput, stage } = setup();
		const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
		try {
			touch(stage, 'pointerDown', 1, 50, 50);
			now.mockReturnValue(6_000);
			touch(stage, 'pointerUp', 1, 50, 50);
		} finally {
			now.mockRestore();
		}
		expect(onInput).not.toHaveBeenCalled();
	});

	it('the mouse wheel scrolls the remote page, batched into one scroll', async () => {
		vi.useFakeTimers();
		try {
			const { onInput, stage } = setup();
			fireEvent.wheel(stage, { deltaY: 30, clientX: 160, clientY: 100 });
			fireEvent.wheel(stage, { deltaY: 30, clientX: 160, clientY: 100 });
			expect(onInput).not.toHaveBeenCalled();
			await act(async () => {
				vi.advanceTimersByTime(200);
			});
			// 60 px of wheel down = a finger 60 px up = 240 frame px on this picture.
			expect(onInput).toHaveBeenCalledWith({ kind: 'swipe', x: 640, y: 400, dx: 0, dy: -240, frameWidth: 1280, frameHeight: 800 });
		} finally {
			vi.useRealTimers();
		}
	});

	it('ctrl+wheel (a trackpad pinch) zooms the picture, not the page', () => {
		const { onInput, stage, img } = setup();
		fireEvent.wheel(stage, { deltaY: -100, ctrlKey: true, clientX: 160, clientY: 100 });
		expect(img.style.transform).toMatch(/scale\(1\.6/);
		expect(onInput).not.toHaveBeenCalled();
	});

	it('does nothing while the owner is only watching', () => {
		const { onInput, stage } = setup(false);
		touch(stage, 'pointerDown', 1, 160, 50);
		touch(stage, 'pointerUp', 1, 160, 50);
		fireEvent.wheel(stage, { deltaY: 100 });
		expect(onInput).not.toHaveBeenCalled();
		expect(stage.className).not.toContain('touch-none');
	});

	it('blocks the phone from panning or zooming the page while driving', () => {
		const { stage } = setup();
		expect(stage.className).toContain('touch-none');
	});
});
