/**
 * Tests for the gesture math behind driving a browser from its picture:
 * coordinate mapping through a local zoom, pinch, swipe conversion, and
 * telling a tap from a drag.
 *
 * @module utils/frame-gestures.test
 */

import { describe, it, expect } from 'vitest';
import {
	IDENTITY_VIEW,
	MAX_ZOOM,
	TAP_MAX_MS,
	TAP_SLOP_PX,
	clampView,
	classifyOneFinger,
	containRect,
	deltaToFrame,
	pinchView,
	pointToFrame,
	withFling,
	zoomAround,
} from './frame-gestures';

/** A 1280x800 frame shown 320x200 wide on a phone. */
const BOX = { width: 320, height: 200 };
const NATURAL = { width: 1280, height: 800 };

describe('pointToFrame', () => {
	it('scales a point on the shrunken picture up to frame pixels', () => {
		expect(pointToFrame({ x: 160, y: 50 }, IDENTITY_VIEW, BOX, NATURAL)).toEqual({ x: 640, y: 200 });
	});

	it('undoes the local zoom and pan', () => {
		// Zoomed 2x and panned to the middle: the centre of the screen is the centre of the frame.
		expect(pointToFrame({ x: 160, y: 100 }, { zoom: 2, tx: -160, ty: -100 }, BOX, NATURAL)).toEqual({ x: 640, y: 400 });
		// Zoomed 4x at the top-left: the screen's (80, 50) is the frame's (80, 50) quarter-scaled up.
		expect(pointToFrame({ x: 80, y: 50 }, { zoom: 4, tx: 0, ty: 0 }, BOX, NATURAL)).toEqual({ x: 80, y: 50 });
	});

	it('is null outside the picture or before it has loaded', () => {
		expect(pointToFrame({ x: -1, y: 10 }, IDENTITY_VIEW, BOX, NATURAL)).toBeNull();
		expect(pointToFrame({ x: 10, y: 201 }, IDENTITY_VIEW, BOX, NATURAL)).toBeNull();
		expect(pointToFrame({ x: 10, y: 10 }, IDENTITY_VIEW, BOX, { width: 0, height: 0 })).toBeNull();
	});

	it('keeps the edges on the frame', () => {
		expect(pointToFrame({ x: 320, y: 200 }, IDENTITY_VIEW, BOX, NATURAL)).toEqual({ x: 1280, y: 800 });
		expect(pointToFrame({ x: 0, y: 0 }, IDENTITY_VIEW, BOX, NATURAL)).toEqual({ x: 0, y: 0 });
	});
});

describe('deltaToFrame', () => {
	it('converts finger travel to frame pixels', () => {
		expect(deltaToFrame({ x: 0, y: -50 }, IDENTITY_VIEW, BOX, NATURAL)).toEqual({ x: 0, y: -200 });
	});

	it('moves less per screen pixel when the picture is zoomed in', () => {
		expect(deltaToFrame({ x: 40, y: -50 }, { zoom: 2, tx: 0, ty: 0 }, BOX, NATURAL)).toEqual({ x: 80, y: -100 });
	});

	it('is zero before the picture has a size', () => {
		expect(deltaToFrame({ x: 5, y: 5 }, IDENTITY_VIEW, { width: 0, height: 0 }, NATURAL)).toEqual({ x: 0, y: 0 });
	});
});

describe('clampView', () => {
	it('keeps the zoomed picture covering its box', () => {
		expect(clampView({ zoom: 2, tx: 50, ty: -900 }, BOX)).toEqual({ zoom: 2, tx: 0, ty: -200 });
	});

	it('caps the zoom and snaps nearly-1x back to fit', () => {
		expect(clampView({ zoom: 99, tx: 0, ty: 0 }, BOX).zoom).toBe(MAX_ZOOM);
		expect(clampView({ zoom: 1.01, tx: -3, ty: -3 }, BOX)).toEqual(IDENTITY_VIEW);
		expect(clampView({ zoom: 0.3, tx: 10, ty: 10 }, BOX)).toEqual(IDENTITY_VIEW);
		expect(clampView({ zoom: Number.NaN, tx: 0, ty: 0 }, BOX)).toEqual(IDENTITY_VIEW);
	});
});

describe('pinchView', () => {
	it('fingers spreading to twice the distance zoom 2x around their midpoint', () => {
		const v = pinchView(IDENTITY_VIEW, { x: 140, y: 100 }, { x: 180, y: 100 }, { x: 120, y: 100 }, { x: 200, y: 100 }, BOX);
		expect(v.zoom).toBeCloseTo(2);
		// The picture point under the midpoint (160, 100) is still under it.
		expect(pointToFrame({ x: 160, y: 100 }, v, BOX, NATURAL)).toEqual({ x: 640, y: 400 });
	});

	it('moving both fingers together pans a zoomed picture', () => {
		const start = { zoom: 2, tx: -160, ty: -100 };
		const v = pinchView(start, { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 130, y: 100 }, { x: 230, y: 100 }, BOX);
		expect(v.zoom).toBeCloseTo(2);
		expect(v.tx).toBeCloseTo(-130);
	});

	it('pinching in past fit returns to fit, never smaller', () => {
		const v = pinchView({ zoom: 2, tx: -100, ty: -50 }, { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 90, y: 0 }, { x: 110, y: 0 }, BOX);
		expect(v).toEqual(IDENTITY_VIEW);
	});
});

describe('zoomAround', () => {
	it('zooms keeping the point under the cursor fixed', () => {
		const v = zoomAround(IDENTITY_VIEW, { x: 80, y: 40 }, 2, BOX);
		expect(v.zoom).toBe(2);
		expect(pointToFrame({ x: 80, y: 40 }, v, BOX, NATURAL)).toEqual({ x: 320, y: 160 });
	});
});

describe('classifyOneFinger', () => {
	it('a short press that stays put is a tap', () => {
		expect(classifyOneFinger(0, 120)).toBe('tap');
		expect(classifyOneFinger(TAP_SLOP_PX, TAP_MAX_MS)).toBe('tap');
	});

	it('moving past the slop is a swipe, however quick', () => {
		expect(classifyOneFinger(TAP_SLOP_PX + 1, 30)).toBe('swipe');
	});

	it('a long hold that does not move does nothing', () => {
		expect(classifyOneFinger(2, TAP_MAX_MS + 1)).toBe('none');
	});
});

describe('withFling', () => {
	it('a flick coasts further than the finger went', () => {
		expect(withFling({ x: 0, y: -100 }, { x: 0, y: -2 })).toEqual({ x: 0, y: -700 });
	});

	it('a slow drag scrolls exactly as far as the finger went', () => {
		expect(withFling({ x: 10, y: -100 }, { x: 0.05, y: -0.1 })).toEqual({ x: 10, y: -100 });
	});
});

describe('containRect', () => {
	it('letterboxes a wide frame in a tall box', () => {
		expect(containRect({ width: 390, height: 700 }, NATURAL)).toEqual({ left: 0, top: 228.125, width: 390, height: 243.75 });
	});

	it('pillarboxes a tall frame in a wide box', () => {
		const r = containRect({ width: 1000, height: 400 }, { width: 400, height: 800 });
		expect(r).toEqual({ left: 400, top: 0, width: 200, height: 400 });
	});
});
