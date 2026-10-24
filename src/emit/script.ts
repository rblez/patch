// Rewrites the author's JS/TS onto the runtime (`$$rt`). Runs only on code
// that passed every check, so it makes no decisions of its own: each binding
// list maps to one kind of edit.
//
//   reading or assigning `count`      → `count.v`
//   `{ count }`                       → `{ count: count.v }`
//   `todos[0].done = true`            → `$$rt.mutate(todos, todos.v[0].done = true)`
//   `$state(x)` / `$state()`          → `$$rt.state("name", () => (x))` / `$$rt.state("name")`
//   `$derived(expr)`                  → `$$rt.derived(() => (expr))`
//   `$derived.by` / `$effect` / `$style` → `$$rt.derived` / `$$rt.effect` / `$$rt.style`
//   `let { a, b: c, d = 1 } = $props()` → `let a = $$rt.prop("a"), c = $$rt.prop("b"), d = $$rt.prop("d", () => (1))`
//   `import { getContext } from 'patch'` → `const getContext = $$rt.getContext` (per instance)
//   `import …`                        → moved to the top of the module

import { isSignal, type Bindings } from '../bind';
import type { Component } from '../ir';
import { RUNES, type Rune } from '../schema/program';
import type { Edits } from './edits';

/** Records every script and template expression edit. Returns the script body and its imports. */
export function emitScript(component: Component, bindings: Bindings, source: string, edits: Edits) {
	const script = component.script;
	const imports: string[] = [];
	for (const statement of script?.imports ?? []) {
		if (statement.source.value !== 'patch') imports.push(source.slice(statement.start, statement.end));
		edits.replace(statement.start, statement.end, '');
	}
	const preamble = script?.patchImports.map((i) => `const ${i.local} = $$rt.${i.imported};\n`).join('') ?? '';

	// Edits at the same offset nest in the order they are recorded (later is
	// further out): references, then member writes (inner first), then runes.
	for (const ref of bindings.references) {
		if (!isSignal(ref.symbol)) continue;
		const { name, start, end } = ref.node;
		if (ref.shorthand) edits.replace(start, end, `${name}: ${name}.v`);
		else edits.after(end, '.v');
	}
	for (const write of bindings.memberWrites) {
		if (write.inPattern || write.root?.symbol?.kind !== 'state') continue;
		edits.before(write.node.start, `$$rt.mutate(${write.root.node.name}, `);
		edits.after(write.node.end, ')');
	}
	const stateIds = new Map(script?.state.map((d) => [d.call, d.info.id]));
	for (const { node, name } of bindings.runeCalls) {
		if (name === '$props') continue;
		// Only runes reach here: anything else is reported.
		edits.replace(node.callee.start, node.callee.end, `$$rt.${RUNES[name as Rune]}`);
		const [first] = node.arguments;
		if (name === '$state') {
			const id = JSON.stringify(stateIds.get(node));
			if (first) {
				edits.before(first.start, `${id}, () => (`);
				edits.after(first.end, ')');
			} else edits.before(node.end - 1, id);
		} else if (name === '$derived') {
			edits.before(first.start, '() => (');
			edits.after(first.end, ')');
		}
	}

	// Last: the fallbacks are rendered with every edit inside them.
	const declarator = script?.propsDeclarator;
	if (declarator) {
		const props = script.props.map(({ key, local, fallback }) => {
			const fn = fallback ? `, () => (${edits.render(fallback.start, fallback.end)})` : '';
			return `${local.name} = $$rt.${RUNES.$props}(${JSON.stringify(key)}${fn})`;
		});
		edits.replace(declarator.start, declarator.end, props.join(', ') || '$$props = null');
	}

	return { code: script ? preamble + edits.render(script.span.start, script.span.end) : '', imports };
}
