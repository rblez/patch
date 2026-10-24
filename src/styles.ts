// Static style analysis: every style object the compiler can see, paired with
// the element kind it styles, and the shape of every element's style=.
// `check/styles.ts` validates them and completion lists from them.

import { children, propertyName, unwrap, type Estree } from './ast';
import type { Bindings } from './bind';
import type { Span } from './diagnostics';
import { elements, type Component } from './ir';
import type { ElementKind, StyleKind } from './schema/style';

export type StyleUse = {
	/** An ObjectExpression. */
	object: Estree;
	/** The kind it is checked for. A `$style(...)` on its own is checked for `any` element. */
	kind: StyleKind;
};

/**
 * What a style expression evaluates to, as far as the compiler can see:
 * one object, entries merged in order, one of several alternatives (each
 * with the expression to blame, or null for the whole style), nothing
 * (a falsy value), or something it cannot see into.
 */
export type StyleShape =
	| { type: 'object'; object: Estree }
	| { type: 'list'; items: StyleShape[] }
	| { type: 'choice'; options: { shape: StyleShape; node: Estree | null }[] }
	| { type: 'none' }
	| { type: 'unknown' };

/** An element (or inline span), the kind it is styled as, and its style. */
export type StyledElement = { kind: ElementKind; style: Estree | null; nameSpan: Span; shape: StyleShape };

export type Styles = {
	uses: StyleUse[];
	/** CSS strings where a style is expected. */
	strings: Estree[];
	elements: StyledElement[];
};

const NONE: StyleShape = { type: 'none' };
const UNKNOWN: StyleShape = { type: 'unknown' };

export function collectStyles(component: Component, bindings: Bindings): Styles {
	const styles: Styles = { uses: [], strings: [], elements: [] };

	// Through arrays, `&&` / `||` / `??`, ternaries, names given one value,
	// members of object constants and calls of functions declared once:
	// object literals, `$style({...})` objects, CSS strings.
	//   held: reached through a name, so an object or array literal may have
	//         been changed since (its keys are still checked; its contents
	//         count as unknown). `$style` values are frozen.
	//   seen: names and functions on the way here, against cycles.
	type Path = { held: boolean; seen: Set<unknown> };
	const shape = (expr: Estree, kind: StyleKind, path: Path): StyleShape => {
		const e = unwrap(expr);
		const object = (object: Estree, frozen: boolean): StyleShape => {
			styles.uses.push({ object, kind });
			return frozen ? { type: 'object', object } : UNKNOWN;
		};
		const of = (node: Estree) => shape(node, kind, path);
		const through = (node: Estree, held: boolean, via: unknown) =>
			shape(node, kind, { held, seen: via ? new Set(path.seen).add(via) : path.seen });
		switch (e?.type) {
			case 'ObjectExpression':
				return object(e, !path.held);
			case 'ArrayExpression': {
				const list: StyleShape = { type: 'list', items: e.elements.map((el: Estree) => (!el ? NONE : of(el.type === 'SpreadElement' ? el.argument : el))) };
				return path.held ? UNKNOWN : list;
			}
			case 'MemberExpression': {
				// `variants.primary`, `variants[name]`: values of an object constant.
				const container = unwrap(valueOf(e.object));
				if (container?.type !== 'ObjectExpression') return UNKNOWN;
				for (const p of container.properties)
					if (p.type === 'Property' && (e.computed || (!p.computed && propertyName(p) === e.property.name))) through(p.value, true, null);
				return UNKNOWN;
			}
			case 'LogicalExpression':
				if (e.operator === '&&') return { type: 'choice', options: [{ shape: NONE, node: null }, { shape: of(e.right), node: e.right }] };
				return { type: 'choice', options: [{ shape: of(e.left), node: e.left }, { shape: of(e.right), node: e.right }] };
			case 'ConditionalExpression':
				return { type: 'choice', options: [{ shape: of(e.consequent), node: e.consequent }, { shape: of(e.alternate), node: e.alternate }] };
			case 'Literal':
				if (typeof e.value === 'string') styles.strings.push(e);
				return e.value ? UNKNOWN : NONE;
			case 'TemplateLiteral':
				styles.strings.push(e);
				return NONE;
			case 'Identifier': {
				const symbol = bindings.reference(e)?.symbol;
				if (!symbol) return e.name === 'undefined' ? NONE : UNKNOWN;
				const value = valueOf(e);
				return value && !path.seen.has(symbol) ? through(value, true, symbol) : UNKNOWN;
			}
			case 'CallExpression': {
				const arg = unwrap(e.arguments[0]);
				if (bindings.runeCall(e)?.name === '$style') return arg?.type === 'ObjectExpression' ? object(arg, true) : UNKNOWN;
				// A function's result: one of its return values. Each call makes new objects.
				const fn = unwrap(valueOf(e.callee));
				if (!/^(Arrow)?Function(Expression|Declaration)$/.test(fn?.type) || path.seen.has(fn)) return UNKNOWN;
				return { type: 'choice', options: returns(fn).map((r) => ({ shape: r ? through(r, false, fn) : NONE, node: null })) };
			}
		}
		return UNKNOWN;
	};

	/** The one value a name holds: declared or assigned once, never reassigned. Else null. */
	const valueOf = (expr: Estree): Estree | null => {
		const e = unwrap(expr);
		if (e?.type !== 'Identifier') return null;
		const symbol = bindings.reference(e)?.symbol;
		if (!symbol || symbol.kind !== 'local' || symbol.reassigned || symbol.defs.length !== 1 || !symbol.defs[0].whole) return null;
		return symbol.defs[0].value;
	};

	// A `$style({...})` anywhere: checked on its own, for any element.
	for (const call of bindings.runeCalls) if (call.name === '$style') shape(call.node.arguments[0], 'any', { held: false, seen: new Set() });
	// A style= attribute: checked for the element it styles.
	for (const element of elements(component.template)) {
		const kind = element.type === 'span' ? 'inline' : element.kind;
		styles.elements.push({ kind, style: element.style, nameSpan: element.nameSpan, shape: element.style ? shape(element.style, kind, { held: false, seen: new Set() }) : NONE });
	}
	return styles;
}

/** What a function may return: each `return` value (null for none), plus null when it can end without one. */
function returns(fn: Estree): (Estree | null)[] {
	if (fn.body.type !== 'BlockStatement') return [fn.body];
	const out: (Estree | null)[] = [];
	const walk = (node: Estree) => {
		if (!node || typeof node.type !== 'string' || /Function|Class/.test(node.type)) return;
		if (node.type === 'ReturnStatement') out.push(node.argument ?? null);
		for (const child of children(node)) walk(child);
	};
	walk(fn.body);
	if (fn.body.body.at(-1)?.type !== 'ReturnStatement') out.push(null);
	return out;
}
