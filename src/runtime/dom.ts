// Browser rendering: mounts a program into the DOM with fine-grained effects.
// Sizing semantics live in one fixed stylesheet keyed on data-* attributes;
// each element's own style becomes inline CSS.

import { anchored } from '../schema/anchor';
import type { ComponentNode, ElementNode, InlinePart, Program, ProgramNode, RenderNode, SpanNode } from '../schema/program';
import { effectiveSizing, LINE_HEIGHT, ROOT_FONT, SHORTHANDS, sizingOf, type ElementKind, type Sizing, type Style } from '../schema/style';
import { createApi, type ApiOptions, type Instance } from './api';
import { createAnchoring, type AnchorSpec } from './anchoring';
import { eachPlace, instancePlace, renderPlace, ROOT_PLACE, type Place } from '../schema/path';
import { componentOf, eachList, elementStyle, portalName, renderable, toText, withId } from './evaluate';
import { createPortals } from './portals';
import { createReactive, type Cell, type Owner } from './reactive';

const BASE_CSS = `
html,body{margin:0;padding:0}
[data-p]{box-sizing:border-box;margin:0;padding:0;border:0;outline:0;min-width:0;min-height:0;flex:0 0 auto;font:inherit;color:inherit;letter-spacing:inherit;text-align:inherit;text-transform:inherit;background:none;border-radius:0;appearance:none;-webkit-appearance:none;position:relative}
[data-p=frame]{display:flex;flex-direction:column;align-items:flex-start;align-content:flex-start}
[data-dir=row]{flex-direction:row}
[data-p=input],[data-p=textarea]{display:block;resize:none;overflow:hidden}
[data-p=input][data-w=hug],[data-p=textarea][data-w=hug]{width:var(--hug-w)}
[data-p=textarea][data-h=hug]{height:var(--hug-h)}
[data-p=input]::placeholder,[data-p=textarea]::placeholder{color:currentColor;opacity:.5}
[data-p=text]{display:block;white-space:pre}
[data-p=text][data-w=fixed],[data-p=text][data-w=fill]{white-space:pre-wrap}
[data-overflow=ellipsis]{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}
[data-p=inline]{display:inline}
[data-p=text],[data-p=inline],[data-p=input],[data-p=textarea],[data-run]{text-decoration-line:var(--decoration,none)}
[data-mixed]{text-decoration-line:none}
[data-anchored][data-w=hug]{width:max-content}
[data-dir=row]>[data-w=fill],[data-dir=column]>[data-h=fill]{flex:1 1 0}
[data-dir=row]>[data-h=fill],[data-dir=column]>[data-w=fill]{align-self:stretch!important}
button[data-p]{cursor:pointer}
[data-host]{width:100vw;height:100vh;overflow:auto;background:#fff}
`;
const FLEX_VALUE: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', 'space-between': 'space-between', baseline: 'baseline' };
const px = (v: unknown) => (v === 'auto' ? 'auto' : `${v}px`);
const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
/** Properties whose value is already the CSS value. */
const VERBATIM = ['cursor', 'userSelect', 'pointerEvents', 'touchAction', 'overscrollBehavior', 'caretColor'] as const;

/**
 * A validated style as inline CSS, plus data-* attributes: the authored
 * sizing (`sw`/`sh`, resolved into the `w`/`h` the stylesheet keys on by
 * `resolveSizing`), the flex direction and a text's overflow.
 */
