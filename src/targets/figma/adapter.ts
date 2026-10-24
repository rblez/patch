// Concrete tree → Figma layers.
//
// Every Patch container is a flex box, so every frame becomes an auto-layout
// frame. Sizing keeps its intent: fixed, hug and fill map onto Figma's own
// sizing (hug on the node, fill on the child as grow or stretch) instead of
// being frozen to pixels. What Figma cannot express is rewritten into
// structure that renders the same (margins become a wrapper frame) or
// degraded with a warning. Positions and resolved sizes come from layout.ts.

import type { Concrete, Font, Run } from '../../schema/concrete';
import { anchored, type Anchored } from '../../schema/anchor';
import { ownLocation } from '../../schema/path';
import { effectiveSizing, LINE_HEIGHT } from '../../schema/style';
import type { DerivedText } from './glyphs';
import { transformText } from './text';

export type Sizing = { kind: 'FIXED'; value: number } | { kind: 'HUG' } | { kind: 'FILL' };
export type Color = { r: number; g: number; b: number; a: number };
/** A solid paint: the color is opaque, its alpha is the paint's opacity, as Figma stores it. */
export type Paint = { color: Color; opacity: number };
export type Shadow = { color: Color; x: number; y: number; blur: number; spread: number; inset: boolean };
export type Align = 'MIN' | 'CENTER' | 'MAX' | 'BASELINE';

type Layer = {
	name: string;
	width: Sizing;
	height: Sizing;
	minWidth?: number;
	maxWidth?: number;
	minHeight?: number;
	maxHeight?: number;
	alignSelf?: Align;
	/** Out of the auto-layout flow; unset sides take the position the browser gives it. */
	absolute?: { left?: number; top?: number };
	/** The concrete id of the element it stands for: what anchored layers refer to. */
	id?: string;
	/** Placed and sized from the layer with id `to` by layout (see schema/anchor.ts); null: no anchor, left out. */
	anchor?: Anchored & { to: string | null };
	opacity: number;
	/** Resolved by layout: position in the parent and size. */
	x: number;
	y: number;
	w: number;
	h: number;
};

export type FigmaFrame = Layer & {
	type: 'FRAME';
	direction: 'HORIZONTAL' | 'VERTICAL';
	gap: number;
	/** [top, right, bottom, left] */
	padding: [number, number, number, number];
	justify: Align | 'SPACE_BETWEEN';
	align: Align;
	wrap: boolean;
	fills: Paint[];
	stroke: { paint: Paint; weight: number } | null;
	/** [topLeft, topRight, bottomRight, bottomLeft] */
	radius: [number, number, number, number];
	clip: boolean;
	shadows: Shadow[];
	children: FigmaNode[];
};

export type TextStyle = {
	family: string;
	size: number;
	weight: number;
	italic: boolean;
	letterSpacing: number;
	paint: Paint;
	decoration: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH';
	textCase: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE';
};

export type FigmaText = Layer & {
	type: 'TEXT';
	/** Style of the layer; runs that differ become style overrides. */
	base: TextStyle;
	/** What the layer holds. */
	characters: string;
	/** The text as shown (after `textTransform`, offsets unchanged), by style. */
	runs: { text: string; style: TextStyle }[];
	lineHeight: number;
	textAlign: 'LEFT' | 'CENTER' | 'RIGHT';
	/** One line, cut with an ellipsis (input values). */
	truncate: boolean;
	/** At most this many lines, wrapped at its width; the last one ends with an ellipsis when text is cut (`textOverflow`). */
	maxLines?: number;
	/** At least one line tall even when empty: a textarea's insertion line. */
	editable?: boolean;
	/** The laid-out glyphs Figma draws the layer from (glyphs.ts). */
	derived?: DerivedText;
};

export type FigmaNode = FigmaFrame | FigmaText;

/** The browser viewport a snapshot stands for. */
export const VIEWPORT = { width: 1280, height: 800 };

const lineHeightOf = (font: Font) => font.lineHeight ?? Math.round(font.fontSize * LINE_HEIGHT * 100) / 100;

