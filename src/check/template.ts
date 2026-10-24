// Rules for template constructs that the IR can express but PAT rejects.

import { forEachNode } from '../ast';
import type { Bindings } from '../bind';
import type { Reporter } from '../diagnostics';
import { elements, expressions, fragments, type Component, type TemplateNode } from '../ir';

const INPUT_TYPES = ['text', 'password', 'email', 'search', 'url', 'tel'];

export function checkTemplate(component: Component, bindings: Bindings, reporter: Reporter) {
	for (const element of elements(component.template)) {
		if (element.type !== 'element') continue;
		const bound = element.attributes.some((a) => a.type === 'bind' && a.name === 'value');
		for (const a of element.attributes) {
			if (a.type === 'bind') {
				const symbol = a.expression.type === 'Identifier' ? bindings.reference(a.expression)?.symbol : null;
				// Patch writes the element as it mounts and unmounts: the variable changes, so it is state.
				if (symbol?.kind !== 'state')
					reporter.report(a.nameSpan, a.name === 'value' ? 'bind:value needs a top-level $state variable' : 'bind:this needs a top-level $state variable: let el = $state<HTMLElement>()');
			} else if (bound && ((a.type === 'attribute' && a.name === 'value') || (a.type === 'event' && a.name === 'input'))) {
				reporter.report(a.nameSpan, 'bind:value cannot be combined with value= or oninput=');
			} else if (a.type === 'attribute' && a.name === 'type') {
				const value = a.value !== true && 'parts' in a.value && a.value.parts.length === 1 ? a.value.parts[0] : null;
				if (typeof value !== 'string' || !INPUT_TYPES.includes(value)) reporter.report(a.nameSpan, `type must be one of ${INPUT_TYPES.join(', ')}`);
			}
		}
	}
	snippetNames(component.template, reporter);
}

/** Template expressions may only name script bindings, `{#each}` names and real globals. */
export function checkTemplateNames(component: Component, bindings: Bindings, globals: Set<string>, reporter: Reporter) {
	for (const expression of expressions(component.template))
		forEachNode(expression, (node) => {
			if (node.type !== 'Identifier' || node.name.startsWith('$')) return;
			const ref = bindings.reference(node);
			if (ref && !ref.symbol && !globals.has(node.name)) reporter.report(node, `"${node.name}" is not defined`);
		});
}

/** Two snippets in one block would declare the same name. */
function snippetNames(nodes: TemplateNode[], reporter: Reporter) {
	const seen = new Set<string>();
	for (const node of nodes) {
		if (node.type === 'snippet') {
			if (seen.has(node.name.name)) reporter.report(node.name, `snippet "${node.name.name}" is already declared in this block`);
			seen.add(node.name.name);
		}
		for (const fragment of fragments(node)) snippetNames(fragment, reporter);
	}
}
