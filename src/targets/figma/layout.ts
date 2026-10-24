// Auto-layout resolution: the size and position of every layer, so the pasted
// layers open at the size they render at. Widths are resolved before heights
// because a wrapped text's height depends on its width.
//
// Fill shares the free space of the main axis equally and stretches across
// it; hug is the content size; fixed is the value. min/max clamp the result.
//
// Baseline-aligned items of a row line up their first baselines, as in CSS:
// a text's first line, a frame's first item (in a row, its first
// baseline-aligned one), else the bottom edge.

import { available, boundary, choosePlacement, intersect, positionAt, type Rect } from '../../schema/anchor';
import type { FigmaFrame, FigmaNode, FigmaText } from './adapter';
import type { TextMeasure } from './text';

type Axis = 'width' | 'height';

const clamp = (node: FigmaNode, axis: Axis, v: number) => {
	const min = axis === 'width' ? node.minWidth : node.minHeight;
	const max = axis === 'width' ? node.maxWidth : node.maxHeight;
	return Math.max(min ?? 0, Math.min(max ?? Infinity, v));
};
const flow = (frame: FigmaFrame) => frame.children.filter((c) => !c.absolute);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const gaps = (frame: FigmaFrame, n: number) => frame.gap * Math.max(0, n - 1);

/** Lays out every layer, then places anchored layers (which may resize them and lay out again). */
export function layout(root: FigmaFrame, measure: TextMeasure) {
	const run = () => settle(root, measure);
	run();
	anchorLayers(root, run);
}

/**
 * Lays out until frame baselines settle: how a row's items line up sets its
 * height, and their baselines come from their own layout.
 */
function settle(root: FigmaFrame, measure: TextMeasure) {
	let known = new Map<FigmaNode, number>();
	for (let pass = 0; pass < 4; pass++) {
		const { baselines, aligned } = resolve(root, measure, known);
		const settled = baselines.size === known.size && [...baselines].every(([n, b]) => Math.abs((known.get(n) ?? NaN) - b) < 0.01);
		if (!aligned || settled) return;
		known = baselines;
	}
}

/**
 * One layout pass: every size and position from the sizing intents. `known`:
 * frame baselines from the previous pass, for the heights of rows. Returns
 * this pass's, and whether any row aligns baselines.
 */
