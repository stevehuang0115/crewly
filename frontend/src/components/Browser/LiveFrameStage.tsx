/**
 * LiveFrameStage — the picture of an agent's browser, made drivable by touch.
 *
 * While the owner holds the browser:
 *
 * - a **tap** clicks that spot on the remote page;
 * - a **one-finger drag** scrolls the remote page under the finger (with a
 *   flick coasting further), and the picture follows the finger until the
 *   fresh frame arrives;
 * - a **two-finger pinch** zooms and pans this picture only — the remote
 *   page is untouched — so small targets can be hit; "Reset zoom" undoes it;
 * - on a desktop, the **mouse wheel** scrolls the remote page and
 *   ctrl+wheel (or a trackpad pinch) zooms the picture.
 *
 * Gestures are handled with Pointer Events on the stage, with
 * `touch-action: none` so the phone does not pan or zoom the dashboard
 * instead. Nothing is handled while the owner is only watching, so the page
 * scrolls and zooms normally then.
 *
 * @module components/Browser/LiveFrameStage
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@crewly/ui/Button';
import type { OwnerBrowserInput } from '../../services/browser-session.service';
import {
	IDENTITY_VIEW,
	classifyOneFinger,
	clampView,
	deltaToFrame,
	pinchView,
	pointToFrame,
	withFling,
	zoomAround,
	type Point,
	type Size,
	type ZoomView,
} from '../../utils/frame-gestures';

/** How long the tap ripple stays on screen (ms). */
const RIPPLE_MS = 600;
/** Quiet time after the last wheel tick before the scroll is sent (ms). */
const WHEEL_FLUSH_MS = 140;
/** Pixels per wheel "line", for mice that report lines. */
const WHEEL_LINE_PX = 16;
/** Window over which finger speed is measured at release (ms). */
const VELOCITY_WINDOW_MS = 90;

/** Props for {@link LiveFrameStage}. */
export interface LiveFrameStageProps {
	/** Image source of the current frame (a good frame — callers never pass a failed one) */
	src: string;
	/** Alt text */
	alt: string;
	/** Whether the owner holds the browser; gestures do nothing otherwise */
	driving: boolean;
	/** Carry out one input on the remote page */
	onInput: (input: OwnerBrowserInput) => Promise<boolean>;
	/** Fill the parent (fullscreen) instead of taking the full width */
	fill?: boolean;
	/** Extra classes for the image (border, radius) */
	imageClassName?: string;
}

/** One finger's recent positions, for its speed at release. */
interface Sample {
	p: Point;
	t: number;
}

/** What the fingers on the stage are doing. */
type Gesture =
	| { mode: 'idle' }
	| { mode: 'one'; id: number; start: Point; startAt: number; travel: number; samples: Sample[] }
	| { mode: 'pinch'; ids: [number, number]; startView: ZoomView; a: Point; b: Point }
	/** A pinch ended with a finger still down: ignore it until all lift. */
	| { mode: 'spent' };

/**
 * The drivable frame picture.
 *
 * @param props - See {@link LiveFrameStageProps}
 * @returns The stage
 */
