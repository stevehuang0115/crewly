/**
 * Gesture math for driving a remote browser from a picture of it.
 *
 * The owner is usually on a phone. They see a frame of the remote page, and
 * three gestures have to mean three different things:
 *
 * - **tap** clicks that spot on the remote page;
 * - **one-finger drag** scrolls the remote page, under the finger;
 * - **two-finger pinch** zooms the picture here, so small text and buttons
 *   can be hit. It never zooms the remote page.
 *
 * Everything here is pure so it can be tested without a browser. Points are
 * in the frame image's *layout box* (its untransformed CSS box), which the
 * local zoom then scales and pans with `translate(tx, ty) scale(zoom)` and
 * `transform-origin: 0 0`.
 *
 * @module utils/frame-gestures
 */

/** A 2D point or vector. */
export interface Point {
	x: number;
	y: number;
}

/** A width and height. */
export interface Size {
	width: number;
	height: number;
}

/** The local zoom applied to the frame picture. */
export interface ZoomView {
	/** Scale, 1 = fit */
	zoom: number;
	/** Horizontal pan in layout-box pixels */
	tx: number;
	/** Vertical pan in layout-box pixels */
	ty: number;
}

/** No zoom, no pan. */
export const IDENTITY_VIEW: ZoomView = { zoom: 1, tx: 0, ty: 0 };
/** Furthest the picture can be zoomed in. */
export const MAX_ZOOM = 5;
/** Below this the view snaps back to fit, so "almost 1×" never lingers. */
const SNAP_TO_FIT = 1.03;
/** How far a finger may wander and still count as a tap (CSS px). */
export const TAP_SLOP_PX = 10;
/** Longest press that still counts as a tap (ms); longer is a hold, which does nothing. */
export const TAP_MAX_MS = 800;
/** How long a fling keeps going, for the extra scroll it adds (ms). */
const FLING_MS = 300;
/** Slowest finger speed that counts as a fling (CSS px per ms). */
const FLING_MIN_SPEED = 0.4;

/**
 * Keep a view inside sensible bounds: zoom between fit and {@link MAX_ZOOM},
 * and panned so the zoomed picture still covers its own box (no empty gap
 * dragged into view).
 *
 * @param view - Proposed view
 * @param box - The picture's layout box
 * @returns The clamped view
 *
 * @example
 * ```typescript
 * clampView({ zoom: 2, tx: 50, ty: -900 }, { width: 400, height: 300 }); // { zoom: 2, tx: 0, ty: -300 }
 * ```
 */
export function clampView(view: ZoomView, box: Size): ZoomView {
	const zoom = Math.min(MAX_ZOOM, Math.max(1, Number.isFinite(view.zoom) ? view.zoom : 1));
	if (zoom < SNAP_TO_FIT) return { ...IDENTITY_VIEW };
	const minTx = box.width - box.width * zoom;
	const minTy = box.height - box.height * zoom;
	return {
		zoom,
		tx: Math.min(0, Math.max(minTx, view.tx)),
		ty: Math.min(0, Math.max(minTy, view.ty)),
	};
}

/**
 * The view during a pinch.
 *
 * The picture point that was under the two fingers' midpoint when the pinch
 * began stays under their midpoint now, so pinching both zooms and pans the
 * way a photo viewer does.
 *
 * @param start - View when the pinch began
 * @param startA - First finger at the start, in layout-box px
 * @param startB - Second finger at the start
 * @param nowA - First finger now
 * @param nowB - Second finger now
 * @param box - The picture's layout box
 * @returns The new (clamped) view
 */
export function pinchView(
	start: ZoomView,
	startA: Point,
	startB: Point,
	nowA: Point,
	nowB: Point,
	box: Size,
): ZoomView {
	const d0 = Math.hypot(startB.x - startA.x, startB.y - startA.y);
	const d1 = Math.hypot(nowB.x - nowA.x, nowB.y - nowA.y);
	const m0 = { x: (startA.x + startB.x) / 2, y: (startA.y + startB.y) / 2 };
	const m1 = { x: (nowA.x + nowB.x) / 2, y: (nowA.y + nowB.y) / 2 };
	const ratio = d0 > 0 ? d1 / d0 : 1;
	const zoom = Math.min(MAX_ZOOM, Math.max(1, start.zoom * ratio));
	// Picture point under the starting midpoint, in unzoomed box px.
	const cx = (m0.x - start.tx) / start.zoom;
	const cy = (m0.y - start.ty) / start.zoom;
	return clampView({ zoom, tx: m1.x - cx * zoom, ty: m1.y - cy * zoom }, box);
}

