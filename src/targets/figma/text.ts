// Text layout: words and spaces are measured, then lines are broken greedily
// the way `white-space: pre-wrap` breaks them, at spaces, with spaces at a
// break hanging past the edge. Unwrapped text breaks only at newlines.

import type { Font } from '../../schema/concrete';
import type { FigmaText, TextStyle } from './adapter';

const IN_WORD = /[\p{L}\p{N}\p{M}'’]/u;

/**
 * Text as `text-transform` shows it; `before` is the text preceding it, for
 * where words start. A character whose case mapping changes its length (ß →
 * SS) is kept, so every character keeps its offset.
 */
export function transformText(text: string, transform: Font['textTransform'], before = ''): string {
	if (transform === 'none') return text;
	let previous = [...before].pop() ?? '';
	let out = '';
	for (const ch of text) {
		const upper = transform === 'uppercase' || (transform === 'capitalize' && !IN_WORD.test(previous));
		const next = upper ? ch.toUpperCase() : transform === 'lowercase' ? ch.toLowerCase() : ch;
		out += next.length === ch.length ? next : ch;
		previous = ch;
	}
	return out;
}

export type FontKey = Pick<TextStyle, 'family' | 'size' | 'weight' | 'italic'>;
/** Advance width of `text` on one line, without letter spacing. */
export type WidthOf = (font: FontKey, text: string) => number;
/** A font's ascent and descent at its size, in pixels, both positive. */
export type MetricsOf = (font: FontKey) => { ascent: number; descent: number };
/** Size, and where the first line's baseline sits below the top. */
export type TextMeasure = (node: FigmaText, maxWidth?: number) => { width: number; height: number; baseline: number };

/** Typical proportions, for when no font file is read. */
export const approximateMetrics: MetricsOf = (font) => ({ ascent: font.size * 0.8, descent: font.size * 0.2 });

/** Where the baseline of a line set in `styles` sits below its top: the content area is centered in the line height. */
export function baselineIn(lineHeight: number, styles: TextStyle[], metricsOf: MetricsOf): number {
	const metrics = styles.map(metricsOf);
	const ascent = Math.max(...metrics.map((m) => m.ascent));
	const descent = Math.max(...metrics.map((m) => m.descent));
	return (lineHeight - ascent - descent) / 2 + ascent;
}

/** A single-style piece of a word or of the spaces between words, placed on its line. */
export type Placed = { text: string; style: TextStyle; start: number; x: number; width: number };
/** One line: its pieces, its width without hanging spaces, and its characters [start, end). */
export type Line = { pieces: Placed[]; width: number; start: number; end: number };

type Token = { space: boolean; pieces: { text: string; style: TextStyle; start: number }[] };

/** The text split into hard lines of word and space tokens, with each piece's UTF-16 offset. */
function tokenize(node: FigmaText): { start: number; tokens: Token[] }[] {
	const lines: { start: number; tokens: Token[] }[] = [{ start: 0, tokens: [] }];
	let offset = 0;
	for (const run of node.runs)
		for (const part of run.text.split(/(\n| +)/)) {
			if (!part) continue;
			const start = offset;
			offset += part.length;
			if (part === '\n') {
				lines.push({ start: offset, tokens: [] });
				continue;
			}
			const tokens = lines[lines.length - 1].tokens;
			const space = part[0] === ' ';
			const last = tokens[tokens.length - 1];
			// A word continuing across a style change is still one word.
			if (last && !last.space && !space) last.pieces.push({ text: part, style: run.style, start });
			else tokens.push({ space, pieces: [{ text: part, style: run.style, start }] });
		}
	return lines;
}

export function breakLines(node: FigmaText, widthOf: WidthOf, maxWidth?: number): Line[] {
	const pieceWidth = (p: { text: string; style: TextStyle }) => widthOf(p.style, p.text) + p.style.letterSpacing * [...p.text].length;
	const wraps = maxWidth !== undefined && !node.truncate;
	const out: Line[] = [];
	const hard = tokenize(node);
	hard.forEach(({ start, tokens }, i) => {
		const end = i + 1 < hard.length ? hard[i + 1].start : node.runs.reduce((n, r) => n + r.text.length, 0);
		let line: Line = { pieces: [], width: 0, start, end };
		let cursor = 0;
		for (const token of tokens) {
			const widths = token.pieces.map(pieceWidth);
			const w = widths.reduce((a, b) => a + b, 0);
			if (!token.space && wraps && line.width > 0 && cursor + w > maxWidth! + 0.01) {
				line.end = token.pieces[0].start;
				out.push(line);
				line = { pieces: [], width: 0, start: token.pieces[0].start, end };
				cursor = 0;
			}
			token.pieces.forEach((p, j) => {
				line.pieces.push({ ...p, x: cursor, width: widths[j] });
				cursor += widths[j];
			});
			// Unwrapped text keeps its trailing spaces (`white-space: pre`).
			if (!token.space || !wraps) line.width = cursor;
		}
		out.push(line);
	});
	return out;
}

export function measureWith(widthOf: WidthOf, metricsOf: MetricsOf = approximateMetrics): TextMeasure {
	return (node, maxWidth) => {
		const lines = breakLines(node, widthOf, maxWidth);
		const width = Math.max(0, ...lines.map((l) => l.width));
		const empty = node.runs.every((r) => !r.text);
		const count = node.truncate ? 1 : empty ? (node.editable ? 1 : 0) : Math.min(lines.length, node.maxLines ?? Infinity);
		const first = lines[0]?.pieces.length ? lines[0].pieces.map((p) => p.style) : [node.base];
		return { width: Math.ceil(width * 100) / 100, height: count * node.lineHeight, baseline: baselineIn(node.lineHeight, first, metricsOf) };
	};
}