function resolve(root: FigmaFrame, measure: TextMeasure, known: Map<FigmaNode, number>) {
	const hugWidths = new Map<FigmaNode, number>();
	const rows = new Map<FigmaFrame, FigmaNode[][]>();
	const baselines = new Map<FigmaNode, number>();
	let aligned = false;
	/** Text wraps at its width; truncated text also at a width it hugs, which may be limited. */
	const wraps = (n: FigmaText) => n.width.kind !== 'HUG' || n.maxLines !== undefined;
	const byBaseline = (frame: FigmaFrame, n: FigmaNode) => frame.direction === 'HORIZONTAL' && n.height.kind !== 'FILL' && (n.alignSelf ?? frame.align) === 'BASELINE';
	/** A layer's first baseline below its top, from `frames` for a frame (null: not known yet). */
	const baselineOf = (n: FigmaNode, frames: Map<FigmaNode, number>) => (n.type === 'TEXT' ? measure(n, wraps(n) ? n.w : undefined).baseline : (frames.get(n) ?? null));
	/**
	 * A row line's height: its tallest item, or its baseline-aligned items
	 * lined up, whichever is taller. `top`: where each of those goes.
	 */
	const lineOf = (frame: FigmaFrame, line: FigmaNode[], height: (n: FigmaNode) => number, frames: Map<FigmaNode, number>) => {
		const bases = new Map<FigmaNode, number>();
		for (const n of line) {
			const b = byBaseline(frame, n) ? baselineOf(n, frames) : null;
			if (b !== null) bases.set(n, b);
		}
		const above = Math.max(0, ...bases.values());
		const below = Math.max(0, ...[...bases].map(([n, b]) => height(n) - b));
		const plain = Math.max(0, ...line.filter((n) => !bases.has(n)).map(height));
		return { cross: Math.max(plain, bases.size ? above + below : 0), top: new Map([...bases].map(([n, b]) => [n, above - b])) };
	};

	/** Width from content, before any fill: unwrapped text, children side by side or stacked. */
	const hugWidth = (node: FigmaNode): number => {
		const cached = hugWidths.get(node);
		if (cached !== undefined) return cached;
		let w: number;
		if (node.width.kind === 'FIXED') w = node.width.value;
		else if (node.type === 'TEXT') w = measure(node).width;
		else {
			const kids = flow(node).map(own);
			w = (node.direction === 'HORIZONTAL' ? sum(kids) + gaps(node, kids.length) : Math.max(0, ...kids)) + node.padding[1] + node.padding[3];
		}
		w = clamp(node, 'width', w);
		hugWidths.set(node, w);
		return w;
	};
	const own = (node: FigmaNode) => (node.width.kind === 'FIXED' ? clamp(node, 'width', node.width.value) : hugWidth(node));

	/** Fill children share what fixed and hugging siblings leave. */
	const share = (kids: FigmaNode[], axis: Axis, inner: number, frame: FigmaFrame, size: (n: FigmaNode) => number) => {
		const fills = kids.filter((k) => k[axis].kind === 'FILL');
		const used = sum(kids.filter((k) => k[axis].kind !== 'FILL').map(size)) + gaps(frame, kids.length);
		const each = Math.max(0, (inner - used) / (fills.length || 1));
		return new Map(kids.map((k) => [k, k[axis].kind === 'FILL' ? clamp(k, axis, each) : size(k)]));
	};

	const resolveWidth = (node: FigmaNode, w: number) => {
		node.w = w;
		if (node.type !== 'FRAME') return;
		const inner = w - node.padding[1] - node.padding[3];
		const kids = flow(node);
		let widths: Map<FigmaNode, number>;
		if (node.direction === 'VERTICAL') widths = new Map(kids.map((k) => [k, k.width.kind === 'FILL' ? clamp(k, 'width', inner) : own(k)]));
		else if (!node.wrap) widths = share(kids, 'width', inner, node, own);
		else {
			// Break into rows at content widths, then let fills share each row.
			const lines: FigmaNode[][] = [];
			let line: FigmaNode[] = [];
			let used = 0;
			for (const k of kids) {
				const kw = own(k);
				if (line.length && used + node.gap + kw > inner + 0.01) {
					lines.push(line);
					line = [];
					used = 0;
				}
				used += (line.length ? node.gap : 0) + kw;
				line.push(k);
			}
			if (line.length) lines.push(line);
			rows.set(node, lines);
			widths = new Map();
			for (const l of lines) {
				const free = Math.max(0, inner - sum(l.map(own)) - gaps(node, l.length));
				const fills = l.filter((k) => k.width.kind === 'FILL');
				for (const k of l) widths.set(k, k.width.kind === 'FILL' ? clamp(k, 'width', own(k) + free / fills.length) : own(k));
			}
		}
		for (const k of kids) resolveWidth(k, widths.get(k)!);
		for (const k of node.children) if (k.absolute) resolveWidth(k, own(k));
	};

	const hugHeight = (node: FigmaNode): number => {
		let h: number;
		if (node.height.kind === 'FIXED') h = node.height.value;
		else if (node.type === 'TEXT') h = measure(node, wraps(node) ? node.w : undefined).height;
		else {
			const lines = node.direction === 'VERTICAL' ? null : (rows.get(node) ?? [flow(node)]);
			const kids = flow(node).map(ownHeight);
			const content = lines
				? sum(lines.map((l) => lineOf(node, l, ownHeight, known).cross)) + node.gap * Math.max(0, lines.length - 1)
				: sum(kids) + gaps(node, kids.length);
			h = content + node.padding[0] + node.padding[2];
		}
		return clamp(node, 'height', h);
	};
	const ownHeight = (node: FigmaNode) => (node.height.kind === 'FIXED' ? clamp(node, 'height', node.height.value) : hugHeight(node));

	const resolveHeight = (node: FigmaNode, h: number) => {
		node.h = h;
		if (node.type !== 'FRAME') return;
		const inner = h - node.padding[0] - node.padding[2];
		const kids = flow(node);
		let heights: Map<FigmaNode, number>;
		if (node.direction === 'VERTICAL') heights = share(kids, 'height', inner, node, ownHeight);
		else {
			heights = new Map();
			const lines = rows.get(node) ?? [kids];
			for (const l of lines) {
				const cross = lines.length > 1 ? lineOf(node, l, ownHeight, known).cross : inner;
				for (const k of l) heights.set(k, k.height.kind === 'FILL' ? clamp(k, 'height', cross) : ownHeight(k));
			}
		}
		for (const k of kids) resolveHeight(k, heights.get(k)!);
		for (const k of node.children) if (k.absolute) resolveHeight(k, ownHeight(k));
	};

	// Bottom-up, so a frame's items have their baselines when it is placed.
	const place = (frame: FigmaFrame) => {
		for (const n of frame.children) if (n.type === 'FRAME') place(n);
		const horizontal = frame.direction === 'HORIZONTAL';
		const [top, right, bottom, left] = frame.padding;
		const mainStart = horizontal ? left : top;
		const innerMain = horizontal ? frame.w - left - right : frame.h - top - bottom;
		const innerCross = horizontal ? frame.h - top - bottom : frame.w - left - right;
		const main = (n: FigmaNode) => (horizontal ? n.w : n.h);
		const cross = (n: FigmaNode) => (horizontal ? n.h : n.w);
		const set = (n: FigmaNode, m: number, c: number) => {
			n.x = horizontal ? m : c;
			n.y = horizontal ? c : m;
		};
		const crossOffset = (n: FigmaNode, line: number) => {
			const align = (horizontal ? n.height : n.width).kind === 'FILL' ? 'MIN' : (n.alignSelf ?? frame.align);
			const free = line - cross(n);
			return align === 'CENTER' ? free / 2 : align === 'MAX' ? free : 0;
		};

		const lines = rows.get(frame) ?? [flow(frame)];
		let crossStart = horizontal ? top : left;
		for (const line of lines) {
			const lined = lineOf(frame, line, cross, baselines);
			if (lined.top.size) aligned = true;
			const lineCross = lines.length > 1 ? lined.cross : innerCross;
			const free = innerMain - sum(line.map(main)) - gaps(frame, line.length);
			let spacing = frame.gap;
			let m = mainStart;
			if (frame.justify === 'CENTER') m += free / 2;
			else if (frame.justify === 'MAX') m += free;
			else if (frame.justify === 'SPACE_BETWEEN' && line.length > 1) spacing += free / (line.length - 1);
			for (const n of line) {
				set(n, m, crossStart + (lined.top.get(n) ?? crossOffset(n, lineCross)));
				m += main(n) + spacing;
			}
			crossStart += lineCross + frame.gap;
		}
		const first = lines[0] ?? [];
		const lead = (horizontal && first.find((n) => byBaseline(frame, n))) || first[0];
		baselines.set(frame, lead ? lead.y + (baselineOf(lead, baselines) ?? lead.h) : frame.h);

		// Absolute children: the given offsets, else where the browser puts an
		// out-of-flow child, as if it were the only item.
		for (const n of frame.children) {
			if (!n.absolute) continue;
			const free = innerMain - main(n);
			const m = mainStart + (frame.justify === 'CENTER' ? free / 2 : frame.justify === 'MAX' ? free : 0);
			set(n, m, (horizontal ? top : left) + crossOffset(n, innerCross));
			if (n.absolute.left !== undefined) n.x = n.absolute.left;
			if (n.absolute.top !== undefined) n.y = n.absolute.top;
		}
	};

	resolveWidth(root, own(root));
	resolveHeight(root, ownHeight(root));
	place(root);
	return { baselines, aligned };
}

