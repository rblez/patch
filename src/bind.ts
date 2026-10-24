// Name resolution: the one scope-aware walk over the script and template.
//
// It records what every identifier reference resolves to (and whether it is
// read or written), what values every name is given (its definitions), every
// change through a member (`a.b = c`, `delete a.b`), and every rune call.
// Checks and code generation read these; none of them tracks scopes itself.

import { children, isTypeNode, patternIdentifiers, rootOf, unwrap, type Estree } from './ast';
import type { AttributeValue, Component, Inline, TemplateNode } from './ir';

/** `prop`: declared by `$props()`. `param`: a snippet parameter. Both are read-only. */
export type SymbolKind = 'state' | 'derived' | 'item' | 'prop' | 'param' | 'local';

/**
 * A value a name is given. `whole`: the name holds `value` itself
 * (`const b = a`, `b = a`); otherwise a part of it (`const { x } = a`,
 * `for (const x of a)`, the element parameter of `a.forEach((x) => …)`).
 */
export type Def = { value: Estree; whole: boolean };

/** A declared name. */
export type Symbol = {
	name: string;
	kind: SymbolKind;
	/** Values given to it by its declaration and assignments. */
	defs: Def[];
	/** Assigned or updated after its declaration. */
	reassigned: boolean;
	/** Its TypeScript type annotation. */
	type?: Estree;
	/** A parameter receiving a DOM event: the first one of a template `on…=` handler. */
	event?: boolean;
	/** Given an element by a template `bind:this`. */
	element?: boolean;
};

/** Reactive symbols: reads become `.v`. */
export const isSignal = (symbol: Symbol | null | undefined) => !!symbol && symbol.kind !== 'local';

export type Reference = {
	node: Estree;
	/** null: a global (or an unknown name). */
	symbol: Symbol | null;
	access: 'read' | 'write';
	/** `{ x }` in an object literal: emitted as `{ x: x.v }`. */
	shorthand: boolean;
	/** The `{ x }` property when this is a shorthand target of a destructuring assignment. */
	destructured: Estree | null;
};

/** An assignment, update or delete through a member: `a.b = c`, `a[i]++`, `delete a.b`, or `[a.b] = …` (`inPattern`). */
export type MemberWrite = { node: Estree; target: Estree; root: Reference | null; inPattern: boolean };

/**
 * Names reserved for runes: `$` followed by an identifier character (`$state`,
 * `$_x`, `$$x`). A bare `$` is an ordinary name. No declaration may take a
 * reserved name, so a call through one is a rune call wherever it appears.
 */
export const isRuneName = (name: string) => /^\$[\p{ID_Start}$_]/u.test(name);

/** A call to a rune name: `$state(…)`, `$derived.by(…)`, `$foo(…)`. */
export type RuneCall = { node: Estree; name: string };

export type Bindings = {
	references: Reference[];
	memberWrites: MemberWrite[];
	runeCalls: RuneCall[];
	/** The identifiers of declarations that take a rune name. */
	reserved: Estree[];
	/** The reference an identifier node is, if it is one. */
	reference(node: Estree): Reference | undefined;
	runeCall(node: Estree): RuneCall | undefined;
	/** The symbol a top-level name of the script declares. */
	topLevel(name: string): Symbol | null;
};

class Scope {
	vars = new Map<string, Symbol>();
	constructor(readonly parent?: Scope) {}
	get(name: string): Symbol | null {
		for (let s: Scope | undefined = this; s; s = s.parent) {
			const symbol = s.vars.get(name);
			if (symbol) return symbol;
		}
		return null;
	}
	/** Whether `name` was newly declared here. */
	declare(name: string, kind: SymbolKind): boolean {
		if (this.vars.has(name)) return false;
		this.vars.set(name, { name, kind, defs: [], reassigned: false });
		return true;
	}
}

export function bind(component: Component): Bindings {
	const binder = new Binder();
	const top = new Scope();
	const script = component.script;
	if (script) {
		for (const d of script.state) binder.declare(top, d.id, 'state');
		for (const id of script.derived) binder.declare(top, id, 'derived');
		for (const d of script.props) binder.declare(top, d.local, 'prop');
		binder.hoist(script.body, top);
		for (const statement of script.body) if (statement.type !== 'ImportDeclaration') binder.visit(statement, top);
	}
	binder.template(component.template, top);
	binder.link();

	const byNode = new Map(binder.references.map((r) => [r.node, r]));
	const calls = new Map(binder.runeCalls.map((c) => [c.node, c]));
	return {
		references: binder.references,
		memberWrites: binder.memberWrites,
		runeCalls: binder.runeCalls,
		reserved: binder.reserved,
		reference: (node) => byNode.get(node),
		runeCall: (node) => calls.get(node),
		topLevel: (name) => top.vars.get(name) ?? null
	};
}