function toCss(kind: ElementKind, st: Style) {
	const css: Record<string, string> = {};
	const data: Record<string, string> = { sw: sizingOf(st.width), sh: sizingOf(st.height) };
	if (kind === 'frame') data.dir = st.flexDirection ?? 'column';
	if (kind === 'text') data.overflow = st.textOverflow ?? 'clip';
	if (st.textOverflow === 'ellipsis') css['-webkit-line-clamp'] = String(st.maxLines ?? 1);
	if (typeof st.width === 'number') css.width = px(st.width);
	if (typeof st.height === 'number') css.height = px(st.height);
	for (const k of ['minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'left', 'top', 'gap', 'fontSize', 'lineHeight', 'letterSpacing'] as const)
		// Contextual values ("available") are set by the anchoring engine.
		if (typeof st[k] === 'number') css[kebab(k)] = px(st[k]);
	for (const k of VERBATIM) if (st[k]) css[kebab(k)] = st[k];
	// Safari only knows the prefixed property.
	if (st.userSelect) css['-webkit-user-select'] = st.userSelect;
	const box = (prefix: string) => {
		const keys = SHORTHANDS[prefix];
		if (keys.some((k) => st[k] !== undefined)) css[prefix] = keys.map((k) => px(st[k] ?? 0)).join(' ');
	};
	box('padding');
	box('margin');
	if (st.justifyContent) css['justify-content'] = FLEX_VALUE[st.justifyContent];
	if (st.alignItems) css['align-items'] = FLEX_VALUE[st.alignItems];
	if (st.alignSelf) css['align-self'] = FLEX_VALUE[st.alignSelf];
	if (st.flexWrap) css['flex-wrap'] = st.flexWrap;
	if (st.position === 'absolute') css.position = 'absolute';
	if (st.background) css['background-color'] = st.background;
	if (st.color) css.color = st.color;
	if (st.opacity !== undefined) css.opacity = String(st.opacity);
	if (st.borderWidth) {
		// Borders are drawn inside the box and never affect layout.
		css.outline = `${st.borderWidth}px solid ${st.borderColor ?? '#000000'}`;
		css['outline-offset'] = `-${st.borderWidth}px`;
	}
	if (st.borderRadius) css['border-radius'] = st.borderRadius.map(px).join(' ');
	// An unset axis is `visible`, which the browser turns into `auto` when the other axis is not.
	if (st.overflowX) css['overflow-x'] = st.overflowX;
	if (st.overflowY) css['overflow-y'] = st.overflowY;
	if (st.boxShadow) css['box-shadow'] = st.boxShadow.map((s: any) => `${s.inset ? 'inset ' : ''}${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${s.color}`).join(', ');
	if (st.fontFamily) css['font-family'] = JSON.stringify(st.fontFamily);
	if (st.fontWeight) css['font-weight'] = String(st.fontWeight);
	if (st.fontStyle) css['font-style'] = st.fontStyle;
	if (st.textAlign) css['text-align'] = st.textAlign;
	if (st.textTransform) css['text-transform'] = st.textTransform;
	// Inherited as a value and drawn by the elements holding the text (see `mountInline`).
	if (st.textDecoration) css['--decoration'] = st.textDecoration;
	return { css, data };
}

/** The root typography, set on the host for every element to inherit. */
const HOST_FONT_CSS = (() => {
	const { lineHeight, ...font } = ROOT_FONT;
	const { css } = toCss('frame', font);
	const declarations = Object.entries(css).map(([k, v]) => `${k}:${v}`);
	declarations.push(`line-height:${lineHeight === null ? LINE_HEIGHT : px(lineHeight)}`);
	return `[data-host]{${declarations.join(';')}}\n`;
})();

/**
 * Writes every element's effective sizing (`data-w`/`data-h`) from its
 * authored sizing, its parent's effective sizing and its flow siblings, top
 * down from a frame whose own sizing is `w` × `h`.
 */
function resolveSizing(frame: Element, w: Sizing, h: Sizing) {
	if (!frame.children) return;
	const row = frame.getAttribute('data-dir') === 'row';
	const kids = [...frame.children].filter((k) => k.hasAttribute('data-p'));
	const flow = kids.filter((k) => (k as HTMLElement).style.position !== 'absolute');
	for (const k of kids) {
		const only = flow.length === 1 && flow[0] === k;
		const authored = (axis: string) => (k.getAttribute(`data-s${axis}`) as Sizing | null) ?? 'hug';
		const kw = effectiveSizing(authored('w'), w, row, only);
		const kh = effectiveSizing(authored('h'), h, !row, only);
		if (k.getAttribute('data-w') !== kw) k.setAttribute('data-w', kw);
		if (k.getAttribute('data-h') !== kh) k.setAttribute('data-h', kh);
		if (k.getAttribute('data-p') === 'frame') resolveSizing(k, kw, kh);
		else if (k.getAttribute('data-p') === 'input') sizeControl(k as HTMLInputElement, kw === 'hug', false);
		else if (k.getAttribute('data-p') === 'textarea') sizeControl(k as HTMLTextAreaElement, kw === 'hug', kh === 'hug');
	}
}

let mirror: HTMLElement | null = null;

/**
 * The content size of a form control that hugs, as for any text: what it
 * shows (its value, masked for passwords, else its placeholder) at its
 * font, plus padding. Width is the widest line, unwrapped; a textarea's
 * height is its lines, wrapped at its width unless the width hugs too, and
 * at least one line.
 * Browsers would size such a control by its `size`/`rows` instead.
 */
function sizeControl(el: HTMLInputElement | HTMLTextAreaElement, width: boolean, height: boolean) {
	if (!width) el.style.removeProperty('--hug-w');
	if (!height) el.style.removeProperty('--hug-h');
	if (!width && !height) return;
	const cs = getComputedStyle(el);
	const px = (v: string) => parseFloat(v) || 0;
	const shown = el.value ? (el.type === 'password' ? '•'.repeat(el.value.length) : el.value) : el.placeholder;
	if (!mirror) {
		mirror = document.createElement('div');
		mirror.setAttribute('aria-hidden', 'true');
	}
	if (!mirror.isConnected) document.body.appendChild(mirror);
	mirror.style.cssText = `position:absolute;left:-99999px;top:0;visibility:hidden;margin:0;padding:0;border:0;font-family:${cs.fontFamily};font-size:${cs.fontSize};font-weight:${cs.fontWeight};font-style:${cs.fontStyle};font-feature-settings:${cs.fontFeatureSettings};letter-spacing:${cs.letterSpacing};line-height:${cs.lineHeight};text-transform:${cs.textTransform};white-space:pre`;
	mirror.textContent = shown;
	if (width) el.style.setProperty('--hug-w', `${mirror.getBoundingClientRect().width + px(cs.paddingLeft) + px(cs.paddingRight)}px`);
	if (height) {
		if (!width) {
			mirror.style.whiteSpace = 'pre-wrap';
			mirror.style.width = `${el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight)}px`;
		}
		// An empty textarea still has its insertion line.
		const lines = Math.max(mirror.getBoundingClientRect().height, px(cs.lineHeight));
		el.style.setProperty('--hug-h', `${lines + px(cs.paddingTop) + px(cs.paddingBottom)}px`);
	}
}

const removeRange = (start: Node, end: Node) => {
	let node: Node | null = start;
	while (node) {
		const next: Node | null = node === end ? null : node.nextSibling;
		node.parentNode?.removeChild(node);
		node = next;
	}
};
const moveRange = (start: Node, end: Node, before: Node) => {
	let node: Node | null = start;
	while (node) {
		const next: Node | null = node === end ? null : node.nextSibling;
		before.parentNode!.insertBefore(node, before);
		node = next;
	}
};

/**
 * Mounts `program` into `target`. Returns a function that disposes it.
 * `options` start it from overridden state (snapshots); with `design`, its
 * `$effect`s start at the first interaction, so the initial view is exactly
 * that state and the app behaves as usual from then on.
 */
export function mount(program: Program, target: HTMLElement, options: ApiOptions = {}): () => void {
	const r = createReactive();
	const { effect, newOwner, dispose, within, untrack, onCleanup, batch, cell, derived } = r;
	const root = newOwner();
	const { root: app, instance, startEffects } = createApi(r, options);
	const portals = createPortals();
	const anchoring = createAnchoring(target);
	const interact = () => batch(startEffects);

	// Anchored elements are placed once a render has laid everything out,
	// after sizing, and again whenever anything may have moved them.
	let placingQueued = false;
	const placeLater = () => {
		if (placingQueued || !anchoring.active()) return;
		placingQueued = true;
		queueMicrotask(() => {
			placingQueued = false;
			anchoring.update();
		});
	};

	// Sizing depends on parents and siblings, so it is resolved in one pass
	// after styles or structure change, before the browser paints.
	let sizingQueued = false;
	const resizeLater = () => {
		if (sizingQueued) return;
		sizingQueued = true;
		queueMicrotask(() => {
			sizingQueued = false;
			resolveSizing(target, 'fixed', 'fixed');
			placeLater();
		});
	};

	const bindStyle = (el: HTMLElement, d: ElementNode | SpanNode, kind: ElementKind) => {
		let prev: Record<string, string> = {};
		effect(() => {
			const st = elementStyle(d, kind);
			const { css, data } = toCss(kind, st);
			for (const k of Object.keys(prev)) if (!(k in css)) el.style.removeProperty(k);
			for (const [k, v] of Object.entries(css)) if (prev[k] !== v) el.style.setProperty(k, v);
			for (const [k, v] of Object.entries(data)) el.setAttribute(`data-${k}`, v);
			if (kind !== 'inline') {
				const spec: AnchorSpec | null = st.anchor === undefined ? null : { anchor: st.anchor instanceof Element ? st.anchor : null, ...anchored(st) };
				anchoring.track(el, spec, css);
			}
			prev = css;
			resizeLater();
		});
		if (kind !== 'inline') onCleanup(() => anchoring.track(el, null, {}));
	};

	const setAttribute = (el: any, name: string, value: unknown) => {
		if (name === 'value') {
			const next = toText(value);
			if (el.value !== next) el.value = next;
		} else if (name === 'disabled') el.disabled = !!value;
		else el.setAttribute(name, toText(value));
	};

	const element = (d: ElementNode | SpanNode, tag: string, kind: ElementKind) => {
		const el = document.createElement(tag);
		el.setAttribute('data-p', kind);
		if (d.style || kind !== 'inline') bindStyle(el, d, kind);
		if (d.t === 'el') {
			const control = kind === 'input' || kind === 'textarea';
			for (const [name, value] of Object.entries(d.attrs))
				effect(() => {
					setAttribute(el, name, withId(d.id, value));
					// What a control shows is its content size.
					if (control) resizeLater();
				});
			if (control) el.addEventListener('input', resizeLater);
			for (const [name, handler] of Object.entries(d.on))
				el.addEventListener(name, (event: Event) => {
					interact();
					batch(() => {
						const fn = untrack(handler);
						if (typeof fn === 'function') fn(event);
						else if (fn != null) throw new Error(`on${name} must be a function (at ${d.id})`);
					});
				});
		}
		return el;
	};

	/**
	 * A CSS text decoration also draws across the element's descendants and
	 * cannot be removed by them, but a decoration is inherited typography that
	 * a nested span can override. So text holding spans does not decorate
	 * itself: its own text goes in `data-run` spans, which do.
	 */
	const mountInline = (parts: InlinePart[], parent: Element) => {
		const mixed = parts.some((part) => typeof part === 'object');
		if (mixed) parent.setAttribute('data-mixed', '');
		const holder = () => {
			if (!mixed) return parent;
			const run = document.createElement('span');
			run.setAttribute('data-run', '');
			return parent.appendChild(run);
		};
		for (const part of parts) {
			if (typeof part === 'string') holder().appendChild(document.createTextNode(part));
			else if (typeof part === 'function') {
				const node = document.createTextNode('');
				effect(() => {
					node.data = toText(part());
					// New text can move boxes without resizing an anchor.
					placeLater();
				});
				holder().appendChild(node);
			} else {
				const span = element(part, 'span', 'inline');
				mountInline(part.kids, span);
				parent.appendChild(span);
			}
		}
	};

	/** What mounted content belongs to: the component instance rendering it, and where it is (for ids). */
	type Scope = { instance: Instance; place: Place };

	const mountNodes = (nodes: ProgramNode[], parent: Node, before: Node | null, scope: Scope) => {
		for (const d of nodes) {
			if (d.t === 'text') {
				const span = document.createElement('span');
				span.setAttribute('data-p', 'text');
				span.setAttribute('data-w', 'hug');
				span.setAttribute('data-h', 'hug');
				mountInline(d.parts, span);
				parent.insertBefore(span, before);
			} else if (d.t === 'el') {
				const el = element(d, d.tag, d.kind);
				if (d.kind === 'frame') mountNodes(d.kids, el, null, scope);
				else if (d.kind === 'text') mountInline(d.kids, el);
				if (d.portal) mountPortaled(d, el, parent, before);
				else parent.insertBefore(el, before);
				const ref = d.ref;
				if (ref) {
					ref.set(el);
					// Another element may have taken the variable since.
					onCleanup(() => untrack(ref.get) === el && ref.set(undefined));
				}
			} else if (d.t === 'if') mountIf(d, parent, before, scope);
			else if (d.t === 'each') mountEach(d, parent, before, scope);
			else if (d.t === 'component') mountComponent(d, parent, before, scope);
			else if (d.t === 'render') mountRender(d, parent, before, scope);
			else if (d.t === 'portal') onCleanup(portals.portal(d.name, d.id, parent, before));
		}
	};

	// The element belongs here (`home` marks the spot) but renders into its
	// portal. On an invalid value it stays where it was, or in place at first.
	const mountPortaled = (d: ElementNode, el: HTMLElement, parent: Node, before: Node | null) => {
		const home = parent.insertBefore(document.createComment('portaled'), before);
		let name: string | null = null;
		effect(() => {
			try {
				name = withId(d.id, () => portalName(d.portal!()));
			} finally {
				untrack(() => portals.place(el, home, name, d.id));
				resizeLater();
			}
		});
		onCleanup(() => {
			portals.release(el);
			home.remove();
		});
	};

	/**
	 * A region showing what `select` picks. When the pick changes, the old
	 * content is destroyed (its owner disposed, its nodes removed) and
	 * `content` mounts the new one, in an owner of its own, before `end`.
	 */
	const mountRegion = <T>(label: string, parent: Node, before: Node | null, select: () => T, content: (pick: T, end: Node) => void) => {
		const end = parent.insertBefore(document.createComment(`/${label}`), before);
		const container = newOwner();
		let active: { pick: T } | null = null;
		let region: { start: Node; owner: Owner } | null = null;
		within(container, null, () =>
			effect(() => {
				const pick = select();
				if (active && Object.is(active.pick, pick)) return;
				active = { pick };
				untrack(() => {
					if (region) {
						dispose(region.owner);
						removeRange(region.start, end.previousSibling!);
					}
					const start = parent.insertBefore(document.createComment(label), end);
					const owner = within(container, null, () => newOwner());
					region = { start, owner };
					within(owner, null, () => content(pick, end));
				});
				resizeLater();
			})
		);
	};

	// A false branch is unmounted; re-entering it creates it again.
	const mountIf = (d: Extract<ProgramNode, { t: 'if' }>, parent: Node, before: Node | null, scope: Scope) =>
		mountRegion(
			'if',
			parent,
			before,
			() => withId(d.id, () => d.b.findIndex(([test]) => test())),
			(index, end) => {
				const kids = index >= 0 ? d.b[index][1] : d.e;
				if (kids) mountNodes(kids, parent, end, scope);
			}
		);

	/**
	 * A component instance: its script runs once, in an owner of its own, and
	 * its template mounts here. Props stay the parent's getters, read through
	 * the child's `$$rt.prop`, so a changed prop updates what reads it and the
	 * instance stays. Only a different component replaces it.
	 */
	const mountComponent = (d: ComponentNode, parent: Node, before: Node | null, scope: Scope) =>
		mountRegion(
			'component',
			parent,
			before,
			() => withId(d.id, d.component),
			(value, end) => {
				const component = componentOf(value, d.tag, d.id) as Program;
				const place = instancePlace(scope.place, d.tag, d.id);
				const props = Object.fromEntries(Object.entries(d.props).map(([name, get]) => [name, () => withId(d.id, get)]));
				const child = instance(scope.instance, place.path, props);
				mountNodes(withId(d.id, () => component(child.api)), parent, end, { instance: child, place });
			}
		);

	// The snippet's nodes belong to the instance rendering them; its arguments are cells.
	const mountRender = (d: RenderNode, parent: Node, before: Node | null, scope: Scope) =>
		mountRegion(
			'render',
			parent,
			before,
			() => withId(d.id, d.snippet),
			(value, end) => {
				const fn = renderable(value, d.optional, d.id);
				if (!fn) return;
				const args = d.args.map((arg) => derived(() => withId(d.id, arg)));
				mountNodes(fn(...args), parent, end, { instance: scope.instance, place: renderPlace(scope.place, d.id) });
			}
		);

	// Keyed list: existing keys keep their DOM and state, removed keys are
	// destroyed, new keys are created. Items are moved to match list order.
	// An unkeyed list is keyed by index.
	const mountEach = (d: Extract<ProgramNode, { t: 'each' }>, parent: Node, before: Node | null, scope: Scope) => {
		const end = parent.insertBefore(document.createComment('/each'), before);
		const container = newOwner();
		type Item = { item: Cell; index: Cell<number>; start: Node; end: Node; owner: Owner };
		let items = new Map<unknown, Item>();
		within(container, null, () =>
			effect(() => {
				const list = withId(d.id, () => eachList(d.list()));
				untrack(() => {
					const next = new Map<unknown, Item>();
					const order: Item[] = [];
					list.forEach((raw, i) => {
						const key = withId(d.id, () => d.key({ v: raw }, { v: i }));
						if (next.has(key)) throw new Error(`Duplicate each key ${JSON.stringify(key)} (at ${d.id})`);
						let entry = items.get(key);
						if (entry) {
							// Mutation is tracked per state variable, not per object: the
							// same object may have changed in place, so its row re-reads it.
							if (Object.is(entry.item.v, raw)) entry.item.notify();
							else entry.item.v = raw;
							entry.index.v = i;
						} else {
							const o = within(container, null, () => newOwner());
							const item = cell(raw);
							const index = cell(i);
							const start = parent.insertBefore(document.createComment('item'), end);
							const stop = parent.insertBefore(document.createComment('/item'), end);
							within(o, null, () => mountNodes(d.kids(item, index), parent, stop, { ...scope, place: eachPlace(scope.place, key) }));
							entry = { item, index, start, end: stop, owner: o };
						}
						next.set(key, entry);
						order.push(entry);
					});
					for (const [key, entry] of items)
						if (!next.has(key)) {
							dispose(entry.owner);
							removeRange(entry.start, entry.end);
						}
					let cursor: Node = end;
					for (let i = order.length - 1; i >= 0; i--) {
						const entry = order[i];
						if (entry.end.nextSibling !== cursor) moveRange(entry.start, entry.end, cursor);
						cursor = entry.start;
					}
					items = next;
				});
				resizeLater();
			})
		);
	};

	const sheet = document.createElement('style');
	sheet.textContent = BASE_CSS + HOST_FONT_CSS;
	document.head.appendChild(sheet);
	target.setAttribute('data-p', 'frame');
	target.setAttribute('data-dir', 'column');
	target.setAttribute('data-host', '');
	batch(() => within(root, null, () => mountNodes(program(app.api), target, null, { instance: app, place: ROOT_PLACE })));
	// Content sizes measured before a web font loads are re-measured with it.
	document.fonts?.addEventListener('loadingdone', resizeLater);
	return () => {
		document.fonts?.removeEventListener('loadingdone', resizeLater);
		dispose(root);
		anchoring.dispose();
	};
}
