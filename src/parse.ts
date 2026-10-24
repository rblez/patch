// Source → svelte's AST. The only module that imports svelte; `lower.ts` is
// the only one that reads its output.

import { parse as svelteParse, type AST } from 'svelte/compiler';
import type { Reporter } from './diagnostics';

export type SvelteAst = AST.Root;

/** Parses a .pat source, or reports the syntax error and returns null. */
export function parse(source: string, reporter: Reporter): SvelteAst | null {
	try {
		return svelteParse(source, { modern: true });
	} catch (error: any) {
		const [start, end] = error.position ?? [error.start?.character ?? 0, (error.start?.character ?? 0) + 1];
		reporter.report({ start, end: Math.max(end, start + 1) }, error.message.split('\n')[0]);
		return null;
	}
}
