// Rules for the JS/TS in a .pat file (the script and template expressions):
// reactivity (what may be written, mutated, or called as a rune) and escape
// hatches around the visual model.

import { children, forEachNode, isTypeNode, rootOf, unwrap, type Estree } from '../ast';
import { isSignal, type Bindings } from '../bind';
import type { Reporter } from '../diagnostics';
import { fromDom, sharedWith } from '../flow';
import { expressions, type Component } from '../ir';
import { RUNES } from '../schema/program';

// Built-in methods that change their receiver, and functions that change their first argument.
const ARRAY_MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);
const MUTATORS = new Set([...ARRAY_MUTATORS, 'set', 'add', 'delete', 'clear']);
const STATIC_MUTATORS: Record<string, string[]> = {
	Object: ['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf'],
	Reflect: ['set', 'deleteProperty', 'defineProperty', 'setPrototypeOf']
};

// Straightforward attempts to bypass the template/style model.
const VISUAL_ESCAPES = new Set([
	'querySelector', 'querySelectorAll', 'getElementById', 'getElementsByClassName', 'getElementsByTagName',
	'getElementsByName', 'createElement', 'createElementNS', 'createTextNode', 'createDocumentFragment',
	'appendChild', 'insertBefore', 'removeChild', 'replaceChild', 'replaceChildren', 'replaceWith',
	'insertAdjacentHTML', 'insertAdjacentElement', 'insertAdjacentText', 'innerHTML', 'outerHTML', 'innerText',
	'textContent', 'setProperty', 'cssText', 'classList', 'className', 'attachShadow', 'getComputedStyle',
	'getBoundingClientRect', 'adoptedStyleSheets', 'styleSheets'
]);
const DOCUMENT_ESCAPES = new Set(['body', 'documentElement', 'head', 'write', 'writeln']);

/** Why a reactive variable that is not `$state` cannot be changed. */
const READ_ONLY: Record<string, (name: string) => string> = {
	derived: (name) => `"${name}" is $derived and read-only`,
	item: (name) => `"${name}" is an {#each} binding and read-only; reassign the source array instead`,
	prop: (name) => `"${name}" is a prop and read-only; the parent owns it (pass a callback prop to ask it for a change)`,
	param: (name) => `"${name}" is a snippet parameter and read-only`
};

export function checkScript(component: Component, bindings: Bindings, reporter: Reporter) {
	for (const id of bindings.reserved) reporter.report(id, `"${id.name}": names beginning with "$" are reserved for Patch runes`);
	references(bindings, reporter);
	memberWrites(bindings, reporter);
	runeCalls(component, bindings, reporter);
	contextCalls(component, bindings, reporter);
	const script = component.script?.body ?? [];
	const template = [...expressions(component.template)];
	for (const root of [...script, ...template]) forEachNode(root, (node) => syntax(node, bindings, reporter));
	for (const root of script) topLevelAwait(root, 'the script runs before the first render; use an async function or $effect', reporter);
	for (const root of template) topLevelAwait(root, 'template expressions are synchronous; keep the result in $state', reporter);
}

/** `await` outside any function: the script and template expressions run synchronously. */
function topLevelAwait(node: Estree, hint: string, reporter: Reporter) {
	if (!node || typeof node.type !== 'string' || isTypeNode(node) || /Function/.test(node.type)) return;
	if (node.type === 'AwaitExpression' || (node.type === 'ForOfStatement' && node.await))
		reporter.report(node, `await is only allowed inside an async function: ${hint}`);
	for (const child of children(node)) topLevelAwait(child, hint, reporter);
}

function references(bindings: Bindings, reporter: Reporter) {
	for (const ref of bindings.references) {
		const { node, symbol } = ref;
		const name: string = node.name;
		if (name.startsWith('$$')) reporter.report(node, 'identifiers starting with $$ are reserved');
		else if (!symbol && name.startsWith('$'))
			reporter.report(node, `${name} is not supported here (runes: $state, $derived, $effect, $props as top-level declarations/statements; $style anywhere)`);
		if (!symbol && name === 'getComputedStyle') reporter.report(node, 'getComputedStyle is a visual escape hatch and is not allowed');
		if (ref.access !== 'write') continue;
		if (symbol && READ_ONLY[symbol.kind]) reporter.report(node, READ_ONLY[symbol.kind](name));
		if (ref.destructured && isSignal(symbol))
			reporter.report(ref.destructured, 'destructuring assignment into a reactive variable is not supported; assign it directly');
	}
}

/**
 * Why changing `object` in place is not allowed, if it is not: it holds
 * objects of a reactive variable, and the change is not a member write
 * rooted at a `$state` variable (the one tracked form).
 */
