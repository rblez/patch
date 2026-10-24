import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, CompileError, compile } from '../src';

const dir = mkdtempSync(join(tmpdir(), 'pat-typecheck-'));
writeFileSync(join(dir, 'models.ts'), `export interface Box<T> { value: T; label: string }\nexport const box = <T,>(value: T): Box<T> => ({ value, label: 'box' });\n`);
writeFileSync(join(dir, 'utils.ts'), `export const foo = { bar: () => 1 };\nexport async function load(): Promise<number> { return 1; }\n`);
writeFileSync(join(dir, 'thing.js'), `export default function shout(s) { return s.toUpperCase(); }\n`);
const file = join(dir, 'app.pat');

const script = (body: string, template = '<p>hi</p>') => `<script lang="ts">\n${body}\n</script>\n\n${template}\n`;
const check = (source: string) => analyze(source, { filename: file }).diagnostics;
const at = (source: string, d: { start: number; end: number }) => source.slice(d.start, d.end);

test('a plain type error is reported at its position in the .pat file', () => {
	const source = script(`\tlet x: string = 42;`);
	const [d] = check(source);
	expect(d).toMatchObject({ source: 'typescript', code: 2322, severity: 'error', line: 2, column: 6 });
	expect(d.message).toBe("Type 'number' is not assignable to type 'string'.");
	expect(at(source, d)).toBe('x');
});

test('runes are typed: $state infers, $derived keeps the expression type', () => {
	const wrong = script(`\tlet count = $state(0);\n\tcount = "wrong";`);
	const [d] = check(wrong);
	expect(d).toMatchObject({ source: 'typescript', code: 2322, line: 3, column: 2 });
	expect(at(wrong, d)).toBe('count');

	const derived = script(`\tlet count = $state(0);\n\tlet doubled = $derived(count * 2);\n\tconst n: number = doubled;\n\tconst s: string = doubled;\n\tconst later = $derived.by(() => [count]);\n\tconst m: number[] = later;\n\t$effect(() => () => {});\n\tconst card = $style({ gap: 4 });`);
	expect(check(derived).map((d) => [d.code, d.line])).toEqual([[2322, 5]]);
	expect(check(script(`\tconst s = $style(42);`)).map((d) => [d.source, d.code])).toEqual([['typescript', 2345]]);
	// PAT's own error wins over the overlapping TypeScript one.
	expect(check(script(`\tconst s = $style('gap: 4px');`)).map((d) => d.source)).toEqual(['pat']);
	expect(check(script(`\t$effect(async () => {});`)).map((d) => d.code)).toEqual([2345]);
});

test('imported modules, types and generics are understood', () => {
	const ok = script(
		[
			`\timport { box, type Box } from './models.ts';`,
			`\timport { foo, load } from './utils.ts';`,
			`\timport shout from './thing.js';`,
			`\tlet b: Box<number> = box(1);`,
			`\tconst label: string = shout(b.label) + foo.bar();`,
			`\tconst pending: Promise<number> = load();`
		].join('\n'),
		'<p>{label}</p>'
	);
	expect(check(ok)).toEqual([]);

	const bad = script(`\timport { box, type Box } from './models.ts';\n\timport { foo } from './utils.ts';\n\tlet b: Box<string> = box(1);\n\tfoo.doesNotExist();`);
	expect(check(bad).map((d) => [d.code, d.line, at(bad, d)])).toEqual([
		[2322, 4, 'b'],
		[2339, 5, 'doesNotExist']
	]);
});

test('a missing module is a TypeScript diagnostic; a missing .pat component is one PAT error', () => {
	const missing = script(`\timport { nope } from './missing.ts';`);
	expect(check(missing).map((d) => [d.source, d.code, at(missing, d)])).toEqual([['typescript', 2307, "'./missing.ts'"]]);

	const pat = check(script(`\timport Other from './Other.pat';`));
	expect(pat.map((d) => d.source)).toEqual(['pat']);
	expect(pat[0].message).toBe('cannot find component ./Other.pat');
});

test('PAT and TypeScript diagnostics appear together', () => {
	const source = script(`\tlet x: string = 42;\n\tconst s = $style({ zIndex: 1 });`, '<div class="a"></div>');
	expect(check(source).map((d) => `${d.source}:${d.line}`)).toEqual(['pat:3', 'pat:6', 'typescript:2']);
});

test('compile refuses type errors and keeps imports in the module', () => {
	expect(() => compile(script(`\tlet x: string = 42;`), file)).toThrow(CompileError);
	const compiled = compile(script(`\timport { foo } from './utils.ts';\n\timport type { Box } from './models.ts';\n\tconst n = foo.bar();`, '<p>{n}</p>'), file);
	expect(compiled.imports).toEqual(['./utils.ts']);
	expect(compiled.module).toStartWith('import { foo } from "./utils.ts";');
});

test('the LSP publishes TypeScript diagnostics and survives broken edits', async () => {
	const proc = Bun.spawn(['bun', `${import.meta.dir}/../src/cli.ts`, 'lsp'], { stdin: 'pipe', stdout: 'pipe' });
	const send = (message: object) => {
		const body = JSON.stringify({ jsonrpc: '2.0', ...message });
		proc.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
	};
	const messages: any[] = [];
	(async () => {
		let buffer = Buffer.alloc(0);
		for await (const chunk of proc.stdout) {
			buffer = Buffer.concat([buffer, chunk]);
			for (let header; (header = /^Content-Length: (\d+)\r\n\r\n/.exec(buffer.toString('latin1'))); ) {
				const end = header[0].length + Number(header[1]);
				if (buffer.length < end) break;
				messages.push(JSON.parse(buffer.subarray(header[0].length, end).toString('utf8')));
				buffer = buffer.subarray(end);
			}
		}
	})();
	const waitFor = async (match: (m: any) => boolean) => {
		for (let i = 0; i < 200; i++) {
			const found = messages.find(match);
			if (found) return found;
			await Bun.sleep(25);
		}
		throw new Error('no LSP response');
	};
	const uri = `file://${file}`;
	const diagnostics = (version: number) => waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.version === version).then((m) => m.params.diagnostics);

	send({ id: 1, method: 'initialize', params: { processId: null, rootUri: null, capabilities: {} } });
	send({ method: 'initialized', params: {} });
	const versions = [script(`\tlet x: string = 42;`), script(`\tlet x: string = `), script(`\t<<<`), script(`\tlet count = $state(0);\n\tcount = "wrong";`)];
	send({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'pat', version: 1, text: versions[0] } } });
	expect(await diagnostics(1)).toMatchObject([{ source: 'typescript', code: 2322, range: { start: { line: 1, character: 5 } } }]);
	for (let v = 2; v <= versions.length; v++)
		send({ method: 'textDocument/didChange', params: { textDocument: { uri, version: v }, contentChanges: [{ text: versions[v - 1] }] } });
	expect((await diagnostics(2))[0].source).toBe('pat');
	expect((await diagnostics(4)).map((d: any) => [d.source, d.code, d.range.start.line])).toEqual([['typescript', 2322, 2]]);

	send({ id: 2, method: 'textDocument/completion', params: { textDocument: { uri }, position: { line: 1, character: 0 } } });
	expect((await waitFor((m) => m.id === 2)).result).toEqual([]);
	proc.kill();
}, 20000);
