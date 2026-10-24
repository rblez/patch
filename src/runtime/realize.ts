// Design-time evaluation: run a program once (no effects) with optional state
// overrides and evaluate its template into a concrete tree.
//
// The tree is the rendered tree: an element with `portal="name"` appears
// where `<portal id="name" />` is, and inherits typography from there, as in
// the browser. Its getters still run in the scope of where it is declared.
//
// `bind:this` variables hold a design-time stand-in for their element (there
// is no DOM). The template is evaluated twice, so an expression reading one
// sees the element it ends up holding even when that element comes later in
// the document, as it does in the browser once everything is mounted. Both
// evaluations share the component instances (by path), so their scripts run
// once and their state is the one the stand-ins were written into.
//
// Concrete ids are node ids (see schema/path.ts): `Row@12:3["a"]/4:5[0]`, or
// `4:5[0]` in the app itself.

import { DESIGN_NODE, isDesignNode, type DesignNode } from '../schema/anchor';
import type { Concrete, Font, Run } from '../schema/concrete';
import type { ElementNode, Getter, InlinePart, Program, ProgramNode } from '../schema/program';
import { inheritFont, ROOT_FONT } from '../schema/style';
import { createApi, type Instance } from './api';
import { eachPlace, instancePlace, nodeId, renderPlace, ROOT_PLACE, type Place } from '../schema/path';
import { componentOf, eachList, elementStyle, portalName, renderable, toText, withId } from './evaluate';
import { createReactive } from './reactive';

function inlineRuns(parts: InlinePart[], font: Font, runs: Run[], scope: string): Run[] {
	for (const part of parts) {
		if (typeof part === 'string') runs.push({ text: part, font });
		else if (typeof part === 'function') runs.push({ text: toText(withId(scope, part)), font });
		else inlineRuns(part.kids, inheritFont(font, elementStyle(part, 'inline')), runs, part.id);
	}
	return runs;
}

/** Where a `<portal>`'s content goes in the tree until it is filled in. */
type Slot = { type: 'slot'; name: string };
/** An element rendered into a portal: realized once its portal's font is known. */
type Portaled = { name: string; at: string; render: (font: Font) => Concrete; done?: Concrete };

/** What evaluated content belongs to: the component instance rendering it, and where it is. */
type Scope = { instance: Instance; place: Place };
type Instances = Map<string, { component: unknown; instance: Instance; nodes: ProgramNode[] }>;
type MakeInstance = (parent: Instance, path: string, props: Record<string, Getter>) => Instance;

class Realizer {
	/** Stand-ins per element and instances per path, by concrete id, shared by both evaluations. */
	constructor(
		private handles: Map<string, DesignNode>,
		private instances: Instances,
		private makeInstance: MakeInstance
	) {}

	private portals = new Map<string, { at: string; font: Font }>();
	private portaled: Portaled[] = [];

	nodes(nodes: ProgramNode[], scope: Scope, font: Font): Concrete[] {
		const out: Concrete[] = [];
		for (const d of nodes) {
			const id = nodeId(scope.place, d.id);
			if (d.t === 'text') {
				out.push({ type: 'text', id, tag: null, style: {}, font, runs: inlineRuns(d.parts, font, [], d.id) });
			} else if (d.t === 'el') {
				const name = d.portal ? withId(d.id, () => portalName(d.portal!())) : null;
				if (name === null) out.push(this.element(d, id, scope, font));
				else this.portaled.push({ name, at: d.id, render: (font) => this.element(d, id, scope, font) });
			} else if (d.t === 'portal') {
				const existing = this.portals.get(d.name);
				if (existing) throw new Error(`Duplicate <portal id="${d.name}"> (at ${existing.at} and ${d.id})`);
				this.portals.set(d.name, { at: d.id, font });
				const slot: Slot = { type: 'slot', name: d.name };
				out.push(slot as unknown as Concrete);
			} else if (d.t === 'if') {
				const branch = withId(d.id, () => d.b.find(([test]) => test()));
				out.push(...this.nodes(branch ? branch[1] : (d.e ?? []), scope, font));
			} else if (d.t === 'each') {
				const list = withId(d.id, () => eachList(d.list()));
				const seen = new Set();
				list.forEach((raw, i) => {
					const key = withId(d.id, () => d.key({ v: raw }, { v: i }));
					if (seen.has(key)) throw new Error(`Duplicate each key ${JSON.stringify(key)} (at ${d.id})`);
					seen.add(key);
					out.push(...this.nodes(d.kids({ v: raw }, { v: i }), { ...scope, place: eachPlace(scope.place, key) }, font));
				});
			} else if (d.t === 'component') {
				const component = withId(d.id, () => componentOf(d.component(), d.tag, d.id)) as Program;
				const place = instancePlace(scope.place, d.tag, d.id);
				let entry = this.instances.get(place.path);
				if (entry?.component !== component) {
					const props = Object.fromEntries(Object.entries(d.props).map(([name, get]) => [name, () => withId(d.id, get)]));
					const instance = this.makeInstance(scope.instance, place.path, props);
					this.instances.set(place.path, (entry = { component, instance, nodes: withId(d.id, () => component(instance.api)) }));
				}
				out.push(...this.nodes(entry.nodes, { instance: entry.instance, place }, font));
			} else if (d.t === 'render') {
				const fn = withId(d.id, () => renderable(d.snippet(), d.optional, d.id));
				if (fn) {
					const args = d.args.map((arg) => ({ get v() { return withId(d.id, arg); } }));
					out.push(...this.nodes(fn(...args), { instance: scope.instance, place: renderPlace(scope.place, d.id) }, font));
				}
			}
		}
		return out;
	}

