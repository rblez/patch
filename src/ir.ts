// The PAT IR: what a .pat file means, independent of the parser.
//
// `lower.ts` builds it from svelte's AST; every later phase reads only this.
// The template is fully modelled. JS/TS stays ESTree (a stable standard): the
// script keeps its statements and only the top-level declarations PAT gives
// meaning to (runes, imports) are classified.

import type { Estree } from './ast';
import type { Span } from './diagnostics';
import type { PatchExport } from './schema/program';

export type Component = {
	script: Script | null;
	template: TemplateNode[];
};

// ------------------------------------------------------------------ script

export type Script = {
	lang: 'ts' | 'js';
	/** The script's content (between the tags). */
	span: Span;
	/** Every top-level statement, imports included. */
	body: Estree[];
	imports: Estree[];
	/** `let x = $state(...)`. */
	state: StateDecl[];
	/** The names `let { ... } = $props()` declares. */
	props: PropDecl[];
	/** The declarator holding `$props()`. */
	propsDeclarator: Estree | null;
	/** `import { getContext as get } from 'patch'`: local name → imported name. */
	patchImports: { local: string; imported: PatchExport }[];
	/** The names `let x = $derived(...)` / `$derived.by(...)` declares. */
	derived: Estree[];
	/** The `$state`/`$derived`/`$effect`/`$props` calls in a position where PAT accepts them, whatever their shape. */
	runes: Set<Estree>;
};

export type StateDecl = { id: Estree; call: Estree; info: StateInfo };
/** `key: local = fallback` in `let { ... } = $props()`. */
export type PropDecl = { key: string; local: Estree; fallback: Estree | null };

export type StateInfo = {
	/**
	 * Stable id used for design-time overrides: the top-level variable name.
	 * In a component instance it is prefixed with the instance's path.
	 */
	id: string;
};

// ---------------------------------------------------------------- template

export type TemplateNode = Element | Text | If | Each | Portal | ComponentUse | Snippet | Render;

/** The tags PAT supports. */
export type Tag = 'main' | 'div' | 'button' | 'p' | 'span' | 'input' | 'textarea';

type ElementBase = {
	type: 'element';
	tag: Tag;
	span: Span;
	nameSpan: Span;
	/** The `style={...}` expression. */
	style: Estree | null;
	/** Attributes, event handlers and bindings, in source order. */
	attributes: Attribute[];
};
/** <main>, <div>, <button>: containers. */
export type Frame = ElementBase & { kind: 'frame'; children: TemplateNode[] };
/** <p>, <span>: a block of text. */
export type TextElement = ElementBase & { kind: 'text'; content: Inline[] };
export type Input = ElementBase & { kind: 'input' | 'textarea' };
export type Element = Frame | TextElement | Input;

export type Attribute =
	| { type: 'attribute'; name: string; span: Span; nameSpan: Span; value: AttributeValue }
	| { type: 'event'; name: string; span: Span; nameSpan: Span; handler: Estree }
	| { type: 'bind'; name: 'value' | 'this'; span: Span; nameSpan: Span; expression: Estree };

/** `disabled` (true), `value={x}` (an expression), or `title="a {b} c"` (parts). */
export type AttributeValue = true | { expression: Estree } | { parts: (string | Estree)[] };

/** Bare text between elements in a container. */
export type Text = { type: 'text'; span: Span; content: Inline[] };

/**
 * Text content with whitespace already collapsed: static text, `{expr}`, or a
 * nested <span> that may only carry typography.
 */
export type Inline =
	| { type: 'static'; value: string }
	| { type: 'expression'; expression: Estree }
	| { type: 'span'; span: Span; nameSpan: Span; style: Estree | null; content: Inline[] };

export type If = {
	type: 'if';
	span: Span;
	branches: { test: Estree; body: TemplateNode[] }[];
	otherwise: TemplateNode[] | null;
};