const isFunction = (node: Estree) => node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression';

class Binder {
	references: Reference[] = [];
	memberWrites: MemberWrite[] = [];
	runeCalls: RuneCall[] = [];
	reserved: Estree[] = [];
	/** The scope holding each function's parameters. */
	private paramScopes = new Map<Estree, Scope>();
	/**
	 * Functions passed somewhere that gives their parameters values, linked
	 * once every function has been visited: a method's callback (its
	 * parameters hold parts of `receiver`) or a template event handler.
	 */
	private callbacks: { fn: Estree; receiver: Estree | null; reducer: boolean }[] = [];

	/** The function `expr` is, written in place or as the name of a function declared once. */
	private functionOf(expr: Estree, scope: Scope): Estree | null {
		const e = unwrap(expr);
		if (isFunction(e)) return e;
		const symbol = e?.type === 'Identifier' ? scope.get(e.name) : null;
		const def = symbol?.defs.length === 1 && !symbol.reassigned && symbol.defs[0].whole ? unwrap(symbol.defs[0].value) : null;
		return isFunction(def) || def?.type === 'FunctionDeclaration' ? def : null;
	}

	link() {
		for (const { fn, receiver, reducer } of this.callbacks) {
			const scope = this.paramScopes.get(fn);
			if (!scope) continue;
			fn.params.forEach((param: Estree, i: number) => {
				if (!receiver) {
					if (i === 0) for (const id of patternIdentifiers(param)) scope.get(id.name)!.event = true;
				} else if (!(reducer && i === 0)) this.define(param, scope, receiver, false);
			});
		}
	}

	private reference(node: Estree, scope: Scope, access: Reference['access'], extra: Partial<Reference> = {}) {
		this.references.push({ node, symbol: scope.get(node.name), access, shorthand: false, destructured: null, ...extra });
	}

	/** Declares `id` in `scope`, unless it already is, and records a reserved name. */
	declare(scope: Scope, id: Estree, kind: SymbolKind) {
		if (scope.declare(id.name, kind) && isRuneName(id.name)) this.reserved.push(id);
	}

	/** Declares, as locals, the names `statements` introduce in their block. */
	hoist(statements: Estree[], scope: Scope) {
		for (const s of statements) {
			const ids =
				s.type === 'VariableDeclaration'
					? s.declarations.flatMap((d: Estree) => patternIdentifiers(d.id))
					: (s.type === 'FunctionDeclaration' || s.type === 'ClassDeclaration') && s.id
						? [s.id]
						: s.type === 'ImportDeclaration'
							? s.specifiers.map((sp: Estree) => sp.local)
							: [];
			for (const id of ids) this.declare(scope, id, 'local');
			if (s.type === 'FunctionDeclaration' && s.id) scope.get(s.id.name)!.defs.push({ value: s, whole: true });
		}
	}

	private block(statements: Estree[], scope: Scope) {
		this.hoist(statements, scope);
		for (const s of statements) this.visit(s, scope);
	}

