// `$$rt`: the functions compiled scripts call, built on a reactive core. Each
// component instance gets its own: it carries the instance's path (which
// prefixes its state ids), its props and its context. Everything else
// (overrides, held effects, the reactive graph) is shared by the whole app.

import { stateId } from '../schema/path';
import type { Getter, RuntimeApi } from '../schema/program';
import { normalizeStyle } from '../schema/style';
import { createContext } from './context';
import { snippet } from './evaluate';
import type { Owner, Reactive } from './reactive';

export type ApiOptions = {
	/**
	 * Initial values by state id, replacing the script's (design-time states).
	 * A component's state id is its instance path and the name:
	 * `Row@12:3["a"]/expanded`.
	 */
	overrides?: Record<string, unknown>;
	/** Design time: `$effect`s are held until `startEffects()`, so the initial state is exactly the one given. */
	design?: boolean;
};

/** A component instance: its `$$rt`, the instance that rendered it, and the contexts it set. */
export type Instance = { api: RuntimeApi; parent: Instance | null; contexts: Map<object, unknown> };

const has = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

export function createApi(r: Reactive, { overrides = {}, design = false }: ApiOptions = {}) {
	// Effects created before the first interaction, with their instance's owner.
	let held: { fn: () => unknown; owner: Owner | null }[] | null = design ? [] : null;
	const effect = (fn: () => unknown) => {
		if (held) held.push({ fn, owner: r.currentOwner() });
		else r.deferredEffect(fn);
	};
	/** Starts the held effects of the instances still mounted, as their scripts would have. */
	const startEffects = () => {
		const list = held ?? [];
		held = null;
		for (const { fn, owner } of list) if (!owner?.disposed) r.within(owner, null, () => r.deferredEffect(fn));
	};

	/** An instance at `path` (`''` for the app) given the parent's prop getters. */
	const instance = (parent: Instance | null, path: string, props: Record<string, Getter>): Instance => {
		const contexts = new Map<object, unknown>();
		const self: Instance = { parent, contexts, api: null! };
		self.api = {
			state: (name, initial) => {
				const id = stateId(path, name);
				return r.cell(has(overrides, id) ? overrides[id] : initial?.());
			},
			derived: r.derived,
			effect,
			style: normalizeStyle,
			// Member assignment rooted at a state variable (`todos[0].done = true`).
			mutate: (target, result) => {
				(target as ReturnType<Reactive['cell']>).notify();
				return result;
			},
			prop: (name, fallback) =>
				r.derived(() => {
					const value = has(props, name) ? props[name]() : undefined;
					return value === undefined && fallback ? fallback() : value;
				}),
			snippet,
			createContext,
			setContext: (key, value) => void contexts.set(key, value),
			getContext: (key) => {
				for (let i: Instance | null = self; i; i = i.parent) if (i.contexts.has(key)) return i.contexts.get(key);
				throw new Error(`getContext: no component above ${path ? `<${path.slice(0, -1)}>` : 'the app'} called setContext for this context`);
			}
		};
		return self;
	};

	return { root: instance(null, '', {}), instance, startEffects };
}
