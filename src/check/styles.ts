// Validates every statically known style against the element kind it styles:
// property names always, values when they are literals. Then each element's
// merged style is checked against the combination rules wherever the outcome
// is certain. What is not certain is validated by the runtime with the same
// schema.

import { literal, NOT_STATIC, propertyName, unwrap, type Estree } from '../ast';
import type { Bindings } from '../bind';
import type { Reporter } from '../diagnostics';
import { checkKey, discards, normalizeStyle, rulesFor, SHORTHANDS, styleLiterals, type ElementKind, type Style, type StyleRule } from '../schema/style';
import type { StyledElement, StyleShape, Styles } from '../styles';

/**
 * Whether `expr` certainly is not an element: a name whose every value is a
 * non-null literal and that `bind:this` never sets. Literals written in place
 * are already rejected as values.
 */
function notAnElement(bindings: Bindings, expr: Estree): boolean {
	const e = unwrap(expr);
	if (e?.type !== 'Identifier') return false;
	const symbol = bindings.reference(e)?.symbol;
	if (!symbol || symbol.element || symbol.kind === 'item' || !symbol.defs.length) return false;
	return symbol.defs.every((d) => {
		const value = unwrap(d.value);
		// `let x = $state(initial)`: the initial value.
		const given = value?.type === 'CallExpression' && bindings.runeCall(value)?.name === '$state' ? value.arguments[0] : value;
		const v = d.whole && given ? literal(given) : NOT_STATIC;
		return v !== NOT_STATIC && v !== null && v !== undefined;
	});
}

/** `anchor:` values the compiler can tell are not elements from `bind:this`. */
export function checkAnchorReferences(styles: Styles, bindings: Bindings, reporter: Reporter) {
	const seen = new Set();
	for (const { object } of styles.uses)
		for (const p of object.properties) {
			if (p.type !== 'Property' || p.computed || propertyName(p) !== 'anchor' || seen.has(p)) continue;
			seen.add(p);
			if (notAnElement(bindings, p.value)) reporter.report(p.value, `anchor must be an element from bind:this; "${unwrap(p.value).name}" never holds one`);
		}
}

export function checkStyles(styles: Styles, reporter: Reporter) {
	for (const node of styles.strings) reporter.report(node, 'CSS strings are not supported; use an object or $style({...})');
	for (const { object, kind } of styles.uses) {
		for (const p of object.properties) {
			if (p.type !== 'Property' || p.computed) continue;
			const key = propertyName(p);
			try {
				checkKey(kind, key);
			} catch (error: any) {
				reporter.report(p.key, error.message);
				continue;
			}
			const value = literal(p.value);
			try {
				if (value !== NOT_STATIC) normalizeStyle({ [key]: value });
			} catch (error: any) {
				reporter.report(p.value, error.message);
			}
		}
	}
	for (const element of styles.elements) checkCombinations(element, reporter);
}

// ------------------------------------------------------------ combinations

/** More alternatives than this are left to the runtime. */
const MAX_COMBINATIONS = 256;
const UNKNOWN = Symbol('unknown');
/** An `anchor` whose value is not visible: present, whatever it holds. */
const ANCHORED = Symbol('anchored');

/** One way the style can evaluate: the entries merged (null: not visible) and the alternative taken at each choice. */
type Combination = { entries: (Estree | null)[]; picks: Map<StyleShape, number> };

function combinations(shape: StyleShape): Combination[] | null {
	switch (shape.type) {
		case 'none':
			return [{ entries: [], picks: new Map() }];
		case 'unknown':
			return [{ entries: [null], picks: new Map() }];
		case 'object':
			return [{ entries: [shape.object], picks: new Map() }];
		case 'choice': {
			const out: Combination[] = [];
			for (const [i, option] of shape.options.entries()) {
				const inner = combinations(option.shape);
				if (!inner || out.length + inner.length > MAX_COMBINATIONS) return null;
				for (const c of inner) out.push({ entries: c.entries, picks: new Map([...c.picks, [shape, i]]) });
			}
			return out;
		}
		case 'list': {
			let out: Combination[] = [{ entries: [], picks: new Map() }];
			for (const item of shape.items) {
				const inner = combinations(item);
				if (!inner || out.length * inner.length > MAX_COMBINATIONS) return null;
				out = out.flatMap((a) => inner.map((b) => ({ entries: [...a.entries, ...b.entries], picks: new Map([...a.picks, ...b.picks]) })));
			}
			return out;
		}
	}
}