	visit(node: Estree, scope: Scope): void {
		if (!node || typeof node.type !== 'string') return;
		switch (node.type) {
			case 'Identifier':
				return this.reference(node, scope, 'read');
			case 'MemberExpression':
				this.visit(node.object, scope);
				if (node.computed) this.visit(node.property, scope);
				return;
			case 'Property':
				if (node.computed) this.visit(node.key, scope);
				if (node.shorthand && node.value.type === 'Identifier') return this.reference(node.value, scope, 'read', { shorthand: true });
				return this.visit(node.value, scope);
			case 'MethodDefinition':
			case 'PropertyDefinition':
				if (node.computed) this.visit(node.key, scope);
				return this.visit(node.value, scope);
			case 'FunctionDeclaration':
			case 'FunctionExpression':
			case 'ArrowFunctionExpression': {
				const inner = new Scope(scope);
				this.paramScopes.set(node, inner);
				if (node.type === 'FunctionExpression' && node.id) this.declare(inner, node.id, 'local');
				for (const param of node.params) {
					for (const id of patternIdentifiers(param)) this.declare(inner, id, 'local');
					this.pattern(param, inner, false);
					this.define(param, inner, null, true);
				}
				if (node.body.type === 'BlockStatement') this.block(node.body.body, inner);
				else this.visit(node.body, inner);
				return;
			}
			case 'ClassDeclaration':
			case 'ClassExpression':
				this.visit(node.superClass, scope);
				return this.visit(node.body, scope);
			case 'BlockStatement':
			case 'StaticBlock':
				return this.block(node.body, new Scope(scope));
			case 'ForStatement':
			case 'ForInStatement':
			case 'ForOfStatement': {
				const inner = new Scope(scope);
				const head = node.init ?? node.left;
				if (head?.type === 'VariableDeclaration') this.hoist([head], inner);
				else if (head && node.type !== 'ForStatement') this.pattern(head, scope, true);
				for (const key of ['init', 'test', 'update', 'right', 'body']) this.visit(node[key], inner);
				if (head?.type === 'VariableDeclaration' && node.type !== 'ForStatement') this.visit(head, inner);
				// `for (x of list)`: x holds the elements of list.
				if (node.type === 'ForOfStatement')
					if (head.type === 'VariableDeclaration') this.define(head.declarations[0].id, inner, node.right, false);
					else this.define(head, scope, node.right, false, true);
				return;
			}
			case 'CatchClause': {
				const inner = new Scope(scope);
				for (const id of patternIdentifiers(node.param)) this.declare(inner, id, 'local');
				this.pattern(node.param, inner, false);
				return this.visit(node.body, inner);
			}
			case 'VariableDeclaration':
				for (const d of node.declarations) {
					this.pattern(d.id, scope, false);
					this.visit(d.init, scope);
					this.define(d.id, scope, d.init, true);
				}
				return;
			case 'UnaryExpression': {
				const target = unwrap(node.argument);
				if (node.operator !== 'delete' || target.type !== 'MemberExpression') break;
				this.visit(target, scope);
				this.memberWrites.push({ node, target, root: this.rootReference(target), inPattern: false });
				return;
			}
			case 'LabeledStatement':
				return this.visit(node.body, scope);
			case 'BreakStatement':
			case 'ContinueStatement':
			case 'MetaProperty':
				return;
			case 'AssignmentExpression':
			case 'UpdateExpression':
				return this.assignment(node, scope);
			case 'CallExpression':
				return this.call(node, scope);
		}
		if (isTypeNode(node)) return;
		for (const child of children(node)) this.visit(child, scope);
	}

	private call(node: Estree, scope: Scope) {
		const callee = node.callee;
		const name =
			callee.type === 'Identifier' && isRuneName(callee.name)
				? callee.name
				: callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && isRuneName(callee.object.name)
					? `${callee.object.name}.${callee.property.name}`
					: null;
		if (name) this.runeCalls.push({ node, name });
		else this.visit(callee, scope);
		for (const arg of node.arguments) {
			this.visit(arg, scope);
			// `list.forEach((item, i, list) => …)`, `el.addEventListener('x', onX)`:
			// the callback's parameters hold parts of the receiver (a reducer's
			// accumulator does not).
			const fn = callee.type === 'MemberExpression' ? this.functionOf(arg, scope) : null;
			if (fn) this.callbacks.push({ fn, receiver: callee.object, reducer: !callee.computed && /^reduce(Right)?$/.test(callee.property.name) });
		}
	}

	private assignment(node: Estree, scope: Scope) {
		const target = unwrap(node.type === 'AssignmentExpression' ? node.left : node.argument);
		if (target.type === 'MemberExpression') {
			this.visit(target, scope);
			this.visit(node.right, scope);
			this.memberWrites.push({ node, target, root: this.rootReference(target), inPattern: false });
			return;
		}
		this.pattern(target, scope, true);
		this.visit(node.right, scope);
		// `=`, `||=`, `&&=`, `??=` may give the target the right side's value;
		// arithmetic operators and updates give it a new primitive.
		const gives = node.type === 'AssignmentExpression' && /^(=|\|\|=|&&=|\?\?=)$/.test(node.operator);
		this.define(target, scope, gives ? node.right : null, true, true);
	}

	/**
	 * Records that the names `pattern` binds are given `value` (whole when the
	 * pattern is a plain name; `value` null: a value that is not tracked).
	 * Defaults are values too. `assigned`: not the declaration.
	 */
	private define(pattern: Estree, scope: Scope, value: Estree | null, whole: boolean, assigned = false): void {
		const p = unwrap(pattern);
		if (!p) return;
		switch (p.type) {
			case 'Identifier': {
				const symbol = scope.get(p.name);
				if (!symbol) return;
				if (value) symbol.defs.push({ value, whole });
				if (p.typeAnnotation) symbol.type = p.typeAnnotation.typeAnnotation;
				if (assigned) symbol.reassigned = true;
				return;
			}
			case 'ObjectPattern':
				for (const q of p.properties) this.define(q.type === 'RestElement' ? q.argument : q.value, scope, value, false, assigned);
				return;
			case 'ArrayPattern':
				for (const q of p.elements) this.define(q, scope, value, false, assigned);
				return;
			case 'AssignmentPattern':
				this.define(p.left, scope, value, whole, assigned);
				return this.define(p.left, scope, p.right, true, assigned);
			case 'RestElement':
				return this.define(p.argument, scope, value, false, assigned);
		}
	}

