import { expect, test } from 'bun:test';
import { analyze } from '../src';

const messages = (source: string) => analyze(source).diagnostics.map((d) => `${d.line}:${d.column} ${d.message}`);
const SPAN = '"padding" is not supported on nested <span>s inside text; only typography, cursor, userSelect and pointerEvents are allowed there';

test('direct, inline and reusable styles get the same compile-time validation, once', () => {
	expect(messages(`<p>a <span style={{ padding: 4 }}>b</span></p>`)).toEqual([`1:21 ${SPAN}`]);
	expect(messages(`<p>a <span style={$style({ padding: 4 })}>b</span></p>`)).toEqual([`1:28 ${SPAN}`]);
	const reusable = `<script>const foo = $style({ padding: 4 })</script><p>a <span style={foo}>b</span> <span style={[foo]}>c</span></p>`;
	expect(messages(reusable)).toEqual([`1:30 ${SPAN}`]);
	expect(messages(`<input style={{ width: 'fill', gap: 4 }} />`)).toEqual(['1:32 "gap" is not supported on <input>']);
});

test('shared styles are checked against every element that uses them', () => {
	expect(messages(`<script>const t = $style({ color: '#111111', fontSize: 14 })</script><div style={t}><p style={t}>a <span style={t}>b</span></p></div>`)).toEqual([]);
	expect(messages(`<script>const t = $style({ padding: 4 })</script><div style={t}><p style={t}>a</p></div>`)).toEqual([
		'1:28 "padding" is not supported on text elements (<p>, <span>); wrap the text in a <div> for boxes, padding and backgrounds'
	]);
});