/**
 * Anchored layers, in the coordinates of the root frame, which stands for the
 * browser viewport (see schema/anchor.ts):
 *
 *   1. anchor-matched sizes become fixed sizes, and layout runs again;
 *   2. each layer's placement is chosen for its own size, and an "available"
 *      maximum gets the room that placement has, and layout runs again;
 *   3. each layer is positioned, then left out when it has no anchor or its
 *      anchor is clipped completely out of view.
 *
 * Absolute layers never affect other layers' layout, so passes only change
 * the anchored layers. An anchor may sit inside another anchored layer, so
 * positioning repeats while something moves.
 */
function anchorLayers(root: FigmaFrame, relayout: () => void) {
	const parents = new Map<FigmaNode, FigmaFrame>();
	const byId = new Map<string, FigmaNode>();
	const anchored: FigmaNode[] = [];
	const walk = (frame: FigmaFrame) => {
		for (const k of frame.children) {
			parents.set(k, frame);
			if (k.id !== undefined) byId.set(k.id, k);
			if (k.anchor) anchored.push(k);
			if (k.type === 'FRAME') walk(k);
		}
	};
	walk(root);
	if (!anchored.length) return;

	/** A layer's box (or, with `parentOnly`, the origin of its parent) in root coordinates. */
	const world = (node: FigmaNode, parentOnly = false): Rect => {
		let x = parentOnly ? 0 : node.x;
		let y = parentOnly ? 0 : node.y;
		for (let p = parents.get(node); p && p !== root; p = parents.get(p)) {
			x += p.x;
			y += p.y;
		}
		return { x, y, width: parentOnly ? 0 : node.w, height: parentOnly ? 0 : node.h };
	};
	const viewport: Rect = { x: 0, y: 0, width: root.w, height: root.h };
	const anchorOf = (n: FigmaNode) => (n.anchor!.to === null ? undefined : byId.get(n.anchor!.to));
	const placed = anchored.filter((n) => anchorOf(n));
	const position = () => {
		for (let pass = 0; pass < 3; pass++) {
			let moved = false;
			for (const n of placed) {
				const { options } = n.anchor!;
				const anchor = world(anchorOf(n)!);
				const bounds = boundary(viewport, options.padding);
				const at = positionAt(anchor, { width: n.w, height: n.h }, bounds, placement.get(n)!, options);
				const origin = world(n, true);
				const [x, y] = [at.x - origin.x, at.y - origin.y];
				if (x !== n.x || y !== n.y) moved = true;
				n.x = x;
				n.y = y;
			}
			if (!moved || placed.length < 2) return;
		}
	};

	const placement = new Map<FigmaNode, string>();
	const choose = () => {
		for (const n of placed) {
			const anchor = world(anchorOf(n)!);
			placement.set(n, choosePlacement(anchor, { width: n.w, height: n.h }, boundary(viewport, n.anchor!.options.padding), n.anchor!.options));
		}
	};
	let resized = false;
	for (const n of placed) {
		const anchor = anchorOf(n)!;
		if (n.anchor!.matchWidth) n.width = { kind: 'FIXED', value: anchor.w };
		if (n.anchor!.matchHeight) n.height = { kind: 'FIXED', value: anchor.h };
		resized ||= n.anchor!.matchWidth || n.anchor!.matchHeight;
	}
	if (resized) relayout();
	// Anchors inside anchored layers need their layer placed first.
	choose();
	position();
	choose();
	let constrained = false;
	for (const n of placed) {
		const { options, availableWidth, availableHeight } = n.anchor!;
		if (!availableWidth && !availableHeight) continue;
		const room = available(world(anchorOf(n)!), boundary(viewport, options.padding), placement.get(n)!, options.offset);
		if (availableWidth) n.maxWidth = room.width;
		if (availableHeight) n.maxHeight = room.height;
		constrained = true;
	}
	if (constrained) relayout();
	position();

	// What is left out: no anchor, or an anchor clipped completely out of view.
	const inView = (anchor: FigmaNode) => {
		let visible = intersect(world(anchor), viewport);
		for (let p = parents.get(anchor); visible && p && p !== root; p = parents.get(p)) if (p.clip) visible = intersect(visible, world(p));
		return visible !== null;
	};
	for (const n of anchored) {
		const anchor = anchorOf(n);
		if (anchor && inView(anchor)) continue;
		const parent = parents.get(n)!;
		parent.children = parent.children.filter((k) => k !== n);
	}
}
