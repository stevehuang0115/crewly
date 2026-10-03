/**
 * useFullscreen — show one element across the whole screen.
 *
 * Uses the Fullscreen API where the browser offers it on ordinary elements
 * (desktop, Android Chrome, iPad Safari). iPhone Safari only allows video to
 * go fullscreen, so there — and wherever the request is refused — the caller
 * gets the same `active` state and lays the element out as a fixed
 * full-viewport overlay instead. Either way the caller renders one layout:
 * `active` means "fill the screen".
 *
 * While active the page behind stops scrolling, and Escape leaves the
 * overlay (the browser handles Escape itself in real fullscreen).
 *
 * @module hooks/useFullscreen
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** The prefixed names older WebKit uses. */
interface WebkitFullscreenElement extends HTMLElement {
	webkitRequestFullscreen?: () => Promise<void> | void;
}
interface WebkitFullscreenDocument extends Document {
	webkitFullscreenElement?: Element | null;
	webkitExitFullscreen?: () => Promise<void> | void;
}

/**
 * Whether an element can be put in real fullscreen.
 *
 * @param el - The element
 * @returns True when the Fullscreen API (standard or webkit-prefixed) is there
 */
export function canUseNativeFullscreen(el: HTMLElement | null): boolean {
	if (!el) return false;
	const w = el as WebkitFullscreenElement;
	return typeof w.requestFullscreen === 'function' || typeof w.webkitRequestFullscreen === 'function';
}

/** The element currently in real fullscreen, if any. */
function fullscreenElement(): Element | null {
	const d = document as WebkitFullscreenDocument;
	return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

/** What {@link useFullscreen} hands back. */
export interface FullscreenControls {
	/** Whether the element should fill the screen */
	active: boolean;
	/** True when the browser's own fullscreen is in use, false for the overlay */
	native: boolean;
	/** Fill the screen */
	enter: () => Promise<void>;
	/** Back to the normal page */
	exit: () => Promise<void>;
}

/**
 * Fullscreen for one element, falling back to an overlay.
 *
 * @param ref - The element to fill the screen with
 * @returns Controls and state
 *
 * @example
 * ```tsx
 * const surface = useRef<HTMLDivElement>(null);
 * const fs = useFullscreen(surface);
 * <div ref={surface} className={fs.active ? 'fixed inset-0 z-50' : ''}>…</div>
 * ```
 */
export function useFullscreen(ref: React.RefObject<HTMLElement | null>): FullscreenControls {
	const [active, setActive] = useState(false);
	const [native, setNative] = useState(false);
	const nativeRef = useRef(false);

	const enter = useCallback(async () => {
		setActive(true);
		const el = ref.current as WebkitFullscreenElement | null;
		if (!el || fullscreenElement()) return;
		try {
			if (typeof el.requestFullscreen === 'function') await el.requestFullscreen({ navigationUI: 'hide' });
			else if (typeof el.webkitRequestFullscreen === 'function') await el.webkitRequestFullscreen();
			else return;
			nativeRef.current = true;
			setNative(true);
		} catch {
			// Refused (no user gesture, iframe policy, iPhone): the overlay stays.
		}
	}, [ref]);

	const exit = useCallback(async () => {
		setActive(false);
		if (!nativeRef.current) return;
		nativeRef.current = false;
		setNative(false);
		const d = document as WebkitFullscreenDocument;
		try {
			if (fullscreenElement()) {
				if (typeof d.exitFullscreen === 'function') await d.exitFullscreen();
				else if (typeof d.webkitExitFullscreen === 'function') await d.webkitExitFullscreen();
			}
		} catch {
			// Already out.
		}
	}, []);

	// Leaving real fullscreen with the browser's own controls (Escape, swipe)
	// ends the mode here too.
	useEffect(() => {
		const onChange = (): void => {
			if (!fullscreenElement() && nativeRef.current) {
				nativeRef.current = false;
				setNative(false);
				setActive(false);
			}
		};
		document.addEventListener('fullscreenchange', onChange);
		document.addEventListener('webkitfullscreenchange', onChange);
		return () => {
			document.removeEventListener('fullscreenchange', onChange);
			document.removeEventListener('webkitfullscreenchange', onChange);
		};
	}, []);

	// While filling the screen: no page scroll behind, and Escape leaves the overlay.
	useEffect(() => {
		if (!active) return;
		const body = document.body;
		const before = body.style.overflow;
		body.style.overflow = 'hidden';
		const onKey = (e: KeyboardEvent): void => {
			const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable="true"]');
			if (e.key === 'Escape' && !nativeRef.current && !typing) void exit();
		};
		document.addEventListener('keydown', onKey);
		return () => {
			body.style.overflow = before;
			document.removeEventListener('keydown', onKey);
		};
	}, [active, exit]);

	// Leave fullscreen if the component goes away mid-way.
	useEffect(
		() => () => {
			if (nativeRef.current && fullscreenElement()) {
				const d = document as WebkitFullscreenDocument;
				void (d.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
			}
		},
		[],
	);

	return { active, native, enter, exit };
}
