/**
 * Tests for mapping a tap on a scaled frame image to the frame's own pixels.
 *
 * @module utils/browser-tap.test
 */

import { describe, it, expect } from 'vitest';
import { frameTapPoint, frameTapFromEvent } from './browser-tap';

describe('frameTapPoint', () => {
	it('scales a tap on a shrunken frame up to the frame pixels', () => {
		expect(frameTapPoint(160, 50, 320, 200, 1280, 800)).toEqual({ x: 640, y: 200, frameWidth: 1280, frameHeight: 800 });
	});

	it('is the identity when the frame is drawn at its own size', () => {
		expect(frameTapPoint(10, 20, 640, 400, 640, 400)).toEqual({ x: 10, y: 20, frameWidth: 640, frameHeight: 400 });
	});

	it('clamps to the frame edges', () => {
		expect(frameTapPoint(-5, 999, 320, 200, 1280, 800)).toEqual({ x: 0, y: 800, frameWidth: 1280, frameHeight: 800 });
	});

	it('is null before the image has loaded', () => {
		expect(frameTapPoint(1, 1, 320, 200, 0, 0)).toBeNull();
		expect(frameTapPoint(1, 1, 0, 0, 1280, 800)).toBeNull();
	});
});

describe('frameTapFromEvent', () => {
	it('measures from the image box', () => {
		const img = document.createElement('img');
		Object.defineProperty(img, 'naturalWidth', { value: 1280 });
		Object.defineProperty(img, 'naturalHeight', { value: 800 });
		img.getBoundingClientRect = () => ({ left: 100, top: 50, width: 320, height: 200 }) as DOMRect;

		expect(frameTapFromEvent(260, 100, img)).toEqual({
			tap: { x: 640, y: 200, frameWidth: 1280, frameHeight: 800 },
			renderedX: 160,
			renderedY: 50,
		});
	});
});
