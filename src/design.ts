// Design-time evaluation: a compiled app at one static state.
//
// `--state name=value` overrides replace the initial value of a `$state`. A
// value is read as JSON, falling back to the plain string. In a
// `<script lang="ts">` both readings are checked against the variable's
// declared type and the first that fits wins, so `filter=done` is the string
// "done" and `count=3` stays a number. `$effect`s never run. A module with
// imports is loaded through Bun so they resolve from the .pat file.
//
// State of the app itself is named by its variable. State of a component
// instance is named by the instance's path and the variable (see
// schema/path.ts): `Row@12:3["a"]/expanded` is `expanded` in the `<Row>`
// written at 12:3, in the item of the `{#each}` around it keyed "a". The
// declaring component is found from the last `Tag@line:column` of the path,
// so its type can be checked without running the app.

import { readFileSync } from 'node:fs';
import { compile, type Compiled } from './compile';
import * as patchModule from './runtime/context';
import { realize } from './runtime/realize';
import type { Concrete } from './schema/concrete';
import { outsideKeys, parseStateId, sitePattern, stateId } from './schema/path';
import type { Program } from './schema/program';
import { checkValues } from './typecheck';

export type StateOverrides = Record<string, unknown>;

/** The app's .pat files by path: the entry and every component it renders, directly or not. */
function appFiles(root: Compiled): Map<string, Compiled> {
	const files = new Map([[root.path, root]]);
	for (const file of files.values())
		for (const site of file.components)
			if (!files.has(site.path)) files.set(site.path, compile(readFileSync(site.path, 'utf8'), site.path));
	return files;
}

/** The file declaring the state `id` names, and its variable; null if no component in the app declares it there. */
function resolveState(files: Map<string, Compiled>, root: Compiled, id: string): { file: Compiled; name: string } | null {
	const parsed = parseStateId(id);
	if (!parsed) return null;
	const { steps, name } = parsed;
	if (!steps.length) return root.state.some((s) => s.id === name) ? { file: root, name } : null;
	const { tag, at } = steps[steps.length - 1];
	if (!tag) return null;
	for (const file of files.values())
		for (const site of file.components) {
			const target = files.get(site.path)!;
			if (site.tag === tag && site.id === at && target.state.some((s) => s.id === name)) return { file: target, name };
		}
	return null;
}

/** Every state that can be overridden: the app's names, and per component site the pattern of its instances' ids. */
function available(files: Map<string, Compiled>, root: Compiled): string[] {
	const out = root.state.map((s) => s.id);
	for (const file of files.values())
		for (const site of file.components)
			for (const s of files.get(site.path)!.state) out.push(`${file === root ? '' : '…/'}${stateId(sitePattern(site.tag, site.id, site.repeated), s.id)}`);
	return out;
}

const unknown = (id: string, files: Map<string, Compiled>, root: Compiled) =>
	new Error(`Unknown state "${id}". Available: ${available(files, root).join(', ') || '(none)'}`);

/** Parses `name=value` pairs against the app's `$state` declarations. Throws on unknown names and ill-typed values. */
export function parseStateOverrides(compiled: Compiled, pairs: string[]): StateOverrides {
	const files = appFiles(compiled);
	const parsed = pairs.map((pair) => {
		// The first `=` that is not inside an each key.
		const eq = outsideKeys(pair, '=').at[0] ?? -1;
		if (eq <= 0) throw new Error(`--state expects name=value, got "${pair}"`);
		const id = pair.slice(0, eq);
		const raw = pair.slice(eq + 1);
		const declared = resolveState(files, compiled, id);
		if (!declared) throw unknown(id, files, compiled);
		const candidates: unknown[] = [];
		try {
			candidates.push(JSON.parse(raw));
		} catch {}
		if (typeof candidates[0] !== 'string') candidates.push(raw);
		return { id, raw, candidates, ...declared };
	});

	const out: StateOverrides = {};
	for (const file of new Set(parsed.map((p) => p.file))) {
		const own = parsed.filter((p) => p.file === file);
		const script = file.script;
		if (script?.lang !== 'ts') {
			for (const p of own) out[p.id] = p.candidates[0];
			continue;
		}
		const checks = own.flatMap((p) => p.candidates.map((value) => ({ name: p.name, expression: JSON.stringify(value) })));
		const errors = checkValues(script.source, file.path, script.start, script.end, checks);
		let i = 0;
		for (const p of own) {
			const results = p.candidates.map(() => errors[i++]);
			const fits = results.findIndex((error) => error === null);
			if (fits < 0) throw new Error(`Invalid --state ${p.id}=${p.raw}: ${results[0]}`);
			out[p.id] = p.candidates[fits];
		}
	}
	// In the order given.
	return Object.fromEntries(parsed.map((p) => [p.id, out[p.id]]));
}

/** Evaluates the app once at its initial state with `overrides` applied. */
export async function evaluate(compiled: Compiled, overrides: StateOverrides = {}): Promise<Concrete[]> {
	const ids = Object.keys(overrides);
	if (ids.length) {
		const files = appFiles(compiled);
		for (const id of ids) if (!resolveState(files, compiled, id)) throw unknown(id, files, compiled);
	}
	const program: Program = compiled.imports.length
		? await importProgram(compiled)
		: new Function(`return (${compiled.module.replace(/^export default /m, '')})`)();
	return realize(program, overrides);
}

// Compiled modules served to Bun's loader by path: the entry as compiled,
// the components it imports compiled as they load.
const loaded = new Map<string, string>();
async function importProgram(compiled: Compiled): Promise<Program> {
	if (!loaded.size)
		Bun.plugin({
			name: 'pat',
			setup(build) {
				// Bun resolves bare specifiers before runtime plugins see them, so `patch` is a virtual module.
				build.module('patch', () => ({ exports: patchModule, loader: 'object' }));
				build.onLoad({ filter: /\.pat$/ }, async ({ path }) => ({
					contents: loaded.get(path) ?? compile(await Bun.file(path).text(), path).module,
					loader: 'js'
				}));
			}
		});
	loaded.set(compiled.path, compiled.module);
	return (await import(compiled.path)).default;
}