/**
 * Merged longhands: a value, UNKNOWN, or undefined (known to be absent).
 * `open`: a key not in `values` may still have a value nobody can see.
 */
type Merged = { values: Map<string, unknown>; open: boolean };

/** Merges entries the way `resolveStyle` does, keeping what is not visible as UNKNOWN. */
function merge(entries: (Estree | null)[]): Merged {
	const merged: Merged = { values: new Map(), open: false };
	const unknownAll = () => {
		for (const key of merged.values.keys()) merged.values.set(key, UNKNOWN);
		merged.open = true;
	};
	for (const entry of entries) {
		if (!entry) {
			unknownAll();
			continue;
		}
		// What the entry discards from earlier ones is known absent, even when open.
		// A position that is not visible may discard what any position does.
		const position = entry.properties.find((p: Estree) => p.type === 'Property' && !p.computed && propertyName(p) === 'position');
		const mode = position ? literal(position.value) : undefined;
		const at = (position: unknown) => discards({ position } as Style);
		if (mode !== NOT_STATIC) for (const key of at(mode)) merged.values.set(key, undefined);
		else
			for (const key of new Set(styleLiterals('position').flatMap(at)))
				if (merged.values.has(key) || merged.open) merged.values.set(key, UNKNOWN);
		for (const p of entry.properties) {
			if (p.type !== 'Property' || p.computed) {
				unknownAll();
				continue;
			}
			const key = propertyName(p);
			const value = literal(p.value);
			const longhands = SHORTHANDS[key] ?? [key];
			// An anchor is kept even when nullish, so whatever it holds, the element is anchored.
			if (key === 'anchor' && value === NOT_STATIC) {
				merged.values.set(key, ANCHORED);
				continue;
			}
			try {
				if (value === NOT_STATIC) throw 0;
				for (const [k, v] of Object.entries(normalizeStyle({ [key]: value }))) merged.values.set(k, v);
			} catch {
				// A value that is not visible may also be null (absent): either way, unknown.
				for (const k of longhands) merged.values.set(k, UNKNOWN);
			}
		}
	}
	return merged;
}

/** The problem `rule` certainly reports on `merged`: it fails whatever the unknown keys hold. */
function certainFailure(rule: StyleRule, kind: ElementKind, merged: Merged): string | null {
	const known: Record<string, unknown> = {};
	const unknown: string[] = [];
	for (const key of rule.keys) {
		if (merged.values.has(key) ? merged.values.get(key) === UNKNOWN : merged.open) unknown.push(key);
		else if (merged.values.has(key)) known[key] = merged.values.get(key);
	}
	let problem: string | null = null;
	const tryAll = (i: number, st: Record<string, unknown>): boolean => {
		if (i === unknown.length) return !!(problem = rule.fails(st, kind));
		const key = unknown[i];
		return [undefined, 0, 1, ...styleLiterals(key)].every((v) => tryAll(i + 1, v === undefined ? st : { ...st, [key]: v }));
	};
	return tryAll(0, known) ? problem : null;
}

/**
 * Reports a combination rule when it certainly fails: in every way the style
 * can evaluate, or in every way that takes one particular alternative.
 */
function checkCombinations(element: StyledElement, reporter: Reporter) {
	const all = combinations(element.shape);
	if (!all) return;
	const merged = all.map((c) => merge(c.entries));
	const choices = new Set(all.flatMap((c) => [...c.picks.keys()]));
	for (const rule of rulesFor(element.kind)) {
		const problems = merged.map((m) => certainFailure(rule, element.kind, m));
		const anchor = element.style ?? element.nameSpan;
		if (problems.every(Boolean)) {
			reporter.report(anchor, problems[0]!);
			continue;
		}
		for (const choice of choices) {
			if (choice.type !== 'choice') continue;
			choice.options.forEach((option, i) => {
				const taking = all.flatMap((c, j) => (c.picks.get(choice) === i ? [problems[j]] : []));
				if (taking.length && taking.every(Boolean)) reporter.report(option.node ?? anchor, taking[0]!);
			});
		}
	}
}