export function parseColor(hex: string): Color {
	let h = hex.slice(1);
	if (h.length <= 4) h = [...h].map((c) => c + c).join('');
	const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
	return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

const paint = (hex: string, opacity = 1): Paint => {
	const { a, ...rgb } = parseColor(hex);
	return { color: { ...rgb, a: 1 }, opacity: a * opacity };
};

const sizing = (value: unknown): Sizing => (typeof value === 'number' ? { kind: 'FIXED', value } : { kind: value === 'fill' ? 'FILL' : 'HUG' });
const KIND = { FIXED: 'fixed', HUG: 'hug', FILL: 'fill' } as const;
const ALIGN: Record<string, Align> = { start: 'MIN', center: 'CENTER', end: 'MAX', baseline: 'BASELINE' };
const TEXT_ALIGN = { start: 'LEFT', center: 'CENTER', end: 'RIGHT' } as const;
const DECORATION = { none: 'NONE', underline: 'UNDERLINE', 'line-through': 'STRIKETHROUGH' } as const;
const TEXT_CASE = { none: 'ORIGINAL', uppercase: 'UPPER', lowercase: 'LOWER', capitalize: 'TITLE' } as const;

const textStyle = (font: Font, opacity = 1): TextStyle => ({
	family: font.fontFamily,
	size: font.fontSize,
	weight: font.fontWeight,
	italic: font.fontStyle === 'italic',
	letterSpacing: font.letterSpacing,
	paint: paint(font.color, opacity),
	decoration: DECORATION[font.textDecoration],
	textCase: TEXT_CASE[font.textTransform]
});

const layerName = (text: string) => {
	const t = text.replace(/\s+/g, ' ').trim();
	return !t ? 'Text' : t.length <= 48 ? t : `${t.slice(0, 47).trimEnd()}…`;
};

class Converter {
	warnings: string[] = [];

	private warn(id: string, message: string) {
		this.warnings.push(`${message} (at ${ownLocation(id)})`);
	}

	private layer(n: Concrete, name: string): Layer {
		const st = n.style;
		const layer: Layer = {
			name,
			width: sizing(st.width),
			height: sizing(st.height),
			opacity: st.opacity ?? 1,
			x: 0,
			y: 0,
			w: 0,
			h: 0
		};
		// Contextual values ("available") are resolved by layout.
		for (const key of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const) if (typeof st[key] === 'number') layer[key] = st[key];
		if (st.alignSelf) layer.alignSelf = ALIGN[st.alignSelf];
		if (st.position === 'absolute') layer.absolute = { left: st.left, top: st.top };
		layer.id = n.id;
		if (n.anchor !== undefined) layer.anchor = { to: n.anchor, ...anchored(st) };
		return layer;
	}

	private frame(n: Concrete, name: string, st: Concrete['style'], children: FigmaNode[]): FigmaFrame {
		const direction = st.flexDirection === 'row' ? 'HORIZONTAL' : 'VERTICAL';
		if (st.flexWrap === 'wrap' && direction === 'VERTICAL') this.warn(n.id, 'Figma auto layout wraps rows only; the column is not wrapped');
		const radius = (st.borderRadius ?? [0, 0, 0, 0]) as FigmaFrame['radius'];
		return {
			...this.layer(n, name),
			type: 'FRAME',
			direction,
			gap: st.gap ?? 0,
			padding: [st.paddingTop ?? 0, st.paddingRight ?? 0, st.paddingBottom ?? 0, st.paddingLeft ?? 0],
			justify: st.justifyContent === 'space-between' ? 'SPACE_BETWEEN' : ALIGN[st.justifyContent ?? 'start'],
			// Baselines line up along a row; in a column, "baseline" is "start", as in CSS.
			align: direction === 'VERTICAL' && st.alignItems === 'baseline' ? 'MIN' : ALIGN[st.alignItems ?? 'start'],
			wrap: st.flexWrap === 'wrap' && direction === 'HORIZONTAL',
			fills: st.background ? [paint(st.background)] : [],
			stroke: st.borderWidth ? { paint: paint(st.borderColor ?? '#000000'), weight: st.borderWidth } : null,
			radius,
			// Clipped or scrolling on either axis. A snapshot shows a scroll container at its initial scroll position.
			clip: [st.overflowX, st.overflowY].some((v) => v !== undefined && v !== 'visible'),
			shadows: (st.boxShadow ?? []).map((s: any) => ({ color: parseColor(s.color), x: s.x, y: s.y, blur: s.blur, spread: s.spread, inset: s.inset })),
			children
		};
	}

	private text(n: Concrete, name: string, runs: Run[], font: Font, opacity = 1): FigmaText {
		const characters = runs.map((r) => r.text).join('');
		let before = '';
		const styled = runs
			.filter((r) => r.text)
			.map((r) => {
				const text = transformText(r.text, r.font.textTransform, before);
				before += r.text;
				return { text, style: textStyle(r.font, opacity) };
			});
		return {
			...this.layer(n, name),
			type: 'TEXT',
			base: styled[0]?.style ?? textStyle(font, opacity),
			characters,
			runs: styled,
			lineHeight: Math.max(lineHeightOf(font), ...runs.filter((r) => r.text).map((r) => lineHeightOf(r.font))),
			textAlign: TEXT_ALIGN[font.textAlign],
			truncate: false
		};
	}

	convert(n: Concrete): FigmaNode {
		let node: FigmaNode;
		if (n.type === 'frame') {
			node = this.frame(n, n.tag, n.style, []);
			node.children = n.children.map((child) => this.convert(child));
		} else if (n.type === 'text') {
			const content = n.runs.map((r) => r.text).join('');
			node = this.text(n, layerName(content), n.runs, n.font);
			if (n.style.textOverflow === 'ellipsis') node.maxLines = n.style.maxLines ?? 1;
			if (node.width.kind === 'HUG' && node.height.kind !== 'HUG')
				this.warn(n.id, 'Figma text cannot hug its width at a set height; its width is fixed at the measured width');
		} else {
			// <input>/<textarea>: a clipped frame holding the value, or the
			// placeholder at half opacity as the browser stylesheet draws it.
			const multiline = n.tag === 'textarea';
			const shown = n.value ? (n.inputType === 'password' ? '•'.repeat(n.value.length) : n.value) : n.placeholder;
			const text = this.text(n, layerName(shown), [{ text: shown, font: n.font }], n.font, n.value ? 1 : 0.5);
			Object.assign(text, { width: { kind: 'FILL' }, height: { kind: 'HUG' }, opacity: 1, truncate: !multiline, editable: multiline });
			for (const key of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'alignSelf', 'absolute', 'anchor', 'id'] as const) delete text[key];
			node = this.frame(n, n.tag, { ...n.style, flexDirection: multiline ? 'column' : 'row', alignItems: multiline ? 'start' : 'center', overflowX: 'hidden', overflowY: 'hidden' }, [text]);
		}
		return this.margins(n, node);
	}

	/**
	 * Figma has no margins. A node with margins is wrapped in a transparent
	 * frame whose padding is the margin. An auto margin pushes the node within
	 * a wrapper that fills that axis, which is what auto margins do in flex.
	 */
	private margins(n: Concrete, node: FigmaNode): FigmaNode {
		const st = n.style;
		const sides = [st.marginTop ?? 0, st.marginRight ?? 0, st.marginBottom ?? 0, st.marginLeft ?? 0];
		if (sides.every((m) => m === 0)) return node;
		const numeric = sides.map((m) => {
			if (m === 'auto') return 0;
			if (m < 0) this.warn(n.id, `Figma cannot express a negative margin (${m}); it is dropped`);
			return Math.max(0, m);
		}) as FigmaFrame['padding'];
		const auto = sides.map((m) => m === 'auto');
		const push = (start: boolean, end: boolean): Align => (start && end ? 'CENTER' : start ? 'MAX' : 'MIN');
		const axis = (inner: Sizing, autoMargin: boolean): Sizing => (inner.kind === 'FILL' || autoMargin ? { kind: 'FILL' } : { kind: 'HUG' });
		const wrapper: FigmaFrame = {
			name: 'margin',
			type: 'FRAME',
			width: axis(node.width, auto[1] || auto[3]),
			height: axis(node.height, auto[0] || auto[2]),
			opacity: 1,
			alignSelf: node.alignSelf,
			absolute: node.absolute,
			direction: 'VERTICAL',
			gap: 0,
			padding: numeric,
			justify: push(auto[0], auto[2]),
			align: push(auto[3], auto[1]),
			wrap: false,
			fills: [],
			stroke: null,
			radius: [0, 0, 0, 0],
			clip: false,
			shadows: [],
			children: [node],
			x: 0,
			y: 0,
			w: 0,
			h: 0
		};
		if (wrapper.absolute && (wrapper.width.kind === 'FILL' || wrapper.height.kind === 'FILL')) {
			this.warn(n.id, 'auto margins on an absolute element are dropped');
			wrapper.width = { kind: 'HUG' };
			wrapper.height = { kind: 'HUG' };
		}
		delete node.absolute;
		delete node.alignSelf;
		return wrapper;
	}

	/**
	 * Writes each flow child's effective sizing (see `effectiveSizing`): a
	 * fill that resolves to its content size is written as hug, which is also
	 * the only form Figma can hold for it. Runs top-down, so a rewritten child
	 * is a hugging parent to its own children.
	 */
	normalize(frame: FigmaFrame) {
		const flow = frame.children.filter((c) => !c.absolute);
		for (const child of flow)
			for (const axis of ['width', 'height'] as const) {
				const main = (axis === 'width') === (frame.direction === 'HORIZONTAL');
				if (effectiveSizing(KIND[child[axis].kind], KIND[frame[axis].kind], main, flow.length === 1) === 'hug') child[axis] = { kind: 'HUG' };
			}
		for (const child of frame.children) if (child.type === 'FRAME') this.normalize(child);
	}
}

/** A concrete tree as Figma layers inside a frame standing in for the browser viewport. */
export function toFigma(tree: Concrete[], name: string): { root: FigmaFrame; warnings: string[] } {
	const converter = new Converter();
	// The browser host: a white, clipped column the size of the viewport.
	const root: FigmaFrame = {
		name,
		type: 'FRAME',
		width: { kind: 'FIXED', value: VIEWPORT.width },
		height: { kind: 'FIXED', value: VIEWPORT.height },
		opacity: 1,
		direction: 'VERTICAL',
		gap: 0,
		padding: [0, 0, 0, 0],
		justify: 'MIN',
		align: 'MIN',
		wrap: false,
		fills: [paint('#ffffff')],
		stroke: null,
		radius: [0, 0, 0, 0],
		clip: true,
		shadows: [],
		children: tree.map((n) => converter.convert(n)),
		x: 0,
		y: 0,
		w: 0,
		h: 0
	};
	converter.normalize(root);
	return { root, warnings: converter.warnings };
}
