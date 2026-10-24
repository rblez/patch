// Fine-grained reactivity: cells, lazy derived values, effects, batching.
//
// Effects and derived values are "owners": they track the cells they read and
// re-run when one changes. Owners form a tree; disposing one disposes its
// children and runs their cleanups.

export type Owner = {
	children: Set<Owner>;
	cleanups: (() => void)[];
	parent: Owner | null;
	disposed: boolean;
	id?: number;
	fn?: () => void;
	deps?: Set<Set<Owner>>;
	derived?: () => void;
};

export type Cell<T = any> = { v: T; notify: () => void };

export type Reactive = ReturnType<typeof createReactive>;

export function createReactive() {
	let owner: Owner | null = null;
	let observer: Owner | null = null;
	let nextId = 0;
	let batchDepth = 0;
	let flushing = false;
	const queue = new Set<Owner>();

	const newOwner = (extra: Partial<Owner> = {}): Owner => {
		const o: Owner = { children: new Set(), cleanups: [], parent: owner, disposed: false, ...extra };
		owner?.children.add(o);
		return o;
	};
	const reset = (o: Owner) => {
		for (const child of [...o.children]) dispose(child);
		for (const cleanup of o.cleanups.splice(0)) cleanup();
		if (o.deps) {
			for (const subs of o.deps) subs.delete(o);
			o.deps.clear();
		}
	};
	const dispose = (o: Owner) => {
		if (o.disposed) return;
		reset(o);
		o.disposed = true;
		o.parent?.children.delete(o);
	};
	/** Runs `fn` with `o` as the owner of anything it creates and `obs` tracking its reads. */
	const within = <T>(o: Owner | null, obs: Owner | null, fn: () => T): T => {
		const prevOwner = owner;
		const prevObserver = observer;
		owner = o;
		observer = obs;
		try {
			return fn();
		} finally {
			owner = prevOwner;
			observer = prevObserver;
		}
	};
	const track = (subs: Set<Owner>) => {
		if (!observer) return;
		subs.add(observer);
		observer.deps!.add(subs);
	};
	const trigger = (subs: Set<Owner>) => {
		batchDepth++;
		try {
			for (const c of [...subs]) c.derived ? c.derived() : queue.add(c);
		} finally {
			batchDepth--;
		}
		if (!batchDepth) flush();
	};
	/** One run of an effect. An error is logged and leaves the effect subscribed to what it read, on the first run as on later ones. */
	const run = (c: Owner) => {
		reset(c);
		try {
			within(c, c, c.fn!);
		} catch (error) {
			console.error(error);
		}
	};
	const flush = () => {
		if (flushing) return;
		flushing = true;
		let rounds = 0;
		try {
			while (queue.size) {
				if (++rounds > 1000) throw new Error('Reactive loop: effects keep invalidating each other');
				const pending = [...queue].sort((a, b) => a.id! - b.id!);
				queue.clear();
				for (const c of pending) if (!c.disposed) run(c);
			}
		} finally {
			queue.clear();
			flushing = false;
		}
	};
	const batch = <T>(fn: () => T): T => {
		batchDepth++;
		try {
			return fn();
		} finally {
			batchDepth--;
			if (!batchDepth) flush();
		}
	};
	const untrack = <T>(fn: () => T): T => within(owner, null, fn);
	/** Runs `fn` when the current owner is reset or disposed. */
	const onCleanup = (fn: () => void) => owner?.cleanups.push(fn);

	const cell = <T>(initial: T): Cell<T> => {
		const subs = new Set<Owner>();
		let value = initial;
		return {
			get v(): T {
				track(subs);
				return value;
			},
			set v(next: T) {
				if (Object.is(next, value)) return;
				value = next;
				trigger(subs);
			},
			notify: () => trigger(subs)
		};
	};

	/**
	 * Lazy and cached; invalidated by its dependencies. Created under an owner
	 * (a component instance, a block), it stops listening when that owner is
	 * reset or disposed, and recomputes if it is read again.
	 */
	const derived = <T>(fn: () => T) => {
		const subs = new Set<Owner>();
		let value: T;
		let dirty = true;
		const c: Owner = {
			children: new Set(),
			cleanups: [],
			parent: null,
			disposed: false,
			id: nextId++,
			deps: new Set(),
			derived: () => {
				if (dirty) return;
				dirty = true;
				trigger(subs);
			}
		};
		onCleanup(() => {
			reset(c);
			dirty = true;
		});
		return {
			get v(): T {
				if (dirty) {
					reset(c);
					value = within(c, c, fn);
					dirty = false;
				}
				track(subs);
				return value;
			}
		};
	};

	/** Runs now, re-runs when its dependencies change. */
	const effect = (fn: () => void) => {
		const c = newOwner({ id: nextId++, fn, deps: new Set() });
		run(c);
		return c;
	};

	/** Like `effect`, but the first run is queued until the current batch ends. A returned function is a cleanup. */
	const deferredEffect = (fn: () => unknown) => {
		const c = newOwner({
			id: nextId++,
			deps: new Set(),
			fn: () => {
				const cleanup = fn();
				if (typeof cleanup === 'function') owner!.cleanups.push(cleanup as () => void);
			}
		});
		queue.add(c);
		if (!batchDepth) flush();
	};

	const currentOwner = () => owner;

	return { newOwner, dispose, within, batch, untrack, onCleanup, currentOwner, cell, derived, effect, deferredEffect };
}
