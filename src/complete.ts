// Style completion: property names inside a style object, or the string
// literals a property accepts after `key:`.
//
// The incomplete construct under the cursor is patched into valid syntax and
// the front end re-runs, so which objects are styles, and for which element
// kind, comes from the same analysis the checks use. Anywhere else this
// returns nothing.

import { propertyName, type Estree } from './ast';
import { front } from './compile';
import { Reporter } from './diagnostics';
import { styleProperties, type StyleKind } from './schema/style';

export type Completion = {
	label: string;
	kind: 'property' | 'value';
	detail?: string;
	/** Text to insert when it differs from `label`. */
	insertText?: string;
};

const HOLE = '$$complete';

export function complete(source: string, offset: number, _options: { filename?: string } = {}): Completion[] {
	const before = source.slice(0, offset);
	const after = source.slice(offset);
	const value = /[A-Za-z_$][\w$]*\s*:\s*(['"]?)[\w-]*$/.exec(before);
	const keyPrefix = /[\w$]*$/.exec(before)![0];
	if (!value && !/[{,]$/.test(before.slice(0, offset - keyPrefix.length).trimEnd())) return [];

	// Replace the word under the cursor with something that parses: a value
	// `0`, or a property `$$complete: 0`.
	const quote = value?.[1] ?? '';
	const start = value ? offset - value[0].length + value[0].search(/['"\w-]*$/) : offset - keyPrefix.length;
	const end = offset + (value ? new RegExp(quote ? `^[\\w-]*${quote}?` : '^[\\w$-]*') : /^[\w$]*/).exec(after)![0].length;
	const rest = source.slice(end);
	const comma = /^\s*[,}]/.test(rest) ? '' : ',';
	const hole = value ? `0${comma}` : /^\s*:/.test(rest) ? HOLE : `${HOLE}: 0${comma}`;
	const patched = source.slice(0, start) + hole + rest;

	const result = front(patched, new Reporter(patched));
	if (!result) return [];
	const kinds = new Set<StyleKind>();
	let object: Estree;
	let property: Estree;
	for (const use of result.styles.uses) {
		const p = use.object.properties.find((p: Estree) => p.type === 'Property' && !p.computed && (value ? p.value : p.key).start === start);
		if (!p) continue;
		[object, property] = [use.object, p];
		kinds.add(use.kind);
	}
	if (!property) return [];

	// A `$style` const is checked where it is declared and again for every
	// element using it; only what is legal everywhere is offered.
	const [first, ...others] = [...kinds].map(styleProperties);
	const legal = first.filter((p) => others.every((list) => list.some((q) => q.name === p.name)));

	if (value) {
		const name = propertyName(property);
		return (legal.find((p) => p.name === name)?.values ?? []).map((v) => ({
			label: v,
			kind: 'value',
			detail: name,
			...(quote ? {} : { insertText: `'${v}'` })
		}));
	}
	const present = new Set(object.properties.filter((p: Estree) => p !== property && p.type === 'Property' && !p.computed).map(propertyName));
	return legal.filter((p) => !present.has(p.name)).map((p) => ({ label: p.name, kind: 'property', detail: p.hint }));
}
