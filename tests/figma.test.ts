import { expect, test } from 'bun:test';
import { compile } from '../src';
import { evaluate } from '../src/design';
import { decodeFigmaClipboard, snapshotToFigma } from '../src/targets/figma';
import { decode, decodeSchema, encode, encodeSchema, parseSchema } from '../src/targets/figma/kiwi';
import { loadFonts } from '../src/targets/figma/fonts';
import { measureWith, type WidthOf } from '../src/targets/figma/text';

// Every character is half the font size wide, so layouts are exact.
const widthOf: WidthOf = (font, text) => text.length * font.size * 0.5;

/** Snapshot a body as the decoded NodeChange records below the viewport frame, by layer name. */
async function snapshot(body: string, script = '') {
	const c = compile(`<script lang="ts">${script}</script>${body}`, 'snap.pat');
	const { html, warnings } = await snapshotToFigma(await evaluate(c), 'snap', widthOf);
	const decoded = decodeFigmaClipboard(html);
	const nodes: any[] = decoded.message.nodeChanges;
	const key = (g: any) => `${g.sessionID}:${g.localID}`;
	const children = (n: any) => nodes.filter((c) => c.parentIndex && key(c.parentIndex.guid) === key(n.guid));
	const find = (name: string) => nodes.find((n) => n.name === name);
	return { html, decoded, nodes, children, find, warnings };
}

test('the kiwi codec round-trips schemas and messages, negative and infinite floats included', () => {
	const schema = parseSchema(`
		enum Kind { A = 0; B = 7; }
		struct V { float x; float y; }
		message M { Kind kind = 1; V v = 2; int i = 3; uint u = 4; string s = 5; bool b = 6; V[] list = 7; uint[] ids = 9; M child = 8; }
	`);
	const value = { kind: 'B', v: { x: -0.5, y: Infinity }, i: -8, u: 300, s: 'é ✓', b: true, list: [{ x: 0, y: 1 }], ids: [0, 1, 2], child: { s: '' } };
	const bytes = encode(schema, 'M', value);
	expect(decode(decodeSchema(encodeSchema(schema)), 'M', bytes)).toEqual(value);
	expect(() => encode(schema, 'M', { nope: 1 })).toThrow('M has no field "nope"');
	expect(() => encode(schema, 'M', { kind: 'C' })).toThrow('"C" is not a Kind');
});

test('the clipboard holds Figma HTML: figmeta JSON and a fig-kiwi archive carrying its schema', async () => {
	const { html, decoded, nodes } = await snapshot(`<main></main>`);
	expect(html).toStartWith(`<meta charset='utf-8'><span data-metadata="<!--(figmeta)`);
	expect(html).toContain(`(/figmeta)-->"></span><span data-buffer="<!--(figma)`);
	expect(html).toEndWith(`(/figma)-->"></span>`);
	expect(decoded.meta).toMatchObject({ fileKey: 'patch', dataType: 'scene' });
	expect(decoded.meta.pasteID).toBe(decoded.message.pasteID);
	expect(decoded.version).toBe(101);
	expect(decoded.message.type).toBe('NODE_CHANGES');
	expect(nodes.map((n) => [n.type, n.name])).toEqual([
		['DOCUMENT', 'Document'],
		['CANVAS', 'Page 1'],
		['FRAME', 'snap'],
		['FRAME', 'main']
	]);
	// The viewport frame: the browser host, white, clipped, a column.
	expect(nodes[2]).toMatchObject({ size: { x: 1280, y: 800 }, frameMaskDisabled: false, stackMode: 'VERTICAL', stackPrimarySizing: 'FIXED' });
});

