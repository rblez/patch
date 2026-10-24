// The compiled program: what `emit/` generates and what `runtime/` executes.
//
// A compiled module default-exports a `Program`: the component. Called with
// the runtime API of one instance (`$$rt`), it runs the script and returns a
// static description of the template whose dynamic parts are closures. Ids
// are `line:column` of the construct in the .pat source.

import type { Style } from './style';

/** A value read reactively. */
export type Getter<T = unknown> = () => T;

/** A reactive value; `{#each}` items and indexes are passed to templates as cells. */
export type Cell<T = unknown> = { readonly v: T };

/** `$$rt`: what compiled scripts call. Each component instance has its own. */
export type RuntimeApi = {
	/** `initial` computes the initial value; it is not called when the state is overridden. */
	state: (id: string, initial?: () => unknown) => { v: unknown };
	derived: <T>(fn: () => T) => Cell<T>;
	effect: (fn: () => unknown) => void;
	style: (input: unknown) => Style;
	mutate: <T>(target: { v: unknown }, result: T) => T;
	/** A prop of `$props()`: the value the parent passes, or `fallback()` when that is undefined. */
	prop: (name: string, fallback?: () => unknown) => Cell;
	/** Marks a function as a snippet: `{@render}` only renders these. */
	snippet: <F extends (...args: Cell[]) => ProgramNode[]>(fn: F) => F;
	createContext: () => object;
	setContext: (key: object, value: unknown) => void;
	getContext: (key: object) => unknown;
};

/** The runes, and the `$$rt` function each compiles to. */
export const RUNES = {
	$state: 'state',
	$derived: 'derived',
	'$derived.by': 'derived',
	$effect: 'effect',
	$style: 'style',
	$props: 'prop'
} as const satisfies Record<string, keyof RuntimeApi>;
export type Rune = keyof typeof RUNES;

/** What `import { … } from 'patch'` provides in a .pat script: the `$$rt` function of the same name. */
export const PATCH_EXPORTS = ['createContext', 'setContext', 'getContext'] as const satisfies readonly (keyof RuntimeApi)[];
export type PatchExport = (typeof PATCH_EXPORTS)[number];

export type Program = (rt: RuntimeApi) => ProgramNode[];

export type ProgramNode = TextNode | ElementNode | IfNode | EachNode | PortalNode | ComponentNode | RenderNode;

/** A piece of text content: static text, an expression, or a nested <span>. */
export type InlinePart = string | Getter | SpanNode;

/** Bare text between elements in a container. */
export type TextNode = { t: 'text'; id: string; parts: InlinePart[] };

export type SpanNode = { t: 'span'; id: string; style: Getter | null; kids: InlinePart[] };

type ElementBase = {
	t: 'el';
	tag: string;
	id: string;
	style: Getter | null;
	/** Attribute name → value getter. */
	attrs: Record<string, Getter>;
	/** Event name (without `on`) → getter returning the handler. */
	on: Record<string, Getter>;
	/** `bind:this`: reads and writes the bound variable. It holds the element while mounted, else `undefined`. */
	ref: { get: Getter; set: (node: unknown) => void } | null;
	/** `portal="name"`: the portal it renders into; a nullish or `false` value renders it in place. */
	portal: Getter | null;
};
export type FrameElement = ElementBase & { kind: 'frame'; kids: ProgramNode[] };
export type TextElement = ElementBase & { kind: 'text'; kids: InlinePart[] };
export type InputElement = ElementBase & { kind: 'input' | 'textarea'; kids: [] };
export type ElementNode = FrameElement | TextElement | InputElement;

/** `{#if}`: the first branch whose test is truthy, else `e`. */
export type IfNode = { t: 'if'; id: string; b: [test: Getter, kids: ProgramNode[]][]; e: ProgramNode[] | null };

/** `{#each}`. Unkeyed lists are keyed by index. */
export type EachNode = {
	t: 'each';
	id: string;
	list: Getter;
	key: (item: Cell, index: Cell<number>) => unknown;
	kids: (item: Cell, index: Cell<number>) => ProgramNode[];
};

/** `<portal id="name" />`: where elements with `portal="name"` render, in no element of its own. */
export type PortalNode = { t: 'portal'; id: string; name: string };

/**
 * `<Tag …>`: an instance of the component `component` returns. A different
 * component replaces the instance; a prop changing does not. `props` are the
 * parent's getters, `children` among them.
 */
export type ComponentNode = { t: 'component'; id: string; tag: string; component: Getter; props: Record<string, Getter> };

/** `{@render snippet(args)}`: a different snippet replaces the content; changed arguments update it. */
export type RenderNode = { t: 'render'; id: string; snippet: Getter; args: Getter[]; optional: boolean };