export function LiveFrameStage({ src, alt, driving, onInput, fill = false, imageClassName = '' }: LiveFrameStageProps) {
	const stageRef = useRef<HTMLDivElement | null>(null);
	const imgRef = useRef<HTMLImageElement | null>(null);
	const [view, setViewState] = useState<ZoomView>(IDENTITY_VIEW);
	const viewRef = useRef<ZoomView>(IDENTITY_VIEW);
	const [drag, setDrag] = useState<Point | null>(null);
	const [ripple, setRipple] = useState<{ x: number; y: number; id: number } | null>(null);
	const pointers = useRef(new Map<number, Point>());
	const gesture = useRef<Gesture>({ mode: 'idle' });
	const wheel = useRef<{ dx: number; dy: number; at: Point; timer: ReturnType<typeof setTimeout> | null }>({
		dx: 0,
		dy: 0,
		at: { x: 0, y: 0 },
		timer: null,
	});
	const onInputRef = useRef(onInput);
	onInputRef.current = onInput;

	const setView = useCallback((next: ZoomView) => {
		viewRef.current = next;
		setViewState(next);
	}, []);

	/** The picture's untransformed box: where it sits on screen and its size. */
	const layoutBox = useCallback((): { origin: Point; box: Size; natural: Size } | null => {
		const stage = stageRef.current;
		const img = imgRef.current;
		if (!stage || !img) return null;
		const rect = stage.getBoundingClientRect();
		return {
			origin: { x: rect.left + img.offsetLeft, y: rect.top + img.offsetTop },
			box: { width: img.offsetWidth, height: img.offsetHeight },
			natural: { width: img.naturalWidth, height: img.naturalHeight },
		};
	}, []);

	/** A client point relative to the picture's untransformed box. */
	const toLocal = useCallback(
		(client: Point): Point | null => {
			const lb = layoutBox();
			return lb ? { x: client.x - lb.origin.x, y: client.y - lb.origin.y } : null;
		},
		[layoutBox],
	);

	const tap = useCallback(
		(client: Point) => {
			const lb = layoutBox();
			const stage = stageRef.current;
			if (!lb || !stage) return;
			const local = { x: client.x - lb.origin.x, y: client.y - lb.origin.y };
			const hit = pointToFrame(local, viewRef.current, lb.box, lb.natural);
			if (!hit) return;
			const rect = stage.getBoundingClientRect();
			const id = Date.now();
			setRipple({ x: client.x - rect.left, y: client.y - rect.top, id });
			setTimeout(() => setRipple((r) => (r?.id === id ? null : r)), RIPPLE_MS);
			void onInputRef.current({ kind: 'tap', x: hit.x, y: hit.y, frameWidth: lb.natural.width, frameHeight: lb.natural.height });
		},
		[layoutBox],
	);

	/**
	 * Send a scroll that started at a client point and moved by `delta` (CSS
	 * px on screen, finger direction).
	 */
	const swipe = useCallback(
		async (startClient: Point, delta: Point) => {
			const lb = layoutBox();
			if (!lb || !(lb.natural.width > 0)) {
				setDrag(null);
				return;
			}
			const v = viewRef.current;
			const local = { x: startClient.x - lb.origin.x, y: startClient.y - lb.origin.y };
			// A swipe may start on the very edge; clamp the start onto the picture.
			const start =
				pointToFrame(local, v, lb.box, lb.natural) ??
				pointToFrame(
					{
						x: Math.min(Math.max(local.x, v.tx), v.tx + lb.box.width * v.zoom),
						y: Math.min(Math.max(local.y, v.ty), v.ty + lb.box.height * v.zoom),
					},
					v,
					lb.box,
					lb.natural,
				);
			const d = deltaToFrame(delta, v, lb.box, lb.natural);
			const dx = Math.round(d.x);
			const dy = Math.round(d.y);
			if (!start || (dx === 0 && dy === 0)) {
				setDrag(null);
				return;
			}
			try {
				await onInputRef.current({
					kind: 'swipe',
					x: start.x,
					y: start.y,
					dx,
					dy,
					frameWidth: lb.natural.width,
					frameHeight: lb.natural.height,
				});
			} finally {
				// The reply carries the scrolled frame; drop the finger preview.
				setDrag(null);
			}
		},
		[layoutBox],
	);

	useEffect(() => {
		const stage = stageRef.current;
		if (!stage || !driving) return;

		const pointOf = (e: PointerEvent): Point => ({ x: e.clientX, y: e.clientY });
		const onControl = (e: Event): boolean => Boolean((e.target as HTMLElement | null)?.closest?.('button'));

		const down = (e: PointerEvent): void => {
			if (onControl(e) || (e.pointerType === 'mouse' && e.button !== 0)) return;
			e.preventDefault();
			try {
				stage.setPointerCapture(e.pointerId);
			} catch {
				// Not capturable (synthetic event); moves still arrive on the stage.
			}
			pointers.current.set(e.pointerId, pointOf(e));
			const g = gesture.current;
			if (pointers.current.size === 1 && g.mode === 'idle') {
				const p = pointOf(e);
				const t = performance.now();
				gesture.current = { mode: 'one', id: e.pointerId, start: p, startAt: t, travel: 0, samples: [{ p, t }] };
			} else if (pointers.current.size === 2 && (g.mode === 'one' || g.mode === 'idle')) {
				const [[idA, pa], [idB, pb]] = Array.from(pointers.current.entries());
				const a = toLocal(pa);
				const b = toLocal(pb);
				setDrag(null);
				gesture.current = a && b ? { mode: 'pinch', ids: [idA, idB], startView: viewRef.current, a, b } : { mode: 'spent' };
			}
		};

		const move = (e: PointerEvent): void => {
			if (!pointers.current.has(e.pointerId)) return;
			e.preventDefault();
			const p = pointOf(e);
			pointers.current.set(e.pointerId, p);
			const g = gesture.current;
			if (g.mode === 'one' && g.id === e.pointerId) {
				g.travel = Math.max(g.travel, Math.hypot(p.x - g.start.x, p.y - g.start.y));
				const t = performance.now();
				g.samples.push({ p, t });
				while (g.samples.length > 2 && t - g.samples[0].t > VELOCITY_WINDOW_MS) g.samples.shift();
				if (classifyOneFinger(g.travel, 0) === 'swipe') setDrag({ x: p.x - g.start.x, y: p.y - g.start.y });
			} else if (g.mode === 'pinch') {
				const pa = pointers.current.get(g.ids[0]);
				const pb = pointers.current.get(g.ids[1]);
				const a = pa && toLocal(pa);
				const b = pb && toLocal(pb);
				const lb = layoutBox();
				if (a && b && lb) setView(pinchView(g.startView, g.a, g.b, a, b, lb.box));
			}
		};

		const up = (e: PointerEvent): void => {
			if (!pointers.current.has(e.pointerId)) return;
			const p = pointOf(e);
			pointers.current.delete(e.pointerId);
			const g = gesture.current;
			if (g.mode === 'one' && g.id === e.pointerId) {
				gesture.current = { mode: 'idle' };
				if (e.type === 'pointercancel') {
					setDrag(null);
					return;
				}
				const t = performance.now();
				const kind = classifyOneFinger(Math.max(g.travel, Math.hypot(p.x - g.start.x, p.y - g.start.y)), t - g.startAt);
				if (kind === 'tap') {
					setDrag(null);
					tap(g.start);
				} else if (kind === 'swipe') {
					const first = g.samples[0];
					const dt = Math.max(1, t - first.t);
					const velocity = { x: (p.x - first.p.x) / dt, y: (p.y - first.p.y) / dt };
					const delta = withFling({ x: p.x - g.start.x, y: p.y - g.start.y }, velocity);
					void swipe(g.start, delta);
				} else {
					setDrag(null);
				}
				return;
			}
			if (g.mode === 'pinch' || g.mode === 'spent') {
				gesture.current = pointers.current.size === 0 ? { mode: 'idle' } : { mode: 'spent' };
				return;
			}
			if (pointers.current.size === 0) gesture.current = { mode: 'idle' };
		};

		const onWheel = (e: WheelEvent): void => {
			e.preventDefault();
			const local = toLocal({ x: e.clientX, y: e.clientY });
			const lb = layoutBox();
			if (!local || !lb) return;
			const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? lb.box.height : 1;
			if (e.ctrlKey) {
				// Trackpad pinch (and ctrl+wheel) zooms the picture, never the page.
				setView(zoomAround(viewRef.current, local, Math.exp((-e.deltaY * unit) / 200), lb.box));
				return;
			}
			const w = wheel.current;
			if (w.dx === 0 && w.dy === 0) w.at = { x: e.clientX, y: e.clientY };
			// A wheel scrolls down for positive delta; a finger does for negative.
			w.dx -= e.deltaX * unit;
			w.dy -= e.deltaY * unit;
			if (w.timer) clearTimeout(w.timer);
			w.timer = setTimeout(() => {
				const { dx, dy, at } = wheel.current;
				wheel.current = { dx: 0, dy: 0, at, timer: null };
				if (dx !== 0 || dy !== 0) void swipe(at, { x: dx, y: dy });
			}, WHEEL_FLUSH_MS);
		};

		// iOS Safari's own pinch gesture events: keep it from zooming the dashboard.
		const noGesture = (e: Event): void => e.preventDefault();
		const noTouchScroll = (e: TouchEvent): void => {
			if (!onControl(e)) e.preventDefault();
		};

		stage.addEventListener('pointerdown', down);
		stage.addEventListener('pointermove', move);
		stage.addEventListener('pointerup', up);
		stage.addEventListener('pointercancel', up);
		stage.addEventListener('wheel', onWheel, { passive: false });
		stage.addEventListener('gesturestart', noGesture);
		stage.addEventListener('gesturechange', noGesture);
		stage.addEventListener('touchmove', noTouchScroll, { passive: false });
		const pointerMap = pointers.current;
		const wheelState = wheel.current;
		return () => {
			stage.removeEventListener('pointerdown', down);
			stage.removeEventListener('pointermove', move);
			stage.removeEventListener('pointerup', up);
			stage.removeEventListener('pointercancel', up);
			stage.removeEventListener('wheel', onWheel);
			stage.removeEventListener('gesturestart', noGesture);
			stage.removeEventListener('gesturechange', noGesture);
			stage.removeEventListener('touchmove', noTouchScroll);
			pointerMap.clear();
			gesture.current = { mode: 'idle' };
			if (wheelState.timer) clearTimeout(wheelState.timer);
		};
	}, [driving, layoutBox, setView, swipe, tap, toLocal]);

	// The box changes size when entering or leaving fullscreen; keep the pan valid.
	useEffect(() => {
		const lb = layoutBox();
		if (lb) setView(clampView(viewRef.current, lb.box));
	}, [fill, layoutBox, setView]);

	const tx = view.tx + (drag?.x ?? 0);
	const ty = view.ty + (drag?.y ?? 0);
	const zoomed = view.zoom > 1;

	return (
		<div
			ref={stageRef}
			data-testid="frame-stage"
			className={`relative select-none overflow-hidden ${fill ? 'flex h-full w-full items-center justify-center' : ''} ${
				driving ? 'cursor-crosshair touch-none' : ''
			}`}
			style={{ WebkitTouchCallout: 'none', WebkitUserSelect: 'none' }}
		>
			<img
				ref={imgRef}
				src={src}
				alt={alt}
				draggable={false}
				data-testid="frame-image"
				className={`block select-none ${fill ? 'max-h-full max-w-full' : 'w-full'} ${imageClassName}`}
				style={{
					transform: zoomed || drag ? `translate(${tx}px, ${ty}px) scale(${view.zoom})` : undefined,
					transformOrigin: '0 0',
				}}
			/>
			{ripple && (
				<span
					aria-hidden="true"
					data-testid="tap-ripple"
					className="pointer-events-none absolute -ml-3 -mt-3 h-6 w-6 animate-ping rounded-full border-2 border-attention"
					style={{ left: ripple.x, top: ripple.y }}
				/>
			)}
			{zoomed && (
				<Button
					type="button"
					variant="secondary"
					size="xs"
					className="absolute right-2 top-2"
					onClick={() => setView(IDENTITY_VIEW)}
					data-testid="reset-zoom"
				>
					Reset zoom ({view.zoom.toFixed(1)}×)
				</Button>
			)}
		</div>
	);
}