	private element(d: ElementNode, id: string, scope: Scope, font: Font): Concrete {
		const st = elementStyle(d, d.kind);
		const own = inheritFont(font, st);
		// A stand-in for an element holds its concrete id; anything else anchors to nothing.
		const { anchor, ...style } = st;
		const styled = { style, ...(anchor === undefined ? {} : { anchor: isDesignNode(anchor) ? anchor[DESIGN_NODE] : null }) };
		const attr = (name: string) => (d.attrs[name] ? toText(withId(d.id, d.attrs[name])) : '');
		if (d.ref) {
			let handle = this.handles.get(id);
			if (!handle) this.handles.set(id, (handle = Object.freeze({ [DESIGN_NODE]: id })));
			d.ref.set(handle);
		}
		if (d.kind === 'frame') return { type: 'frame', id, tag: d.tag, ...styled, font: own, children: this.nodes(d.kids, scope, own) };
		if (d.kind === 'text') return { type: 'text', id, tag: d.tag, ...styled, font: own, runs: inlineRuns(d.kids, own, [], d.id) };
		return {
			type: 'input',
			id,
			tag: d.kind,
			...styled,
			font: own,
			value: attr('value'),
			placeholder: attr('placeholder'),
			inputType: attr('type') || 'text'
		};
	}

	/**
	 * Realizes portaled elements with their portal's font (a portal may itself
	 * be inside portaled content), then puts them in place of their portal,
	 * in the order they were declared.
	 */
	finish(tree: Concrete[]): Concrete[] {
		for (let progress = true; progress; ) {
			progress = false;
			for (const p of this.portaled) {
				const portal = this.portals.get(p.name);
				if (p.done || !portal) continue;
				p.done = p.render(portal.font);
				progress = true;
			}
		}
		const missing = this.portaled.find((p) => !p.done);
		if (missing) throw new Error(`No <portal id="${missing.name}"> is rendered (portal="${missing.name}" at ${missing.at})`);
		const fill = (nodes: Concrete[], within: string[]): Concrete[] =>
			nodes.flatMap((n) => {
				const slot = n as unknown as Slot | Concrete;
				if (slot.type === 'slot') {
					if (within.includes(slot.name)) throw new Error(`<portal id="${slot.name}"> is inside an element rendered into it (at ${this.portals.get(slot.name)!.at})`);
					return fill(this.portaled.filter((p) => p.name === slot.name).map((p) => p.done!), [...within, slot.name]);
				}
				if (slot.type === 'frame') slot.children = fill(slot.children, within);
				return [slot];
			});
		return fill(tree, []);
	}
}

/** An anchor that is not rendered is no anchor: null. */
function resolveAnchors(tree: Concrete[]) {
	const ids = new Set<string>();
	const anchored: Concrete[] = [];
	const walk = (nodes: Concrete[]) => {
		for (const n of nodes) {
			ids.add(n.id);
			if (n.anchor) anchored.push(n);
			if (n.type === 'frame') walk(n.children);
		}
	};
	walk(tree);
	for (const n of anchored) if (!ids.has(n.anchor!)) n.anchor = null;
}

/** Runs the program without effects and evaluates its template (twice, for `bind:this`; see above). */
export function realize(program: Program, overrides: Record<string, unknown> = {}): Concrete[] {
	const { root, instance } = createApi(createReactive(), { overrides, design: true });
	const nodes = program(root.api);
	const handles = new Map<string, DesignNode>();
	const instances: Instances = new Map();
	const evaluate = () => {
		const realizer = new Realizer(handles, instances, instance);
		return realizer.finish(realizer.nodes(nodes, { instance: root, place: ROOT_PLACE }, ROOT_FONT));
	};
	evaluate();
	const tree = evaluate();
	resolveAnchors(tree);
	return tree;
}
