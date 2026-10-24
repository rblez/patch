// Value flow over the binder's definitions: what an expression's value may
// be, as far as names, members and a few well-known calls show it. Answers
// are conservative in the direction each caller states; anything not
// understood is treated as unrelated.

import { unwrap, type Estree } from './ast';
import { isSignal, type Bindings, type Symbol } from './bind';

/**
 * A reactive variable a value may share objects with. `fresh`: the value
 * is a new container whose contents are the variable's (`list.slice()`,
 * `[...list]`, `{ ...obj }`), so changing the container itself is safe.
 */
export type Alias = { symbol: Symbol; fresh: boolean };

/** Calls returning an element of the receiver. */
const ELEMENT = new Set(['find', 'findLast', 'at', 'get']);
/** Calls returning a new container holding the receiver's elements. */
const COPY = new Set(['filter', 'slice', 'concat', 'toSorted', 'toReversed', 'toSpliced', 'with', 'flat', 'values']);

/** The reactive variables (state, derived, each items) `expr`'s value may be, or be part of. */
export function aliases(bindings: Bindings, expr: Estree, seen = new Set<Symbol>()): Alias[] {
	const e = unwrap(expr);
	const within = (node: Estree) => aliases(bindings, node, seen).map((a) => ({ ...a, fresh: false }));
	const copied = (node: Estree) => aliases(bindings, node, seen).map((a) => ({ ...a, fresh: true }));
	switch (e?.type) {
		case 'Identifier': {
			const symbol = bindings.reference(e)?.symbol;
			if (!symbol || seen.has(symbol)) return [];
			if (isSignal(symbol)) return [{ symbol, fresh: false }];
			seen.add(symbol);
			return symbol.defs.flatMap((d) => (d.whole ? aliases(bindings, d.value, seen) : within(d.value)));
		}
		case 'MemberExpression':
			return within(e.object);
		case 'ChainExpression':
			return aliases(bindings, e.expression, seen);
		case 'ConditionalExpression':
			return [...aliases(bindings, e.consequent, seen), ...aliases(bindings, e.alternate, seen)];
		case 'LogicalExpression':
			return [...aliases(bindings, e.left, seen), ...aliases(bindings, e.right, seen)];
		case 'SequenceExpression':
			return aliases(bindings, e.expressions[e.expressions.length - 1], seen);
		case 'AssignmentExpression':
			return e.operator === '=' ? aliases(bindings, e.right, seen) : [];
		// A new container: changing it is safe, its contents are what went in.
		case 'ArrayExpression':
			return e.elements.flatMap((el: Estree) => (el ? copied(el.type === 'SpreadElement' ? el.argument : el) : []));
		case 'ObjectExpression':
			return e.properties.flatMap((p: Estree) => copied(p.type === 'SpreadElement' ? p.argument : p.value));
		case 'CallExpression': {
			const callee = unwrap(e.callee);
			if (callee.type !== 'MemberExpression' || callee.computed) return [];
			if (ELEMENT.has(callee.property.name)) return within(callee.object);
			if (COPY.has(callee.property.name)) return copied(callee.object);
			return [];
		}
	}
	return [];
}

/** Globals that are, or hand out, DOM objects. */
const DOM_GLOBALS = new Set(['document', 'window', 'self', 'globalThis', 'frames', 'parent', 'top', 'opener']);
/** TypeScript names of DOM types. */
const DOM_TYPE =
	/^(Window|Document|DocumentFragment|ShadowRoot|Node|ChildNode|ParentNode|Element|Text|Comment|EventTarget|NodeList|HTMLCollection|CSSStyleDeclaration|CSSStyleSheet|StyleSheet|Range|Selection|DOMParser|Image|Audio|Option|(UI|Mouse|Keyboard|Pointer|Focus|Input|Wheel|Touch|Drag|Composition|Clipboard|Submit|Animation|Transition)?Event|(HTML|SVG|MathML)\w*Element)$/;

const isDomType = (t: Estree): boolean => {
	if (!t) return false;
	if (t.type === 'TSTypeReference') return t.typeName.type === 'Identifier' && DOM_TYPE.test(t.typeName.name);
	if (t.type === 'TSUnionType' || t.type === 'TSIntersectionType') return t.types.some(isDomType);
	if (t.type === 'TSParenthesizedType') return isDomType(t.typeAnnotation);
	return false;
};

/**
 * Whether `expr`'s value may come from the DOM: a DOM global, an event
 * handler's event, a `bind:this` variable, a value typed or cast as a DOM
 * type, or anything read or called from one of those.
 */
export function fromDom(bindings: Bindings, expr: Estree, seen = new Set<Symbol>()): boolean {
	if (!expr) return false;
	if (/^TS(As|Satisfies|TypeAssertion)Expression$/.test(expr.type)) return isDomType(expr.typeAnnotation) || fromDom(bindings, expr.expression, seen);
	const e = unwrap(expr);
	const from = (node: Estree) => fromDom(bindings, node, seen);
	switch (e?.type) {
		case 'Identifier': {
			const symbol = bindings.reference(e)?.symbol;
			if (!symbol) return DOM_GLOBALS.has(e.name);
			if (seen.has(symbol)) return false;
			if (symbol.element) return true;
			if (isSignal(symbol)) return false;
			seen.add(symbol);
			return !!symbol.event || isDomType(symbol.type) || symbol.defs.some((d) => from(d.value));
		}
		case 'MemberExpression':
			return from(e.object);
		case 'ChainExpression':
			return from(e.expression);
		case 'CallExpression':
			return unwrap(e.callee).type === 'MemberExpression' && from(unwrap(e.callee).object);
		case 'NewExpression':
			return e.callee.type === 'Identifier' && !bindings.reference(e.callee)?.symbol && DOM_TYPE.test(e.callee.name);
		case 'ConditionalExpression':
			return from(e.consequent) || from(e.alternate);
		case 'LogicalExpression':
			return from(e.left) || from(e.right);
		case 'SequenceExpression':
			return from(e.expressions[e.expressions.length - 1]);
		case 'AssignmentExpression':
			return e.operator === '=' && from(e.right);
	}
	return false;
}

/** A reactive variable whose objects `expr` is (not a fresh copy of), so changing `expr` in place changes it. */
export const sharedWith = (bindings: Bindings, expr: Estree): Symbol | null => aliases(bindings, expr).find((a) => !a.fresh)?.symbol ?? null;
