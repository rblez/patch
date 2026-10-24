// Anchored positioning in the browser. Patch owns the geometry: an anchored
// element's position (and any anchor-relative size) is derived from its
// anchor's rendered box with schema/anchor.ts. It is recomputed after every
// render (the renderer calls `update`) and whenever boxes can move without
// one: the viewport resizes, anything scrolls, or an anchor or anchored
// element changes size. Patch has no transforms or animations, so nothing
// moves between those and no per-frame tracking is needed.
//
// An anchored element is still absolutely positioned inside its rendered
// parent, so the world position is converted into that parent's coordinates.
// It is hidden while it has no rendered anchor, or while its anchor is
// scrolled or clipped completely out of view.

import { available, boundary, choosePlacement, intersect, positionAt, type Anchored, type Rect } from '../schema/anchor';

export type Anchoring = ReturnType<typeof createAnchoring>;

export type AnchorSpec = Anchored & { anchor: Element | null };

/** Inline properties the engine sets, and which spec field makes it own each one (always: left/top/visibility). */
const OWNED: [string, keyof AnchorSpec | null][] = [
	['left', null],
	['top', null],
	['visibility', null],
	['width', 'matchWidth'],
	['height', 'matchHeight'],
	['max-width', 'availableWidth'],
	['max-height', 'availableHeight']
];

const rectOf = (r: DOMRect): Rect => ({ x: r.left, y: r.top, width: r.width, height: r.height });

/** The padding box of an element, in viewport coordinates: what it clips its content to. */
function clipBox(el: Element): Rect {
	const r = el.getBoundingClientRect();
	return { x: r.left + el.clientLeft, y: r.top + el.clientTop, width: el.clientWidth, height: el.clientHeight };
}

export function createAnchoring(host: HTMLElement) {
	const anchored = new Map<HTMLElement, AnchorSpec>();
	/** What the engine last wrote, per element and property. */
	const written = new Map<HTMLElement, Record<string, string>>();
	const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => update());
	const observed = new Set<Element>();

	/** Observes exactly the anchored elements and their anchors. */
	const reobserve = () => {
		const wanted = new Set<Element>();
		for (const [el, spec] of anchored) {
			wanted.add(el);
			if (spec.anchor) wanted.add(spec.anchor);
		}
		for (const el of observed) if (!wanted.has(el)) observer?.unobserve(el);
		for (const el of wanted) if (!observed.has(el)) observer?.observe(el);
		observed.clear();
		for (const el of wanted) observed.add(el);
	};

	/** Writes a property the engine owns. Returns whether it changed. */
	const write = (el: HTMLElement, key: string, value: string | null): boolean => {
		const mine = written.get(el) ?? {};
		written.set(el, mine);
		if ((mine[key] ?? null) === value) return false;
		if (value === null) {
			el.style.removeProperty(key);
			delete mine[key];
		} else el.style.setProperty(key, (mine[key] = value));
		return true;
	};

	const viewport = (): Rect => clipBox(host);

	/** Whether any part of the anchor can be seen: inside the viewport and every clipping ancestor. */
	const inView = (anchor: Element, rect: Rect): boolean => {
		let visible: Rect | null = intersect(rect, viewport());
		for (let p = anchor.parentElement; visible && p && p !== host; p = p.parentElement) {
			const cs = getComputedStyle(p);
			if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') visible = intersect(visible, clipBox(p));
		}
		return visible !== null;
	};

	/** Places one element. Returns whether anything it wrote changed. */
	const place = (el: HTMLElement, spec: AnchorSpec): boolean => {
		const anchor = spec.anchor;
		const parent = (el.offsetParent ?? el.parentElement) as HTMLElement | null;
		const rect = anchor?.isConnected ? rectOf(anchor.getBoundingClientRect()) : null;
		if (!anchor || !rect || !parent || !inView(anchor, rect)) return write(el, 'visibility', 'hidden');
		let changed = write(el, 'visibility', null);
		const bounds = boundary(viewport(), spec.options.padding);
		if (spec.matchWidth) changed = write(el, 'width', `${rect.width}px`) || changed;
		if (spec.matchHeight) changed = write(el, 'height', `${rect.height}px`) || changed;
		// The placement is chosen for the element's own size, then it gets the room that placement has.
		if (spec.availableWidth) write(el, 'max-width', null);
		if (spec.availableHeight) write(el, 'max-height', null);
		const natural = rectOf(el.getBoundingClientRect());
		const placement = choosePlacement(rect, natural, bounds, spec.options);
		let size = natural;
		if (spec.availableWidth || spec.availableHeight) {
			const room = available(rect, bounds, placement, spec.options.offset);
			if (spec.availableWidth) changed = write(el, 'max-width', `${room.width}px`) || changed;
			if (spec.availableHeight) changed = write(el, 'max-height', `${room.height}px`) || changed;
			size = rectOf(el.getBoundingClientRect());
		}
		const { x, y } = positionAt(rect, size, bounds, placement, spec.options);
		// left/top are inside the parent's padding box, which scrolls with it.
		const origin = parent.getBoundingClientRect();
		changed = write(el, 'left', `${x - origin.left - parent.clientLeft + parent.scrollLeft}px`) || changed;
		changed = write(el, 'top', `${y - origin.top - parent.clientTop + parent.scrollTop}px`) || changed;
		return changed;
	};

	/**
	 * Places every rendered anchored element. An anchor may itself be inside
	 * an anchored element, so this repeats (a few times at most) while
	 * something changed.
	 */
	const update = () => {
		for (let pass = 0; pass < 3; pass++) {
			let changed = false;
			for (const [el, spec] of anchored) if (el.isConnected && place(el, spec)) changed = true;
			if (!changed || anchored.size < 2) return;
		}
	};

	// Listening only while something is anchored.
	let listening = false;
	const listen = (on: boolean) => {
		if (on === listening) return;
		listening = on;
		if (on) {
			window.addEventListener('resize', update);
			document.addEventListener('scroll', update, { capture: true, passive: true });
		} else {
			window.removeEventListener('resize', update);
			document.removeEventListener('scroll', update, { capture: true });
		}
	};

	return {
		update,
		/** Whether any element is anchored: otherwise nothing needs placing after a render. */
		active: () => anchored.size > 0,
		/**
		 * Anchors `el` (`spec`), or stops (null). `own` is the element's own
		 * inline CSS: a property the engine stops owning is removed unless the
		 * element's style sets it.
		 */
		track(el: HTMLElement, spec: AnchorSpec | null, own: Record<string, string>) {
			if (spec) {
				anchored.set(el, spec);
				el.setAttribute('data-anchored', '');
			} else if (anchored.delete(el)) el.removeAttribute('data-anchored');
			const mine = written.get(el) ?? {};
			for (const [key, field] of OWNED)
				if (key in mine && !(spec && (field === null || spec[field]))) {
					delete mine[key];
					if (!(key in own)) el.style.removeProperty(key);
				}
			if (!spec) written.delete(el);
			reobserve();
			listen(anchored.size > 0);
		},
		dispose() {
			listen(false);
			observer?.disconnect();
		}
	};
}
