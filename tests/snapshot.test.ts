import { expect, test } from 'bun:test';
import { diffLines, serializeTree } from '../src/test';
import type { Concrete } from '../src/schema/concrete';
import { ROOT_FONT } from '../src/schema/style';

const tree = (text: string): Concrete[] => [
	{
		type: 'frame',
		id: '1:1',
		tag: 'main',
		style: { background: '#ffffff', gap: 8 },
		font: ROOT_FONT,
		children: [{ type: 'text', id: '2:3', tag: 'p', style: {}, font: ROOT_FONT, runs: [{ text, font: ROOT_FONT }] }]
	}
];

test('serialization is stable and style keys are sorted', () => {
	const a = serializeTree(tree('hi')).join('\n');
	const b = serializeTree(tree('hi')).join('\n');
	expect(a).toBe(b);
	expect(a).toContain('style={background="#ffffff",gap=8}');
	expect(a).toContain('runs=["hi"@');
});

test('a changed run shows up as a diff, identical trees do not', () => {
	expect(diffLines(serializeTree(tree('hi')), serializeTree(tree('hi')))).toBeNull();
	const diff = diffLines(serializeTree(tree('hi')), serializeTree(tree('bye')))!;
	expect(diff.join('\n')).toContain('-  text 2:3 p');
	expect(diff.join('\n')).toContain('+  text 2:3 p');
	expect(diff.join('\n')).toContain('"bye"');
	expect(diff.join('\n').indexOf('-  text')).toBeLessThan(diff.join('\n').indexOf('+  text'));
});
