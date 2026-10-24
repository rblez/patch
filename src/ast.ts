// Helpers for ESTree nodes (the JS/TS inside <script> and template `{...}`).
// Nodes are untyped (`any`): they come from svelte's acorn with TypeScript
// support, and only the shapes used here matter.

export type Estree = any;

/** Keys that never hold child nodes we care about, including type annotations. */
const SKIP_KEYS = new Set(['type', 'start', 'end', 'loc', 'range', 'typeAnnotation', 'returnType', 'typeParameters', 'typeArguments', 'leadingComments', 'trailingComments', 'metadata']);

/** Strips TypeScript wrappers: `x as T`, `x satisfies T`, `x!`, `<T>x`, `f<T>`. */
export const unwrap = (node: Estree): Estree =>
	node && /^TS(As|Satisfies|NonNull|TypeAssertion|Instantiation)Expression$/.test(node.type) ? unwrap(node.expression) : node;

/** The identifier (or other base) a member/call chain starts from: `a` in `a.b[0].c()`. */
export const rootOf = (node: Estree): Estree => {
	node = unwrap(node);
	while (node && (node.type === 'MemberExpression' || node.type === 'CallExpression' || node.type === 'ChainExpression'))
		node = unwrap(node.type === 'CallExpression' ? node.callee : node.type === 'ChainExpression' ? node.expression : node.object);
	return node;
};

/** The identifiers a declaration pattern binds. */
export const patternIdentifiers = (p: Estree, out: Estree[] = []): Estree[] => {
	if (!p) return out;
	if (p.type === 'Identifier') out.push(p);
	else if (p.type === 'ObjectPattern') p.properties.forEach((q: Estree) => patternIdentifiers(q.type === 'RestElement' ? q.argument : q.value, out));
	else if (p.type === 'ArrayPattern') p.elements.forEach((q: Estree) => patternIdentifiers(q, out));
	else if (p.type === 'AssignmentPattern') patternIdentifiers(p.left, out);
	else if (p.type === 'RestElement') patternIdentifiers(p.argument, out);
	return out;
};

export const NOT_STATIC = Symbol('not static');

/** The value of a literal expression (including arrays and plain objects of literals), else NOT_STATIC. */
export const literal = (node: Estree): unknown => {
	node = unwrap(node);
	if (!node) return NOT_STATIC;
	if (node.type === 'Literal' && !node.regex) return node.value;
	if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number')
		return -node.argument.value;
	if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
	if (node.type === 'ArrayExpression') {
		const values = node.elements.map(literal);
		return values.includes(NOT_STATIC) ? NOT_STATIC : values;
	}
	if (node.type === 'ObjectExpression') {
		const out: Record<string, unknown> = {};
		for (const p of node.properties) {
			if (p.type !== 'Property' || p.computed || p.kind !== 'init') return NOT_STATIC;
			const value = literal(p.value);
			if (value === NOT_STATIC) return NOT_STATIC;
			out[propertyName(p)] = value;
		}
		return out;
	}
	return NOT_STATIC;
};

/** The name of a non-computed property key. */
export const propertyName = (p: Estree): string => p.key.name ?? String(p.key.value);

/** Type-level TypeScript nodes (interfaces, type aliases, …), as opposed to TS expression wrappers. */
export const isTypeNode = (node: Estree) => node.type.startsWith('TS') && !/^TS.*Expression$/.test(node.type);

/** The child nodes of `node`, in source order. Type annotations are skipped. */
export function children(node: Estree): Estree[] {
	const out: Estree[] = [];
	for (const key of Object.keys(node)) {
		if (SKIP_KEYS.has(key)) continue;
		const value = node[key];
		if (Array.isArray(value)) for (const child of value) child && typeof child.type === 'string' && out.push(child);
		else if (value && typeof value.type === 'string') out.push(value);
	}
	return out;
}

/**
 * Calls `visit` on `root` and every node below it, parents first. Type-level
 * TypeScript nodes are visited but not entered.
 */
export function forEachNode(root: Estree, visit: (node: Estree, parent: Estree | null) => void, parent: Estree | null = null) {
	if (!root || typeof root.type !== 'string') return;
	visit(root, parent);
	if (isTypeNode(root)) return;
	for (const child of children(root)) forEachNode(child, visit, root);
}
