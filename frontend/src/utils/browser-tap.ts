/**
 * Where on a live browser frame the owner tapped.
 *
 * The frame is shown scaled to fit the card or the phone screen, so a click's
 * position on the `<img>` is in rendered pixels. The backend wants it in the
 * frame's own pixels (its natural size) and does the rest — mapping to the
 * page's CSS viewport — itself, because only it can measure the page.
 *
 * @module utils/browser-tap
 */

/** A tap in the frame's natural pixel space, as the input endpoint takes it. */
export interface FrameTap {
	x: number;
	y: number;
	frameWidth: number;
	frameHeight: number;
}

/**
 * Convert a position on the rendered image to the frame's own pixels.
 *
 * @param offsetX - X from the image's left edge, in rendered pixels
 * @param offsetY - Y from the image's top edge, in rendered pixels
 * @param renderedWidth - Width the image is drawn at
 * @param renderedHeight - Height the image is drawn at
 * @param naturalWidth - The frame's own width
 * @param naturalHeight - The frame's own height
 * @returns The tap, or null when the image has no size yet (not loaded)
 *
 * @example
 * ```typescript
 * // A 1280×800 frame drawn 320 wide on a phone: a tap at (160, 50) is (640, 200).
 * frameTapPoint(160, 50, 320, 200, 1280, 800); // { x: 640, y: 200, frameWidth: 1280, frameHeight: 800 }
 * ```
 */
export function frameTapPoint(
	offsetX: number,
	offsetY: number,
	renderedWidth: number,
	renderedHeight: number,
	naturalWidth: number,
	naturalHeight: number,
): FrameTap | null {
	if (!(renderedWidth > 0 && renderedHeight > 0 && naturalWidth > 0 && naturalHeight > 0)) return null;
	const fx = Math.max(0, Math.min(1, offsetX / renderedWidth));
	const fy = Math.max(0, Math.min(1, offsetY / renderedHeight));
	return {
		x: Math.round(fx * naturalWidth),
		y: Math.round(fy * naturalHeight),
		frameWidth: naturalWidth,
		frameHeight: naturalHeight,
	};
}

/**
 * The tap for a pointer event on an image element.
 *
 * Measured from the bounding box rather than `offsetX`, which some browsers
 * report relative to a padding or border edge and which touch events lack.
 *
 * @param clientX - Pointer X in the viewport
 * @param clientY - Pointer Y in the viewport
 * @param img - The frame image
 * @returns The tap plus where to draw the ripple, or null when not measurable
 */
export function frameTapFromEvent(
	clientX: number,
	clientY: number,
	img: HTMLImageElement,
): { tap: FrameTap; renderedX: number; renderedY: number } | null {
	const rect = img.getBoundingClientRect();
	const renderedX = clientX - rect.left;
	const renderedY = clientY - rect.top;
	const tap = frameTapPoint(renderedX, renderedY, rect.width, rect.height, img.naturalWidth, img.naturalHeight);
	return tap ? { tap, renderedX, renderedY } : null;
}