function untrackedChange(bindings: Bindings, object: Estree): string | null {
	const shared = sharedWith(bindings, object);
	if (!shared) return null;
	const root = rootOf(object);
	const via = root?.type === 'Identifier' && root.name !== shared.name ? ` through "${root.name}"` : '';
	if (shared.kind !== 'state') return `${READ_ONLY[shared.kind](shared.name)}, so it cannot be changed in place${via ? ` (changed${via})` : ''}`;
	return `this changes reactive "${shared.name}"${via} in place, which is not tracked; assign through "${shared.name}" itself or assign a new value`;
}

function memberWrites(bindings: Bindings, reporter: Reporter) {
	for (const write of bindings.memberWrites) {
		const symbol = write.root?.symbol;
		if (write.inPattern) {
			if (isSignal(symbol) || sharedWith(bindings, write.target.object)) reporter.report(write.node, 'destructuring into a member of a reactive variable is not supported');
			continue;
		}
		// `todos[0].done = true`, `delete todos[0].note`: tracked.
		if (symbol?.kind !== 'state') {
			const problem = untrackedChange(bindings, write.target.object);
			if (problem) reporter.report(write.node, problem);
		}
		const object = write.target.object;
		if (object?.type === 'MemberExpression' && !object.computed && object.property.name === 'style' && fromDom(bindings, object.object))
			reporter.report(write.node, 'assigning to .style bypasses the visual model');
	}
}

/**
 * `$style` may appear anywhere. Every other rune is a top-level declaration
 * or statement, whose shape and arguments are checked where it is lowered.
 */
function runeCalls(component: Component, bindings: Bindings, reporter: Reporter) {
	const allowed = component.script?.runes ?? new Set();
	for (const { node, name } of bindings.runeCalls) {
		if (name === '$style') {
			if (node.arguments.length !== 1) reporter.report(node, '$style takes exactly one object');
		} else if (!allowed.has(node)) {
			const where = name === '$effect' ? 'a top-level statement' : name === '$props' ? 'a top-level `let { ... } = $props()` declaration' : 'a top-level `let x = ...` declaration';
			reporter.report(node, name in RUNES ? `${name}(...) is only allowed as ${where}` : `${name} is not supported`);
		}
	}
}

/**
 * `setContext` provides a value to the components this instance renders, so
 * it is called while the script sets the instance up: as a top-level statement.
 */
function contextCalls(component: Component, bindings: Bindings, reporter: Reporter) {
	const script = component.script;
	const symbols = new Set(script?.patchImports.filter((i) => i.imported === 'setContext').map((i) => bindings.topLevel(i.local)));
	if (!script || !symbols.size) return;
	const allowed = new Set(
		script.body.map((s) => unwrap(s.type === 'ExpressionStatement' ? s.expression : null)).filter((e) => e?.type === 'CallExpression').map((e) => unwrap(e.callee))
	);
	for (const ref of bindings.references)
		if (symbols.has(ref.symbol) && !allowed.has(ref.node))
			reporter.report(ref.node, 'setContext(...) is only allowed as a top-level statement of the script');
}

/** Rules that depend only on the shape of one node. */
function syntax(node: Estree, bindings: Bindings, reporter: Reporter) {
	switch (node.type) {
		case 'MemberExpression': {
			if (node.computed || node.property.type !== 'Identifier') return;
			const name = node.property.name;
			if (!(VISUAL_ESCAPES.has(name) || DOCUMENT_ESCAPES.has(name)) || !fromDom(bindings, node.object)) return;
			if (VISUAL_ESCAPES.has(name)) reporter.report(node.property, `.${name} bypasses the visual model; render through the template and style={...} instead`);
			else reporter.report(node.property, `document.${name} bypasses the visual model`);
			return;
		}
		case 'CallExpression': {
			const callee = unwrap(node.callee);
			if (callee.type !== 'MemberExpression' || callee.computed) return;
			const method = callee.property.name;
			// `Object.assign(target, …)`: changes its first argument.
			const owner = unwrap(callee.object);
			if (owner.type === 'Identifier' && !bindings.reference(owner)?.symbol && STATIC_MUTATORS[owner.name]?.includes(method)) {
				const shared = node.arguments[0] && sharedWith(bindings, node.arguments[0]);
				if (shared) reporter.report(callee, `${owner.name}.${method}() changes reactive "${shared.name}" in place, which is not tracked; assign a new value instead`);
				return;
			}
			if (!MUTATORS.has(method)) return;
			const shared = sharedWith(bindings, callee.object);
			if (!shared) return;
			const root = rootOf(callee.object);
			const via = root?.type === 'Identifier' && root.name !== shared.name ? ` (through "${root.name}")` : '';
			const instead = ARRAY_MUTATORS.has(method) ? 'assign a new array instead' : 'assign a new value instead';
			reporter.report(callee.property, `.${method}() mutates reactive "${shared.name}"${via} in place, which is not tracked; ${instead}`);
			return;
		}
		case 'ImportExpression':
			return reporter.report(node, 'dynamic import() is not supported in v0');
		case 'TSEnumDeclaration':
		case 'TSModuleDeclaration':
			return reporter.report(node, 'TypeScript enums/namespaces are not supported');
	}
}
