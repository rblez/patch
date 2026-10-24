// Figma layers → Figma's native clipboard payload.
//
// Copying layers in Figma puts HTML on the clipboard: a `figmeta` comment
// holding base64 JSON ({ fileKey, pasteID, dataType }) and a `figma` comment
// holding a base64 fig-kiwi archive. The archive is the bytes `fig-kiwi`, a
// little-endian uint32 version, then length-prefixed chunks: the deflated
// binary schema and the deflated `Message` listing every layer as a
// NodeChange (a document, a page, then the layers in tree order), with the
// glyph outlines text layers are drawn from as blobs.

import { deflateRawSync, inflateRawSync } from 'node:zlib';
import type { FigmaFrame, FigmaNode, FigmaText, Paint, Sizing, TextStyle } from './adapter';
import { decode, decodeSchema, encode, encodeSchema } from './kiwi';
import { FIGMA_SCHEMA } from './schema';

const VERSION = 101;
const FILE_KEY = 'patch';

type GUID = { sessionID: number; localID: number };
type NodeChange = Record<string, unknown>;

const WEIGHT_NAMES: Record<number, string> = {
	100: 'Thin',
	200: 'Extra Light',
	300: 'Light',
	400: 'Regular',
	500: 'Medium',
	600: 'Semi Bold',
	700: 'Bold',
	800: 'Extra Bold',
	900: 'Black'
};

/** Figma's style name for a weight and slant: "Semi Bold Italic", "Italic". */
export function fontStyleName(weight: number, italic: boolean) {
	const name = WEIGHT_NAMES[Math.min(900, Math.max(100, Math.round(weight / 100) * 100))];
	return italic ? (name === 'Regular' ? 'Italic' : `${name} Italic`) : name;
}

const IDENTITY = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

/** Sibling order keys: printable ASCII digits of one width, so they sort as strings. */
function positions(count: number): string[] {
	const digits = Math.max(1, Math.ceil(Math.log(count + 1) / Math.log(94)));
	return Array.from({ length: count }, (_, i) => {
		let key = '';
		for (let d = 0, n = i; d < digits; d++, n = Math.floor(n / 94)) key = String.fromCharCode(33 + (n % 94)) + key;
		return key;
	});
}