export type Each = {
	type: 'each';
	span: Span;
	list: Estree;
	item: Estree;
	/** The index name, as an identifier. */
	index: Estree | null;
	key: Estree | null;
	body: TemplateNode[];
};

/**
 * `<portal id="name" />`: where elements with `portal="name"` render. It
 * renders nothing of its own. Names are app-wide.
 */
export type Portal = { type: 'portal'; span: Span; nameSpan: Span; name: string };

/**
 * `<Card title="x">…</Card>`: an instance of the component `name` holds.
 * Every attribute is a prop; the content is the `children` snippet.
 */
export type ComponentUse = {
	type: 'component';
	span: Span;
	nameSpan: Span;
	/** The tag as an identifier reference. */
	name: Estree;
	props: { name: string; span: Span; nameSpan: Span; value: AttributeValue }[];
	children: TemplateNode[] | null;
};

/** `{#snippet name(a, b)}…{/snippet}`: a render fragment declared in its block. */
export type Snippet = { type: 'snippet'; span: Span; name: Estree; params: Estree[]; body: TemplateNode[] };

/** `{@render name(args)}`, or `{@render name?.(args)}` (`optional`: a nullish snippet renders nothing). */
export type Render = { type: 'render'; span: Span; callee: Estree; args: Estree[]; optional: boolean };

/** The node lists directly below `node` (content that is not its own). */
export function fragments(node: TemplateNode): TemplateNode[][] {
	switch (node.type) {
		case 'element':
			return node.kind === 'frame' ? [node.children] : [];
		case 'if':
			return [...node.branches.map((b) => b.body), ...(node.otherwise ? [node.otherwise] : [])];
		case 'each':
		case 'snippet':
			return [node.body];
		case 'component':
			return node.children ? [node.children] : [];
	}
	return [];
}

/** Every element and inline <span> in a template, depth first. */
export function* elements(nodes: TemplateNode[]): Generator<Element | Extract<Inline, { type: 'span' }>> {
	for (const node of nodes) {
		if (node.type === 'element') {
			yield node;
			if (node.kind === 'text') yield* spans(node.content);
		} else if (node.type === 'text') yield* spans(node.content);
		for (const fragment of fragments(node)) yield* elements(fragment);
	}
}

function* spans(content: Inline[]): Generator<Extract<Inline, { type: 'span' }>> {
	for (const part of content)
		if (part.type === 'span') {
			yield part;
			yield* spans(part.content);
		}
}

const valueExpressions = (value: AttributeValue): Estree[] =>
	value === true ? [] : 'expression' in value ? [value.expression] : value.parts.filter((p) => typeof p !== 'string');

/** Every JS expression in a template (tests, lists, keys, styles, attributes, props, text). */
export function* expressions(nodes: TemplateNode[]): Generator<Estree> {
	function* inline(content: Inline[]): Generator<Estree> {
		for (const part of content) {
			if (part.type === 'expression') yield part.expression;
			else if (part.type === 'span') {
				if (part.style) yield part.style;
				yield* inline(part.content);
			}
		}
	}
	for (const node of nodes) {
		if (node.type === 'text') yield* inline(node.content);
		else if (node.type === 'element') {
			if (node.style) yield node.style;
			for (const a of node.attributes) {
				if (a.type === 'event') yield a.handler;
				else if (a.type === 'bind') yield a.expression;
				else yield* valueExpressions(a.value);
			}
			if (node.kind === 'text') yield* inline(node.content);
		} else if (node.type === 'if') yield* node.branches.map((b) => b.test);
		else if (node.type === 'each') {
			yield node.list;
			if (node.key) yield node.key;
		} else if (node.type === 'component') {
			yield node.name;
			for (const p of node.props) yield* valueExpressions(p.value);
		} else if (node.type === 'render') yield* [node.callee, ...node.args];
		for (const fragment of fragments(node)) yield* expressions(fragment);
	}
}
