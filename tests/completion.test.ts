import { expect, test } from 'bun:test';
import { styleProperties, type ElementKind } from '../src/schema/style';
import { complete } from '../src';

// `|` marks the cursor.
const labels = (doc: string) => complete(doc.replace('|', ''), doc.indexOf('|')).map((c) => c.label).sort();
const legal = (kind: string) => styleProperties(kind as ElementKind).map((p) => p.name).sort();

test('inline $style in a style= attribute uses the element kind', () => {
	expect(labels(`<p>a <span style={$style({\n  |\n})}>b</span></p>`)).toEqual(legal('inline'));
	expect(labels(`<span style={$style({ | })}>b</span>`)).toEqual(legal('text'));
	expect(labels(`<input style={$style({ | })} />`)).toEqual(legal('input'));
	expect(labels(`<textarea style={$style({ | })}></textarea>`)).toEqual(legal('textarea'));
	expect(labels(`<div style={$style({ | })}></div>`)).toEqual(legal('frame'));
	expect(labels(`<div style={[{ gap: 4 }, $style({ | })]}></div>`)).toEqual(legal('frame'));
});

test('direct style objects use the element kind', () => {
	expect(labels(`<p>a <span style={{\n  |\n}}>b</span></p>`)).toEqual(legal('inline'));
	expect(labels(`<input style={{\n  |\n}} />`)).toEqual(legal('input'));
	expect(labels(`<div style={[{ gap: 4 }, { | }]}></div>`)).toEqual(legal('frame'));
});

test('a shared $style uses the kind of the element it is applied to', () => {
	expect(labels(`<script>const s = $style({ | })</script><p>a <span style={s}>b</span></p>`)).toEqual(legal('inline'));
});

test('standalone $style keeps the general vocabulary', () => {
	expect(labels(`<script>const s = $style({ | })</script>`)).toEqual(legal('any'));
});

test('inline $style values still complete', () => {
	expect(labels(`<span style={$style({ fontStyle: | })}>b</span>`)).toEqual(['italic', 'normal']);
	expect(labels(`<p>a <span style={$style({ textAlign: | })}>b</span></p>`)).toEqual([]);
});

test('the LSP serves element-aware completions for inline $style', async () => {
	const text = `<p>a <span style={$style({\n  \n})}>b</span></p>\n`;
	const proc = Bun.spawn(['bun', `${import.meta.dir}/../src/cli.ts`, 'lsp'], { stdin: 'pipe', stdout: 'pipe' });
	const send = (message: object) => {
		const body = JSON.stringify({ jsonrpc: '2.0', ...message });
		proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	};
	const uri = 'file:///test.pat';
	send({ id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } });
	send({ method: 'initialized', params: {} });
	send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'pat', version: 1, text } } });
	send({ id: 2, method: 'textDocument/completion', params: { textDocument: { uri }, position: { line: 1, character: 2 } } });

	// Read framed messages until the completion response arrives.
	let buffer = Buffer.alloc(0);
	let result: { label: string }[] | undefined;
	for await (const chunk of proc.stdout) {
		buffer = Buffer.concat([buffer, chunk]);
		for (let header; (header = /^Content-Length: (\d+)\r\n\r\n/.exec(buffer.toString('latin1'))); ) {
			const end = header[0].length + Number(header[1]);
			if (buffer.length < end) break;
			const message = JSON.parse(buffer.subarray(header[0].length, end).toString('utf8'));
			buffer = buffer.subarray(end);
			if (message.id === 2) result = message.result;
		}
		if (result) break;
	}
	proc.kill();
	expect(result!.map((i) => i.label).sort()).toEqual(legal('inline'));
});