test('fixed, hug and fill keep their meaning as Figma sizing', async () => {
	const { find, nodes } = await snapshot(
		`<main style={{ width: 'fill', height: 'fill' }}>
			<div style={{ flexDirection: 'row', width: 300, gap: 10 }}>
				<div style={{ width: 'fill', height: 40 }}></div>
				<div style={{ width: 50, height: 'fill' }}></div>
				<div style={{ padding: 4 }}><p style={{ lineHeight: 20 }}>hug</p></div>
			</div>
		</main>`
	);
	expect(find('main')).toMatchObject({ stackChildPrimaryGrow: 1, stackChildAlignSelf: 'STRETCH', size: { x: 1280, y: 800 } });
	const [row, fill, fixed, hug] = nodes.filter((n) => n.name === 'div');
	// The row: fixed width, hugging height, children side by side.
	expect(row).toMatchObject({ stackMode: 'HORIZONTAL', stackPrimarySizing: 'FIXED', stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE', stackSpacing: 10, size: { x: 300, y: 40 } });
	// Fill along the row grows into what is left; fill across it stretches.
	expect(fill).toMatchObject({ stackChildPrimaryGrow: 1, stackPrimarySizing: 'FIXED', size: { x: 300 - 10 - 50 - 10 - 32, y: 40 } });
	expect(fixed).toMatchObject({ stackChildAlignSelf: 'STRETCH', size: { x: 50, y: 40 } });
	expect(fixed.stackChildPrimaryGrow).toBeUndefined();
	// Hug on both axes: 3 characters of 8px and a 20px line, plus padding.
	expect(hug).toMatchObject({ stackPrimarySizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE', stackCounterSizing: 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE', size: { x: 32, y: 28 } });
	expect([fill, fixed, hug].map((d) => d.transform.m02)).toEqual([0, 208, 268]);
});

test('alignment, padding, wrap, clipping and paint map onto the frame', async () => {
	const { find, nodes } = await snapshot(
		`<div style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, width: 100, padding: [1, 2, 3, 4], justifyContent: 'center', alignItems: 'end', overflow: 'hidden', background: '#ff000080', borderWidth: 2, borderColor: '#00f', borderRadius: [1, 2, 3, 4], opacity: 0.5, boxShadow: [{ x: 0, y: 8, blur: 24, spread: -8, color: '#18181b1f' }, { y: 1, blur: 2, inset: true }], minWidth: 10, maxHeight: 500 }}>
			<button style={{ width: 40, height: 10 }}></button><button style={{ width: 40, height: 20 }}></button><button style={{ width: 40, height: 10, alignSelf: 'start' }}></button>
		</div>`
	);
	const div = find('div');
	expect(div).toMatchObject({
		stackMode: 'HORIZONTAL',
		stackWrap: 'WRAP',
		stackSpacing: 6,
		stackCounterSpacing: 6,
		stackVerticalPadding: 1,
		stackPaddingRight: 2,
		stackPaddingBottom: 3,
		stackHorizontalPadding: 4,
		stackPrimaryAlignItems: 'CENTER',
		stackCounterAlignItems: 'MAX',
		frameMaskDisabled: false,
		opacity: 0.5,
		strokeWeight: 2,
		strokeAlign: 'INSIDE',
		rectangleTopLeftCornerRadius: 1,
		rectangleTopRightCornerRadius: 2,
		rectangleBottomRightCornerRadius: 3,
		rectangleBottomLeftCornerRadius: 4,
		rectangleCornerRadiiIndependent: true,
		minSize: { value: { x: 10, y: 0 } },
		maxSize: { value: { x: Infinity, y: 500 } },
		bordersTakeSpace: false
	});
	expect(div.fillPaints).toEqual([{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 }, opacity: expect.closeTo(128 / 255, 5), visible: true, blendMode: 'NORMAL' }]);
	expect(div.strokePaints[0].color).toEqual({ r: 0, g: 0, b: 1, a: 1 });
	expect(div.effects[0]).toMatchObject({ type: 'DROP_SHADOW', offset: { x: 0, y: 8 }, radius: 24, spread: -8 });
	expect(div.effects[0].color.a).toBeCloseTo(0x1f / 255, 5);
	expect(div.effects[1]).toMatchObject({ type: 'INNER_SHADOW', offset: { x: 0, y: 1 }, radius: 2 });
	// Two rows: 40 + 6 + 40 fit in 94; the third wraps. Rows are 20 and 10 tall.
	const buttons = nodes.filter((n) => n.name === 'button');
	expect(div.size).toEqual({ x: 100, y: 1 + 20 + 6 + 10 + 3 });
	expect(buttons.map((b) => [b.transform.m02, b.transform.m12])).toEqual([
		[4 + 4, 1 + 10],
		[4 + 4 + 46, 1],
		[4 + 27, 1 + 26]
	]);
	expect(buttons[2].stackChildAlignSelf).toBe('MIN');
	expect(find('button').frameMaskDisabled).toBe(true);
});

test('text keeps its typography, sizing mode and spans', async () => {
	const { nodes } = await snapshot(
		`<main style={{ width: 60, fontFamily: 'Inter', color: '#111111' }}>
			<p style={{ fontSize: 20, fontWeight: 700, letterSpacing: -0.5, lineHeight: 30, textAlign: 'center' }}>Hi <span style={{ fontWeight: 400, color: '#ff0000', fontStyle: 'italic' }}>there</span></p>
			<p style={{ width: 'fill', fontSize: 10 }}>one two three four five</p>
			<p style={{ width: 60, height: 40, fontSize: 10 }}>fixed</p>
		</main>`
	);
	const [hug, wrapped, fixed] = nodes.filter((n) => n.type === 'TEXT');
	expect(hug).toMatchObject({
		name: 'Hi there',
		fontSize: 20,
		fontName: { family: 'Inter', style: 'Bold', postscript: '' },
		letterSpacing: { value: -0.5, units: 'PIXELS' },
		lineHeight: { value: 30, units: 'PIXELS' },
		textAlignHorizontal: 'CENTER',
		textAutoResize: 'WIDTH_AND_HEIGHT',
		textData: {
			characters: 'Hi there',
			characterStyleIDs: [0, 0, 0, 1, 1, 1, 1, 1],
			styleOverrideTable: [{ styleID: 1, fontName: { family: 'Inter', style: 'Italic', postscript: '' }, fillPaints: [expect.objectContaining({ color: { r: 1, g: 0, b: 0, a: 1 } })] }]
		},
		size: { x: 8 * 10 + 8 * -0.5, y: 30 }
	});
	// Fill width wraps at 60px: "one two" / "three four" / "five", at the default 1.2 line height.
	expect(wrapped).toMatchObject({ textAutoResize: 'HEIGHT', stackChildAlignSelf: 'STRETCH', lineHeight: { value: 12, units: 'PIXELS' }, size: { x: 60, y: 36 } });
	expect(fixed).toMatchObject({ textAutoResize: 'NONE', size: { x: 60, y: 40 } });
});

test('decoration and case are inherited typography that spans override; characters keep their case', async () => {
	const { nodes } = await snapshot(`<div style={{ textDecoration: 'underline', textTransform: 'uppercase' }}><p>ab <span style={{ textDecoration: 'none' }}>cd</span></p></div>`);
	const text = nodes.find((n) => n.type === 'TEXT');
	expect(text).toMatchObject({
		textDecoration: 'UNDERLINE',
		textCase: 'UPPER',
		textData: { characters: 'ab cd', characterStyleIDs: [0, 0, 0, 1, 1], styleOverrideTable: [{ styleID: 1, textDecoration: 'NONE' }] }
	});
});

test('truncated text wraps at its width, even one it hugs, and shows at most maxLines lines', async () => {
	const { nodes } = await snapshot(
		`<main style={{ fontSize: 10, lineHeight: 12 }}>
			<p style={{ width: 60, textOverflow: 'ellipsis', maxLines: 2 }}>one two three four five</p>
			<p style={{ maxWidth: 40, textOverflow: 'ellipsis' }}>one two three</p>
			<p style={{ width: 60, textOverflow: 'ellipsis', maxLines: 3 }}>one</p>
		</main>`
	);
	const [clamped, hugging, short] = nodes.filter((n) => n.type === 'TEXT');
	expect(clamped).toMatchObject({ textTruncation: 'ENDING', maxLines: 2, textAutoResize: 'HEIGHT', size: { x: 60, y: 24 } });
	expect(hugging).toMatchObject({ textTruncation: 'ENDING', maxLines: 1, textAutoResize: 'HEIGHT', size: { x: 40, y: 12 } });
	expect(short.size).toEqual({ x: 60, y: 12 });
});

test('inputs become frames holding their value or placeholder', async () => {
	const { find, children } = await snapshot(
		`<input style={{ width: 120, padding: [8, 12], borderWidth: 1, borderRadius: 8, fontSize: 10, lineHeight: 20 }} placeholder="Type" />
		 <textarea style={{ width: 120, height: 60 }} value="hello"></textarea>`
	);
	const input = find('input');
	expect(input).toMatchObject({ stackMode: 'HORIZONTAL', stackCounterAlignItems: 'CENTER', frameMaskDisabled: false, size: { x: 120, y: 36 }, cornerRadius: 8 });
	const [placeholder] = children(input);
	expect(placeholder).toMatchObject({ type: 'TEXT', name: 'Type', stackChildPrimaryGrow: 1, textAutoResize: 'HEIGHT', textTruncation: 'ENDING', maxLines: 1, size: { x: 96, y: 20 } });
	expect(placeholder.fillPaints[0].opacity).toBe(0.5);
	const [value] = children(find('textarea'));
	expect(value).toMatchObject({ textData: { characters: 'hello' }, stackChildAlignSelf: 'STRETCH', textAutoResize: 'HEIGHT' });
	expect(value.fillPaints[0].opacity).toBe(1);
});

test('a baseline row lines up first baselines and grows to fit them', async () => {
	const { find, children } = await snapshot(
		`<div style={{ flexDirection: 'row', alignItems: 'baseline' }}>
			<p style={{ fontSize: 20 }}>a</p>
			<p style={{ fontSize: 10 }}>b</p>
			<button style={{ width: 10, height: 30 }}></button>
		</div>`
	);
	const row = find('div');
	// Baselines (ascent 0.8, descent 0.2): 18 in a 24px line, 9 in a 12px line, the button's bottom edge at 30.
	expect(row).toMatchObject({ stackCounterAlignItems: 'BASELINE', size: { y: 30 + 6 } });
	expect(children(row).map((n: any) => n.transform.m12)).toEqual([12, 21, 0]);
});

test('absolute children leave the flow at their offsets or where the browser puts them', async () => {
	const { nodes } = await snapshot(
		`<div style={{ width: 100, height: 100, padding: 10, alignItems: 'center' }}>
			<div style={{ position: 'absolute', left: 5, top: 7, width: 10, height: 10 }}></div>
			<div style={{ position: 'absolute', width: 20, height: 20 }}></div>
		</div>`
	);
	const [, outer, placed, unplaced] = nodes.filter((n) => n.type === 'FRAME');
	expect(outer.size).toEqual({ x: 100, y: 100 });
	expect(placed).toMatchObject({ stackPositioning: 'ABSOLUTE', transform: { m02: 5, m12: 7 } });
	expect(unplaced).toMatchObject({ stackPositioning: 'ABSOLUTE', transform: { m02: 40, m12: 10 } });
});

test('margins become a wrapper frame; what Figma cannot hold is reported', async () => {
	const { find, children, warnings } = await snapshot(
		`<div style={{ flexDirection: 'row', width: 200 }}>
			<button style={{ width: 20, height: 20, margin: [1, 2, 3, 4] }}></button>
			<button style={{ width: 20, height: 20, marginLeft: 'auto' }}></button>
		</div>
		<div style={{ flexWrap: 'wrap' }}><p style={{ marginTop: -4 }}>x</p></div>`
	);
	const [numeric, auto] = children(find('div')).filter((n: any) => n.name === 'margin');
	expect(numeric).toMatchObject({ stackVerticalPadding: 1, stackPaddingRight: 2, stackPaddingBottom: 3, stackHorizontalPadding: 4, size: { x: 26, y: 24 } });
	expect(children(numeric)[0]).toMatchObject({ name: 'button', transform: { m02: 4, m12: 1 } });
	// An auto margin pushes: the wrapper takes the free space and holds the button at its end.
	expect(auto).toMatchObject({ stackChildPrimaryGrow: 1, stackCounterAlignItems: 'MAX', size: { x: 174, y: 20 }, transform: { m02: 26 } });
	expect(children(auto)[0].transform.m02).toBe(154);
	expect(warnings).toEqual([
		'Figma auto layout wraps rows only; the column is not wrapped (at 5:3)',
		'Figma cannot express a negative margin (-4); it is dropped (at 5:37)'
	]);
});

test('a warning points to where the node is written, whatever its each keys hold', async () => {
	const { warnings } = await snapshot(`{#each ['a/b'] as k (k)}<p style={{ marginTop: -1 }}>{k}</p>{/each}`, '');
	expect(warnings).toEqual(['Figma cannot express a negative margin (-1); it is dropped (at 1:52)']);
});

test('lines break at spaces, with spaces at a break hanging', () => {
	const style = { family: 'Inter', size: 10, weight: 400, italic: false, letterSpacing: 0, paint: { color: { r: 0, g: 0, b: 0, a: 1 }, opacity: 1 } };
	const node = { runs: [{ text: 'aaaa bbbb\ncc', style }], lineHeight: 12, truncate: false } as any;
	const measure = measureWith(widthOf);
	expect(measure(node)).toMatchObject({ width: 45, height: 24 });
	expect(measure(node, 44)).toMatchObject({ width: 20, height: 36 });
	expect(measure({ ...node, truncate: true }, 44).height).toBe(12);
});

test('a family that is not installed is measured with a fallback and reported', () => {
	const fonts = loadFonts();
	fonts.widthOf({ family: 'No Such Family', size: 16, weight: 400, italic: false }, 'hello');
	expect(fonts.warnings()).toEqual([expect.stringContaining('Font "No Such Family" is not installed')]);
});

const hasFont = !!loadFonts().fontFor({ family: 'Inter', size: 16, weight: 400, italic: false });

test.skipIf(!hasFont)('text layers carry the glyphs Figma draws them from', async () => {
	const c = compile(`<main><p style={{ fontSize: 20, lineHeight: 30, textAlign: 'center', width: 200 }}>Hi <span style={{ color: '#ff0000' }}>you</span></p></main>`, 'glyphs.pat');
	const { html } = await snapshotToFigma(await evaluate(c), 'glyphs');
	const { message } = decodeFigmaClipboard(html);
	const text = message.nodeChanges.find((n: any) => n.type === 'TEXT');
	const d = text.derivedTextData;
	// One glyph per visible character (the space has no outline), each on the one baseline.
	expect(d.glyphs.map((g: any) => g.firstCharacter)).toEqual([0, 1, 3, 4, 5]);
	expect(d.glyphs.map((g: any) => g.styleID)).toEqual([0, 0, 1, 1, 1]);
	expect(new Set(d.glyphs.map((g: any) => g.position.y)).size).toBe(1);
	expect(d.baselines).toHaveLength(1);
	expect(d.baselines[0]).toMatchObject({ lineY: 0, lineHeight: 30, firstCharacter: 0, endCharacter: 6 });
	// Centered: the line starts where its free space is split.
	expect(d.baselines[0].position.x).toBeCloseTo((200 - d.baselines[0].width) / 2, 3);
	expect(d.logicalIndexToCharacterOffsetMap).toHaveLength(6);
	expect(d.layoutSize).toEqual(text.size);
	expect(text.textUserLayoutVersion).toBe(4);
	// Outlines are blobs of commands: a move first, closed contours.
	const blob = new Uint8Array(message.blobs[d.glyphs[0].commandsBlob].bytes);
	expect(blob[0]).toBe(1);
	expect(blob.includes(0)).toBe(true);
});
