// `patch test`: snapshot testing for agents.
//
// A test file next to the app lists named states; each case is evaluated at
// design time (no `$effect`s, like the Figma snapshot) and its rendered tree
// is serialized to stable text. That text is compared against a baseline in
// `__snapshots__/` next to the test file. A mismatch prints a unified diff of
// the rendered tree, so an agent sees exactly which nodes moved, with no
// browser involved.
//
// Test file (`<app>.test.json` by default):
//   { "cases": [{ "name": "search", "state": { "query": "button" } }] }
// State values are JSON; they are checked against the `$state` declarations
// the same way `--state` values are, so a wrong type fails with the reason.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Compiled } from './compile';
import { evaluate, parseStateOverrides } from './design';
import type { Concrete, Run } from './schema/concrete';
import { TYPO, type Font } from './schema/style';

export type TestCase = { name: string; state: Record<string, unknown> };
export type TestFile = { cases: TestCase[] };

const NAME = /^[A-Za-z0-9._-]+$/;

/** Parses and validates a test file. Throws with the reason. */
export function parseTestFile(text: string): TestFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error('Test file is not valid JSON');
	}
	if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as TestFile).cases))
		throw new Error('Test file must be an object with a "cases" array');
	const seen = new Set<string>();
	for (const c of (parsed as TestFile).cases) {
		if (!c || typeof c.name !== 'string' || !NAME.test(c.name) || c.name === '.' || c.name === '..')
			throw new Error(`Each case needs a filename-safe "name"; got ${JSON.stringify((c as TestCase | null)?.name)}`);
		if (seen.has(c.name)) throw new Error(`Duplicate case name "${c.name}"`);
		seen.add(c.name);
		if (c.state !== undefined && (typeof c.state !== 'object' || c.state === null || Array.isArray(c.state)))
			throw new Error(`Case "${c.name}": "state" must be an object`);
	}
	return { cases: (parsed as TestFile).cases.map((c) => ({ name: c.name, state: c.state ?? {} })) };
}

/** A style or font object as `k=v,k=v`, keys in the given order. Values are JSON, so text survives exactly. */
const fields = (obj: Record<string, unknown>, keys: string[]) =>
	keys
		.filter((k) => obj[k] !== undefined)
		.map((k) => `${k}=${JSON.stringify(obj[k])}`)
		.join(',');

/** The typography of a node or run, in one fixed order. */
const fontText = (font: Font) => fields(font as unknown as Record<string, unknown>, [...TYPO]);

const runText = (run: Run) => `${JSON.stringify(run.text)}@${fontText(run.font)}`;

/** One node per line, children indented: stable across runs of the same code, so a diff means the render changed. */
export function serializeTree(nodes: Concrete[], depth = 0): string[] {
	const out: string[] = [];
	const pad = '  '.repeat(depth);
	for (const node of nodes) {
		const style = fields(node.style as Record<string, unknown>, Object.keys(node.style).sort());
		const anchor = 'anchor' in node ? ` anchor=${node.anchor === null ? 'null' : JSON.stringify(node.anchor)}` : '';
		if (node.type === 'frame')
			out.push(`${pad}frame ${node.id} ${node.tag} style={${style}} font={${fontText(node.font)}}${anchor}`),
				out.push(...serializeTree(node.children, depth + 1));
		else if (node.type === 'text')
			out.push(
				`${pad}text ${node.id} ${node.tag ?? 'null'} style={${style}} font={${fontText(node.font)}}${anchor} runs=[${node.runs.map(runText).join(' ')}]`
			);
		else
			out.push(
				`${pad}input ${node.id} ${node.tag} style={${style}} font={${fontText(node.font)}}${anchor} value=${JSON.stringify(node.value)} placeholder=${JSON.stringify(node.placeholder)} type=${JSON.stringify(node.inputType)}`
			);
	}
	return out;
}

/** A unified diff of two serialized trees, or null when they match. Lines past the cap are summarized, not dropped silently. */
export function diffLines(before: string[], after: string[], cap = 60): string[] | null {
	if (before.join('\n') === after.join('\n')) return null;
	// Longest common subsequence; falls back to a windowed view on huge trees.
	if (before.length * after.length > 10_000_000) {
		let first = 0;
		while (first < before.length && first < after.length && before[first] === after[first]) first++;
		const out = [`--- baseline`, `+++ current`, `@@ first difference at line ${first + 1}`];
		for (const line of before.slice(first, first + 20)) out.push(`-${line}`);
		for (const line of after.slice(first, first + 20)) out.push(`+${line}`);
		return out;
	}
	const m = before.length;
	const n = after.length;
	const len = new Uint32Array((m + 1) * (n + 1));
	for (let i = m - 1; i >= 0; i--)
		for (let j = n - 1; j >= 0; j--) len[i * (n + 1) + j] = before[i] === after[j] ? len[(i + 1) * (n + 1) + j + 1] + 1 : Math.max(len[(i + 1) * (n + 1) + j], len[i * (n + 1) + j + 1]);
	const out: string[] = ['--- baseline', '+++ current'];
	let i = 0;
	let j = 0;
	let shown = 0;
	while (i < m || j < n) {
		if (i < m && j < n && before[i] === after[j]) {
			i++;
			j++;
		} else if (j < n && (i === m || len[i * (n + 1) + j + 1] > len[(i + 1) * (n + 1) + j])) {
			if (shown++ < cap) out.push(`+${after[j]}`);
			j++;
		} else if (i < m) {
			if (shown++ < cap) out.push(`-${before[i]}`);
			i++;
		}
	}
	if (shown > cap) out.push(`... (${shown - cap} more changed lines)`);
	return out;
}

export type CaseResult = { name: string; status: 'pass' | 'fail' | 'new' | 'updated'; diff?: string[] };

/** Runs every case against its baseline. Missing baselines are created (status `new`); `--update` rewrites them all. */
export async function runTests(
	compiled: Compiled,
	testFile: TestFile,
	snapshotsDir: string,
	update: boolean
): Promise<CaseResult[]> {
	mkdirSync(snapshotsDir, { recursive: true });
	const results: CaseResult[] = [];
	for (const c of testFile.cases) {
		const pairs = Object.entries(c.state).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
		let overrides;
		try {
			overrides = parseStateOverrides(compiled, pairs);
		} catch (error) {
			throw new Error(`case "${c.name}": ${error instanceof Error ? error.message : String(error)}`);
		}
		const serialized = serializeTree(await evaluate(compiled, overrides)).join('\n') + '\n';
		const baselinePath = join(snapshotsDir, `${c.name}.snap`);
		let baseline: string | null = null;
		try {
			baseline = readFileSync(baselinePath, 'utf8');
		} catch {}
		if (baseline === null || update) {
			writeFileSync(baselinePath, serialized);
			results.push({ name: c.name, status: baseline === null ? 'new' : 'updated' });
			continue;
		}
		const diff = diffLines(baseline.replace(/\n$/, '').split('\n'), serialized.replace(/\n$/, '').split('\n'));
		results.push(diff ? { name: c.name, status: 'fail', diff } : { name: c.name, status: 'pass' });
	}
	return results;
}

/** The default test file for an app, and the baselines directory next to it. */
export const testPaths = (input: string, testFile?: string) => {
	const file = testFile ?? input.replace(/\.pat$/, '.test.json');
	return { file, snapshotsDir: join(dirname(file), '__snapshots__') };
};

