// Portals in the browser: elements rendered somewhere other than where they
// are declared. Ownership, effects, handlers and lifecycle stay with the
// declaration; only the DOM node moves. A `<portal>` is a pair of comments in
// its parent, and its content goes between them.

export type Portals = ReturnType<typeof createPortals>;

type Placement = { name: string | null; home: Comment; at: string };

export function createPortals() {
	/** Mounted portals by id, in mount order. Content goes into the first; the others are duplicates. */
	const portals = new Map<string, { end: Comment; at: string }[]>();
	/** Every element with `portal=`, in the order it was placed: the order content has in a portal. */
	const placed = new Map<Element, Placement>();
	/** Elements already reported as having no portal, until they get one. */
	const reported = new Set<Element>();
	let checkQueued = false;

	// A source may mount before its portal in the same render, so a missing
	// portal is reported once the render is over.
	const checkLater = () => {
		if (checkQueued) return;
		checkQueued = true;
		queueMicrotask(() => {
			checkQueued = false;
			for (const [el, p] of placed)
				if (p.name !== null && !portals.has(p.name) && !reported.has(el)) {
					reported.add(el);
					console.error(`No <portal id="${p.name}"> is rendered; the element at ${p.at} is not shown until one is`);
				}
		});
	};

	/** Puts `el` where its placement says: before its home, in its portal, or nowhere while the portal is missing. */
	const put = (el: Element, p: Placement) => {
		if (p.name === null) return p.home.parentNode?.insertBefore(el, p.home);
		const end = portals.get(p.name)?.[0].end;
		if (!end) {
			el.remove();
			return checkLater();
		}
		reported.delete(el);
		if (el.contains(end)) {
			el.remove();
			return console.error(`portal="${p.name}" at ${p.at} contains <portal id="${p.name}">, so it cannot render into it`);
		}
		end.parentNode!.insertBefore(el, end);
	};
	const refill = (name: string) => {
		for (const [el, p] of placed) if (p.name === name) put(el, p);
	};

	return {
		/** Mounts `<portal id="name">` in `parent` before `before`. Returns the function that unmounts it. */
		portal(name: string, at: string, parent: Node, before: Node | null): () => void {
			const start = parent.insertBefore(document.createComment(`portal ${name}`), before);
			const end = parent.insertBefore(document.createComment('/portal'), before);
			const list = portals.get(name) ?? [];
			if (list.length) console.error(`Duplicate <portal id="${name}"> (at ${list[0].at} and ${at}); content renders into the first`);
			list.push({ end, at });
			portals.set(name, list);
			if (list.length === 1) refill(name);
			return () => {
				const index = list.findIndex((p) => p.end === end);
				list.splice(index, 1);
				if (!list.length) portals.delete(name);
				// Content moves to the next duplicate, or out of the document.
				if (index === 0) refill(name);
				start.remove();
				end.remove();
			};
		},
		/** Renders `el`, declared just before `home`, into portal `name`, or in place when `name` is null. */
		place(el: Element, home: Comment, name: string | null, at: string) {
			const previous = placed.get(el);
			if (previous && previous.name === name) return;
			const p = { name, home, at };
			placed.delete(el);
			placed.set(el, p);
			put(el, p);
		},
		/** The element unmounted: removes it from wherever it rendered. */
		release(el: Element) {
			placed.delete(el);
			reported.delete(el);
			el.remove();
		}
	};
}