/**
 * Zoom by a factor around a point (a desktop ctrl+wheel or trackpad pinch).
 *
 * @param view - Current view
 * @param at - Point to zoom around, in layout-box px
 * @param factor - Multiplier, e.g. 1.1
 * @param box - The picture's layout box
 * @returns The new view
 */
export function zoomAround(view: ZoomView, at: Point, factor: number, box: Size): ZoomView {
	const zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom * factor));
	const cx = (at.x - view.tx) / view.zoom;
	const cy = (at.y - view.ty) / view.zoom;
	return clampView({ zoom, tx: at.x - cx * zoom, ty: at.y - cy * zoom }, box);
}

/**
 * Where a point on screen falls on the frame, in the frame's own pixels.
 *
 * Undoes the local zoom and pan, then scales from the layout box to the
 * frame's natural size. The backend maps frame pixels on to the remote page
 * (it alone knows the page's CSS size and device pixel ratio).
 *
 * @param local - Point relative to the layout box's top-left, in CSS px
 * @param view - Current local zoom
 * @param box - The picture's layout box
 * @param natural - The frame's natural size
 * @returns The frame point, or null when outside the picture or nothing is loaded
 *
 * @example
 * ```typescript
 * // 1280x800 frame shown 320x200, zoomed 2x and panned to its centre:
 * pointToFrame({ x: 160, y: 100 }, { zoom: 2, tx: -160, ty: -100 }, { width: 320, height: 200 }, { width: 1280, height: 800 });
 * // → { x: 640, y: 400 }
 * ```
 */
export function pointToFrame(local: Point, view: ZoomView, box: Size, natural: Size): Point | null {
	if (!(box.width > 0 && box.height > 0 && natural.width > 0 && natural.height > 0)) return null;
	const cx = (local.x - view.tx) / view.zoom;
	const cy = (local.y - view.ty) / view.zoom;
	if (cx < 0 || cy < 0 || cx > box.width || cy > box.height) return null;
	return {
		x: Math.round((cx / box.width) * natural.width),
		y: Math.round((cy / box.height) * natural.height),
	};
}

/**
 * A finger movement on screen, in frame pixels.
 *
 * @param delta - Movement in CSS px on screen
 * @param view - Current local zoom (a zoomed picture moves further per frame pixel)
 * @param box - The picture's layout box
 * @param natural - The frame's natural size
 * @returns The movement in frame pixels
 */
export function deltaToFrame(delta: Point, view: ZoomView, box: Size, natural: Size): Point {
	if (!(box.width > 0 && box.height > 0)) return { x: 0, y: 0 };
	return {
		x: (delta.x / view.zoom / box.width) * natural.width,
		y: (delta.y / view.zoom / box.height) * natural.height,
	};
}

/**
 * Add a fling to a swipe: a quick flick scrolls further than the finger
 * travelled, the way a phone's own scrolling coasts.
 *
 * @param delta - Finger travel (any unit)
 * @param velocity - Finger speed at release, in CSS px per ms (same direction convention)
 * @returns The travel plus the coast
 */
export function withFling(delta: Point, velocity: Point): Point {
	const coast = (v: number): number => (Math.abs(v) >= FLING_MIN_SPEED ? v * FLING_MS : 0);
	return { x: delta.x + coast(velocity.x), y: delta.y + coast(velocity.y) };
}

/** What a finished one-finger gesture was. */
export type OneFingerGesture = 'tap' | 'swipe' | 'none';

/**
 * Classify a one-finger gesture once the finger lifts.
 *
 * @param travel - Largest distance from the start the finger reached (CSS px)
 * @param durationMs - Time from down to up
 * @returns `tap` for a short press that stayed put, `swipe` for a drag, else `none`
 */
export function classifyOneFinger(travel: number, durationMs: number): OneFingerGesture {
	if (travel > TAP_SLOP_PX) return 'swipe';
	return durationMs <= TAP_MAX_MS ? 'tap' : 'none';
}

/**
 * The drawn image inside a box with `object-fit: contain` — the letterboxed
 * area that actually holds pixels.
 *
 * @param box - The element's box
 * @param natural - The image's natural size
 * @returns The content rect, relative to the box
 */
export function containRect(box: Size, natural: Size): { left: number; top: number; width: number; height: number } {
	if (!(box.width > 0 && box.height > 0 && natural.width > 0 && natural.height > 0)) {
		return { left: 0, top: 0, width: box.width, height: box.height };
	}
	const scale = Math.min(box.width / natural.width, box.height / natural.height);
	const width = natural.width * scale;
	const height = natural.height * scale;
	return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}
