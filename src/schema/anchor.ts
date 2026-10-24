// Anchored positioning: where an absolute element with `anchor` goes, and how
// much room it has, given its anchor's rendered box. Every renderer measures
// boxes its own way and resolves them with these functions, so the geometry
// is the same in the browser and in snapshots.
//
//   anchor's world rect ─► placement (preferred, then fallbacks: flip)
//                       ─► available space at that placement (sizing)
//                       ─► top-left, shifted into the boundary (shift)
//
// The boundary is the viewport inset by `anchorPadding`. Renderers convert the
// world position into their element's parent's coordinates.

import type { Style } from './style';

export const ANCHOR_POSITIONS = [
	'top', 'top-start', 'top-end',
	'right', 'right-start', 'right-end',
	'bottom', 'bottom-start', 'bottom-end',
	'left', 'left-start', 'left-end'
];

/**
 * What a `bind:this` variable holds at design time, where there is no DOM:
 * an opaque stand-in for the element with that concrete id.
 */
export const DESIGN_NODE = Symbol.for('patch.designNode');
export type DesignNode = { readonly [DESIGN_NODE]: string };
export const isDesignNode = (v: unknown): v is DesignNode => !!v && typeof v === 'object' && DESIGN_NODE in v;

export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };

export type AnchorOptions = {
	position: string;
	offset: number;
	crossOffset: number;
	/** [top, right, bottom, left] */
	padding: [number, number, number, number];
	/** Explicit fallbacks, in order; null for the default. */
	fallbacks: string[] | null;
};

/** How an anchored element is placed and sized. Each renderer adds the anchor itself, in its own terms. */
export type Anchored = {
	options: AnchorOptions;
	/** `width: 'anchor'`, `height: 'anchor'`. */
	matchWidth: boolean;
	matchHeight: boolean;
	/** `maxWidth: 'available'`, `maxHeight: 'available'`. */
	availableWidth: boolean;
	availableHeight: boolean;
};

export const anchored = (st: Omit<Style, 'anchor'>): Anchored => ({
	options: {
		position: st.anchorPosition ?? 'bottom',
		offset: st.anchorOffset ?? 0,
		crossOffset: st.anchorCrossOffset ?? 0,
		padding: st.anchorPadding ?? [0, 0, 0, 0],
		fallbacks: st.anchorFallbacks ?? null
	},
	matchWidth: st.width === 'anchor',
	matchHeight: st.height === 'anchor',
	availableWidth: st.maxWidth === 'available',
	availableHeight: st.maxHeight === 'available'
});

const OPPOSITE: Record<string, string> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
const sideOf = (p: string) => p.split('-')[0];
const alignOf = (p: string) => p.split('-')[1] ?? 'center';
const vertical = (p: string) => sideOf(p) === 'top' || sideOf(p) === 'bottom';

/** The viewport inset by the padding: where anchored content should stay. */
export function boundary(viewport: Rect, [top, right, bottom, left]: AnchorOptions['padding']): Rect {
	return { x: viewport.x + left, y: viewport.y + top, width: Math.max(0, viewport.width - left - right), height: Math.max(0, viewport.height - top - bottom) };
}

/**
 * The placements tried, in order: the preferred one, then the explicit
 * fallbacks, or by default the opposite side with the same alignment.
 */
export function placements(o: AnchorOptions): string[] {
	const [side, align] = o.position.split('-');
	const fallbacks = o.fallbacks ?? [align ? `${OPPOSITE[side]}-${align}` : OPPOSITE[side]];
	return [...new Set([o.position, ...fallbacks])];
}

/**
 * The room a box has at `placement`: along the main axis, from the anchor
 * (past the offset) to the boundary's edge; across it, the whole boundary,
 * which shifting can reach.
 */
export function available(anchor: Rect, bounds: Rect, placement: string, offset: number): Size {
	const side = sideOf(placement);
	const main =
		side === 'bottom' ? bounds.y + bounds.height - (anchor.y + anchor.height + offset)
		: side === 'top' ? anchor.y - offset - bounds.y
		: side === 'right' ? bounds.x + bounds.width - (anchor.x + anchor.width + offset)
		: anchor.x - offset - bounds.x;
	const room = Math.max(0, main);
	return vertical(placement) ? { width: bounds.width, height: room } : { width: room, height: bounds.height };
}

/**
 * The placement for a box of `size` (flip): the first one in order whose
 * main axis fits in the boundary; when none fits, the one with the most room
 * along its main axis (the earliest of equals). Overflow across the main
 * axis never flips: shifting handles it.
 */
export function choosePlacement(anchor: Rect, size: Size, bounds: Rect, o: AnchorOptions): string {
	const order = placements(o);
	const room = (p: string) => {
		const space = available(anchor, bounds, p, o.offset);
		return vertical(p) ? space.height - size.height : space.width - size.width;
	};
	return order.find((p) => room(p) >= 0) ?? order.reduce((best, p) => (room(p) > room(best) ? p : best));
}

/**
 * The top-left of a box of `size` at `placement`: `offset` away from the
 * anchor on the main axis; aligned to it and moved by `crossOffset` across,
 * then shifted to stay in the boundary. A box larger than the boundary keeps
 * its start edge in it. The main axis is never shifted.
 */
export function positionAt(anchor: Rect, size: Size, bounds: Rect, placement: string, o: AnchorOptions): { x: number; y: number } {
	const side = sideOf(placement);
	const main =
		side === 'bottom' ? anchor.y + anchor.height + o.offset
		: side === 'top' ? anchor.y - o.offset - size.height
		: side === 'right' ? anchor.x + anchor.width + o.offset
		: anchor.x - o.offset - size.width;
	const v = vertical(placement);
	const [start, extent, length, min, room] = v
		? [anchor.x, anchor.width, size.width, bounds.x, bounds.width]
		: [anchor.y, anchor.height, size.height, bounds.y, bounds.height];
	const align = alignOf(placement);
	const aligned = (align === 'start' ? start : align === 'end' ? start + extent - length : start + (extent - length) / 2) + o.crossOffset;
	const cross = Math.max(min, Math.min(aligned, min + room - length));
	return v ? { x: cross, y: main } : { x: main, y: cross };
}

/** The part of `a` inside `b`, or null when they do not overlap. A zero-size `a` on `b`'s edge still counts. */
export function intersect(a: Rect, b: Rect): Rect | null {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	if (right < x || bottom < y) return null;
	if ((right === x && a.width > 0) || (bottom === y && a.height > 0)) return null;
	return { x, y, width: right - x, height: bottom - y };
}