	private rootReference(target: Estree): Reference | null {
		const root = rootOf(target);
		if (root?.type !== 'Identifier') return null;
		for (let i = this.references.length - 1; i >= 0; i--) if (this.references[i].node === root) return this.references[i];
		return null;
	}

	/**
	 * Patterns in declarations and parameters (`assign` false: names are
	 * declared, defaults and computed keys are read) and in destructuring
	 * assignments (`assign` true: names are written).
	 */
	private pattern(node: Estree, scope: Scope, assign: boolean, destructured: Estree | null = null): void {
		if (!node) return;
		switch (node.type) {
			case 'Identifier':
				if (assign) this.reference(node, scope, 'write', { destructured });
				return;
			case 'ObjectPattern':
				for (const p of node.properties) {
					if (p.type === 'RestElement') this.pattern(p.argument, scope, assign);
					else {
						if (p.computed) this.visit(p.key, scope);
						this.pattern(p.value, scope, assign, assign && p.shorthand ? p : null);
					}
				}
				return;
			case 'ArrayPattern':
				for (const element of node.elements) this.pattern(element, scope, assign);
				return;
			case 'AssignmentPattern':
				this.pattern(node.left, scope, assign, destructured);
				return this.visit(node.right, scope);
			case 'RestElement':
				return this.pattern(node.argument, scope, assign);
			case 'MemberExpression':
				this.visit(node, scope);
				this.memberWrites.push({ node, target: node, root: this.rootReference(node), inPattern: true });
				return;
			default:
				if (node.type.startsWith('TS')) return this.pattern(unwrap(node), scope, assign, destructured);
		}
	}

	/** A node list is a block: the snippets declared in it are visible throughout it, and only there. */
	template(nodes: TemplateNode[], outer: Scope) {
		const scope = new Scope(outer);
		for (const node of nodes) if (node.type === 'snippet') this.declare(scope, node.name, 'local');
		for (const node of nodes) {
			if (node.type === 'text') this.inline(node.content, scope);
			else if (node.type === 'element') {
				this.visit(node.style, scope);
				for (const a of node.attributes) {
					if (a.type === 'event') {
						this.visit(a.handler, scope);
						const fn = this.functionOf(a.handler, scope);
						if (fn) this.callbacks.push({ fn, receiver: null, reducer: false });
					}
					else if (a.type === 'bind') {
						this.visit(a.expression, scope);
						const symbol = a.name === 'this' && a.expression.type === 'Identifier' ? scope.get(a.expression.name) : null;
						if (symbol) {
							symbol.element = true;
							symbol.reassigned = true;
						}
					}
					else this.attributeValue(a.value, scope);
				}
				if (node.kind === 'frame') this.template(node.children, scope);
				if (node.kind === 'text') this.inline(node.content, scope);
			} else if (node.type === 'if') {
				for (const branch of node.branches) {
					this.visit(branch.test, scope);
					this.template(branch.body, scope);
				}
				if (node.otherwise) this.template(node.otherwise, scope);
			} else if (node.type === 'each') {
				this.visit(node.list, scope);
				const inner = new Scope(scope);
				this.declare(inner, node.item, 'item');
				if (node.index) this.declare(inner, node.index, 'item');
				this.visit(node.key, inner);
				this.template(node.body, inner);
			} else if (node.type === 'component') {
				this.reference(node.name, scope, 'read');
				for (const p of node.props) this.attributeValue(p.value, scope);
				if (node.children) this.template(node.children, scope);
			} else if (node.type === 'snippet') {
				const inner = new Scope(scope);
				for (const param of node.params) this.declare(inner, param, 'param');
				this.template(node.body, inner);
			} else if (node.type === 'render') {
				this.visit(node.callee, scope);
				for (const arg of node.args) this.visit(arg, scope);
			}
		}
	}

	private attributeValue(value: AttributeValue, scope: Scope) {
		if (value === true) return;
		if ('expression' in value) this.visit(value.expression, scope);
		else for (const part of value.parts) if (typeof part !== 'string') this.visit(part, scope);
	}

	private inline(content: Inline[], scope: Scope) {
		for (const part of content) {
			if (part.type === 'expression') this.visit(part.expression, scope);
			else if (part.type === 'span') {
				this.visit(part.style, scope);
				this.inline(part.content, scope);
			}
		}
	}
}
