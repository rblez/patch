// How rendered things are named: snapshot node ids, the state ids that
// design-time overrides address, and the locations warnings point to.
//
//   location  `line:column` of a construct in its .pat file
//   keys      `[json]` per enclosing `{#each}` item in that file, outermost first
//   path      one step per component instance, `Tag@location[keys]/`, and per
//             `{@render}`, `location[keys]/`, from the app down
//   node id   path, the node's location, then its keys: `Row@12:3["a"]/4:5[0]`
//   state id  path, then the variable: `Row@12:3["a"]/expanded`

export const location = (line: number, column: number) => `${line}:${column}`;

/** Where a node is: the path of the instance (or `{@render}`) it renders in, and the keys since. */
export type Place = { path: string; keys: string };

export const ROOT_PLACE: Place = { path: '', keys: '' };

/** Inside the `{#each}` item keyed `key`. */
export const eachPlace = (place: Place, key: unknown): Place => ({ ...place, keys: `${place.keys}[${JSON.stringify(key)}]` });
/** Inside the instance of `<Tag>` at `at`. */
export const instancePlace = (place: Place, tag: string, at: string): Place => ({ path: `${place.path}${tag}@${at}${place.keys}/`, keys: '' });
/** Inside what the `{@render}` at `at` renders. */
export const renderPlace = (place: Place, at: string): Place => ({ path: `${place.path}${at}${place.keys}/`, keys: '' });

export const nodeId = (place: Place, at: string) => place.path + at + place.keys;
export const stateId = (path: string, name: string) => path + name;

/** How the instances of `<Tag>` at `at` are named in messages: `Tag@at[<key>]/` when an `{#each}` repeats it. */
export const sitePattern = (tag: string, at: string, repeated: boolean) => `${tag}@${at}${repeated ? '[<key>]' : ''}/`;

/** The offsets in `text` of `char` outside `[…]` keys (and their JSON strings), and whether the brackets balance there. */
export function outsideKeys(text: string, char: string): { at: number[]; balanced: boolean } {
	const at: number[] = [];
	let depth = 0;
	let string = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (string) {
			if (c === '\\') i++;
			else if (c === '"') string = false;
		} else if (c === '"') string = depth > 0;
		else if (c === '[') depth++;
		else if (c === ']') depth--;
		else if (c === char && depth === 0) at.push(i);
	}
	return { at, balanced: depth === 0 && !string };
}

/** Splits an id at the `/`s outside `[…]` keys. Null when brackets do not balance. */
function segments(id: string): string[] | null {
	const { at, balanced } = outsideKeys(id, '/');
	if (!balanced) return null;
	return [-1, ...at].map((start, i) => id.slice(start + 1, at[i] ?? id.length));
}

/** One step of a path: a component instance (`tag`), or a `{@render}` (no tag). */
export type Step = { tag: string | null; at: string };

const COMPONENT_STEP = /^([A-Za-z_$][\w$]*)@(\d+:\d+)(?:\[.*\])*$/;
const RENDER_STEP = /^(\d+:\d+)(?:\[.*\])*$/;

/** The steps and variable a state id names, or null when it is not one. */
export function parseStateId(id: string): { steps: Step[]; name: string } | null {
	const parts = segments(id);
	if (!parts) return null;
	const name = parts.pop()!;
	const steps: Step[] = [];
	for (const part of parts) {
		const component = COMPONENT_STEP.exec(part);
		const render = RENDER_STEP.exec(part);
		if (component) steps.push({ tag: component[1], at: component[2] });
		else if (render) steps.push({ tag: null, at: render[1] });
		else return null;
	}
	return { steps, name };
}

/** The node's own location in its file, without the path and keys of its id. */
export const ownLocation = (nodeId: string) => {
	const last = segments(nodeId)?.at(-1) ?? nodeId;
	return /^\d+:\d+/.exec(last)?.[0] ?? last;
};