const solid = (p: Paint) => ({ type: 'SOLID', color: p.color, opacity: p.opacity, visible: true, blendMode: 'NORMAL' });
const hugs = (s: Sizing) => (s.kind === 'HUG' ? 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE' : 'FIXED');
const fontName = (s: TextStyle) => ({ family: s.family, style: fontStyleName(s.weight, s.italic), postscript: '' });

function sizeLimits(n: FigmaNode): NodeChange {
	const out: NodeChange = {};
	if (n.minWidth !== undefined || n.minHeight !== undefined) out.minSize = { value: { x: n.minWidth ?? 0, y: n.minHeight ?? 0 } };
	if (n.maxWidth !== undefined || n.maxHeight !== undefined) out.maxSize = { value: { x: n.maxWidth ?? Infinity, y: n.maxHeight ?? Infinity } };
	return out;
}

/** How a child sits in its auto-layout parent: grow and stretch are fill, absolute leaves the flow. */
function childLayout(n: FigmaNode, parent: FigmaFrame | null): NodeChange {
	if (!parent) return {};
	if (n.absolute) return { stackPositioning: 'ABSOLUTE', horizontalConstraint: 'MIN', verticalConstraint: 'MIN' };
	const horizontal = parent.direction === 'HORIZONTAL';
	const main = horizontal ? n.width : n.height;
	const cross = horizontal ? n.height : n.width;
	const out: NodeChange = {};
	if (main.kind === 'FILL') out.stackChildPrimaryGrow = 1;
	if (cross.kind === 'FILL') out.stackChildAlignSelf = 'STRETCH';
	else if (n.alignSelf) out.stackChildAlignSelf = n.alignSelf === 'BASELINE' && !horizontal ? 'MIN' : n.alignSelf;
	return out;
}

function frameFields(n: FigmaFrame): NodeChange {
	const horizontal = n.direction === 'HORIZONTAL';
	const [tl, tr, br, bl] = n.radius;
	const uniform = tl === tr && tr === br && br === bl;
	return {
		fillPaints: n.fills.map(solid),
		strokePaints: n.stroke ? [solid(n.stroke.paint)] : [],
		strokeWeight: n.stroke?.weight ?? 1,
		strokeAlign: 'INSIDE',
		strokeJoin: 'MITER',
		...(uniform
			? { cornerRadius: tl }
			: {
					rectangleTopLeftCornerRadius: tl,
					rectangleTopRightCornerRadius: tr,
					rectangleBottomRightCornerRadius: br,
					rectangleBottomLeftCornerRadius: bl,
					rectangleCornerRadiiIndependent: true
				}),
		effects: n.shadows.map((s) => ({
			type: s.inset ? 'INNER_SHADOW' : 'DROP_SHADOW',
			color: s.color,
			offset: { x: s.x, y: s.y },
			radius: s.blur,
			spread: s.spread,
			visible: true,
			blendMode: 'NORMAL',
			showShadowBehindNode: false
		})),
		frameMaskDisabled: !n.clip,
		stackMode: n.direction,
		stackSpacing: n.justify === 'SPACE_BETWEEN' ? 0 : n.gap,
		stackVerticalPadding: n.padding[0],
		stackPaddingRight: n.padding[1],
		stackPaddingBottom: n.padding[2],
		stackHorizontalPadding: n.padding[3],
		stackPrimarySizing: hugs(horizontal ? n.width : n.height),
		stackCounterSizing: hugs(horizontal ? n.height : n.width),
		stackPrimaryAlignItems: n.justify,
		stackCounterAlignItems: n.align,
		...(n.wrap ? { stackWrap: 'WRAP', stackCounterSpacing: n.gap } : {}),
		bordersTakeSpace: false
	};
}

function textFields(n: FigmaText): NodeChange {
	const characters = n.characters;
	const base = JSON.stringify(n.base);
	const ids = new Map<string, number>();
	const overrides: NodeChange[] = [];
	const characterStyleIDs: number[] = [];
	for (const run of n.runs) {
		const key = JSON.stringify(run.style);
		let id = 0;
		if (key !== base) {
			if (!ids.has(key)) {
				ids.set(key, ids.size + 1);
				const s = run.style;
				const override: NodeChange = { styleID: ids.size };
				if (s.family !== n.base.family || s.weight !== n.base.weight || s.italic !== n.base.italic) override.fontName = fontName(s);
				if (s.size !== n.base.size) override.fontSize = s.size;
				if (s.letterSpacing !== n.base.letterSpacing) override.letterSpacing = { value: s.letterSpacing, units: 'PIXELS' };
				if (JSON.stringify(s.paint) !== JSON.stringify(n.base.paint)) override.fillPaints = [solid(s.paint)];
				if (s.decoration !== n.base.decoration) override.textDecoration = s.decoration;
				if (s.textCase !== n.base.textCase) override.textCase = s.textCase;
				overrides.push(override);
			}
			id = ids.get(key)!;
		}
		for (let i = 0; i < run.text.length; i++) characterStyleIDs.push(id);
	}
	// Figma wraps text at a set width only, so text that may wrap keeps the width it hugs.
	const autoResize = n.width.kind === 'HUG' && n.height.kind === 'HUG' && !n.maxLines ? 'WIDTH_AND_HEIGHT' : n.height.kind === 'HUG' ? 'HEIGHT' : 'NONE';
	const styleID = (s: TextStyle) => {
		const key = JSON.stringify(s);
		return key === base ? 0 : (ids.get(key) ?? 0);
	};
	const d = n.derived;
	const decorations = new Map<number, { x: number; y: number; w: number; h: number }[]>();
	for (const { style, ...rect } of d?.decorations ?? []) {
		const id = styleID(style);
		if (!decorations.has(id)) decorations.set(id, []);
		decorations.get(id)!.push(rect);
	}
	return {
		...(d
			? {
					derivedTextData: {
						layoutSize: { x: n.w, y: n.h },
						baselines: d.baselines.map((b) => ({
							position: { x: b.x, y: b.y },
							width: b.width,
							lineY: b.lineY,
							lineHeight: b.lineHeight,
							lineAscent: b.lineAscent,
							firstCharacter: b.firstCharacter,
							endCharacter: b.endCharacter
						})),
						glyphs: d.glyphs.map((g) => ({
							commandsBlob: g.blob,
							position: { x: g.x, y: g.y },
							styleID: styleID(g.style),
							fontSize: g.size,
							firstCharacter: g.firstCharacter,
							advance: g.advance
						})),
						...(decorations.size ? { decorations: [...decorations].map(([styleID, rects]) => ({ rects, styleID })) } : {}),
						fontMetaData: d.fonts.map((f) => ({
							key: fontName(f.style),
							fontLineHeight: f.lineHeight,
							fontStyle: f.style.italic ? 'ITALIC' : 'NORMAL',
							fontWeight: f.style.weight
						})),
						truncationStartIndex: d.truncationStart,
						truncatedHeight: d.truncatedHeight,
						logicalIndexToCharacterOffsetMap: d.offsets,
						derivedLines: d.baselines.map(() => ({ directionality: 'LTR' }))
					},
					fontVersion: '',
					textUserLayoutVersion: 4,
					textExplicitLayoutVersion: 1,
					textBidiVersion: 1
				}
			: {}),
		fontSize: n.base.size,
		fontName: fontName(n.base),
		textData: overrides.length ? { characters, characterStyleIDs, styleOverrideTable: overrides } : { characters },
		lineHeight: { value: n.lineHeight, units: 'PIXELS' },
		letterSpacing: { value: n.base.letterSpacing, units: 'PIXELS' },
		textDecoration: n.base.decoration,
		textCase: n.base.textCase,
		textAlignHorizontal: n.textAlign,
		textAlignVertical: n.truncate ? 'CENTER' : 'TOP',
		textAutoResize: autoResize,
		...(n.truncate || n.maxLines ? { textTruncation: 'ENDING', maxLines: n.maxLines ?? 1 } : {}),
		fillPaints: [solid(n.base.paint)]
	};
}

/** The NodeChange records for a laid-out tree, as Figma's clipboard lists them. */
export function toNodeChanges(root: FigmaFrame): NodeChange[] {
	const document: GUID = { sessionID: 0, localID: 0 };
	const page: GUID = { sessionID: 0, localID: 1 };
	const out: NodeChange[] = [
		{ guid: document, phase: 'CREATED', type: 'DOCUMENT', name: 'Document', visible: true, opacity: 1, transform: IDENTITY, documentColorProfile: 'SRGB' },
		{
			guid: page,
			phase: 'CREATED',
			parentIndex: { guid: document, position: '!' },
			type: 'CANVAS',
			name: 'Page 1',
			visible: true,
			opacity: 1,
			transform: IDENTITY,
			pageType: 'DESIGN'
		}
	];
	let next = 1;
	const visit = (n: FigmaNode, parent: FigmaFrame | null, parentGuid: GUID, position: string) => {
		const guid = { sessionID: 1, localID: next++ };
		out.push({
			guid,
			phase: 'CREATED',
			parentIndex: { guid: parentGuid, position },
			type: n.type,
			name: n.name,
			visible: true,
			opacity: n.opacity,
			size: { x: n.w, y: n.h },
			transform: { ...IDENTITY, m02: parent ? n.x : 0, m12: parent ? n.y : 0 },
			...sizeLimits(n),
			...childLayout(n, parent),
			...(n.type === 'FRAME' ? frameFields(n) : textFields(n))
		});
		if (n.type === 'FRAME') {
			const keys = positions(n.children.length);
			n.children.forEach((child, i) => visit(child, n, guid, keys[i]));
		}
	};
	visit(root, null, page, '!');
	return out;
}

function archive(message: Uint8Array): Uint8Array {
	const chunks = [deflateRawSync(encodeSchema(FIGMA_SCHEMA)), deflateRawSync(message)];
	const out = new Uint8Array(12 + chunks.reduce((n, c) => n + 4 + c.length, 0));
	const view = new DataView(out.buffer);
	out.set(new TextEncoder().encode('fig-kiwi'));
	view.setUint32(8, VERSION, true);
	let offset = 12;
	for (const chunk of chunks) {
		view.setUint32(offset, chunk.length, true);
		out.set(chunk, offset + 4);
		offset += 4 + chunk.length;
	}
	return out;
}

/** The HTML Figma reads from the clipboard when pasting layers. `blobs` are the glyph outlines. */
export function encodeFigmaClipboard(root: FigmaFrame, blobs: Uint8Array[] = []): string {
	const pasteID = Math.floor(Math.random() * 0x7fffffff);
	const message = encode(FIGMA_SCHEMA, 'Message', {
		type: 'NODE_CHANGES',
		sessionID: 0,
		ackID: 0,
		pasteID,
		pasteFileKey: FILE_KEY,
		nodeChanges: toNodeChanges(root),
		blobs: blobs.map((bytes) => ({ bytes }))
	});
	const meta = Buffer.from(JSON.stringify({ fileKey: FILE_KEY, pasteID, dataType: 'scene' })).toString('base64');
	const buffer = Buffer.from(archive(message)).toString('base64');
	return `<meta charset='utf-8'><span data-metadata="<!--(figmeta)${meta}(/figmeta)-->"></span><span data-buffer="<!--(figma)${buffer}(/figma)-->"></span>`;
}

/** Reads a Figma clipboard payload with the schema it carries. */
export function decodeFigmaClipboard(html: string): { meta: Record<string, unknown>; version: number; message: any } {
	const meta = html.match(/\(figmeta\)(.*?)\(\/figmeta\)/)?.[1];
	const buffer = html.match(/\(figma\)(.*?)\(\/figma\)/s)?.[1];
	if (!meta || !buffer) throw new Error('Not a Figma clipboard payload');
	const bytes = new Uint8Array(Buffer.from(buffer, 'base64'));
	if (new TextDecoder().decode(bytes.subarray(0, 8)) !== 'fig-kiwi') throw new Error('Missing fig-kiwi header');
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const chunks: Uint8Array[] = [];
	for (let offset = 12; offset < bytes.length; ) {
		const length = view.getUint32(offset, true);
		chunks.push(bytes.subarray(offset + 4, offset + 4 + length));
		offset += 4 + length;
	}
	const schema = decodeSchema(new Uint8Array(inflateRawSync(chunks[0])));
	return {
		meta: JSON.parse(Buffer.from(meta, 'base64').toString()),
		version: view.getUint32(8, true),
		message: decode(schema, 'Message', new Uint8Array(inflateRawSync(chunks[1])))
	};
}
