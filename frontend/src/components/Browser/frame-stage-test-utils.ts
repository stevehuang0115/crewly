/**
 * Test helpers for the drivable frame: jsdom has no layout and no touch, so
 * these give a stage the geometry a phone would and fire touch pointers.
 *
 * @module components/Browser/frame-stage-test-utils
 */

import { fireEvent } from '@testing-library/react';

/**
 * Give the stage and its image the layout a loaded frame on a phone has.
 *
 * @param stage - The `frame-stage` element
 * @param img - The frame image
 * @param box - Drawn size (default 320x200 at the top-left)
 * @param natural - Frame size (default 1280x800)
 */
export function layOut(
	stage: HTMLElement,
	img: HTMLElement,
	box = { width: 320, height: 200 },
	natural = { width: 1280, height: 800 },
): void {
	stage.getBoundingClientRect = () =>
		({ left: 0, top: 0, right: box.width, bottom: box.height, width: box.width, height: box.height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
	const props = {
		offsetLeft: 0,
		offsetTop: 0,
		offsetWidth: box.width,
		offsetHeight: box.height,
		naturalWidth: natural.width,
		naturalHeight: natural.height,
	};
	for (const [k, v] of Object.entries(props)) Object.defineProperty(img, k, { value: v, configurable: true });
}

/**
 * Fire a touch pointer event.
 *
 * @param el - Target
 * @param type - Which pointer event
 * @param id - Pointer (finger) id
 * @param x - clientX
 * @param y - clientY
 */
export function touch(el: Element, type: 'pointerDown' | 'pointerMove' | 'pointerUp', id: number, x: number, y: number): void {
	fireEvent[type](el, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, isPrimary: id === 1, button: 0 });
}
