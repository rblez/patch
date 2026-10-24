// Svelte AST → PAT IR.
//
// Lowering reports everything the IR cannot express: unsupported tags,
// blocks, directives and attributes, CSS strings, malformed rune
// declarations. It then drops the construct and carries on with its siblings
// (and, for an unsupported container, its children), so later phases only
// ever see valid PAT and one pass surfaces as many problems as possible.

import { unwrap, type Estree } from './ast';
import type { Reporter, Span } from './diagnostics';
import type { Attribute, AttributeValue, Component, ComponentUse, Each, Element, If, Inline, Render, Script, Snippet, Tag, TemplateNode } from './ir';
import type { SvelteAst } from './parse';
import { PATCH_EXPORTS } from './schema/program';

type Svelte = any;

const KINDS: Record<Tag, Element['kind']> = {
	main: 'frame',
	div: 'frame',
	button: 'frame',
	p: 'text',
	span: 'text',
	input: 'input',
	textarea: 'textarea'
};
/** Attributes every element accepts (not an inline <span>). */
const UNIVERSAL_ATTRIBUTES = ['portal'];
/** Attributes (other than style= and on*=) each tag accepts. */
const ATTRIBUTES: Partial<Record<Tag, string[]>> = {
	button: ['disabled'],
	input: ['value', 'placeholder', 'disabled', 'type'],
	textarea: ['value', 'placeholder', 'disabled']
};
const UNSUPPORTED_NODES: Record<string, string> = {
	HtmlTag: '{@html} is not supported',
	AwaitBlock: '{#await} is not supported in v0; use $state + $effect for async data',
	KeyBlock: '{#key} is not supported',
	ConstTag: '{@const} is not supported',
	DebugTag: '{@debug} is not supported',
	AttachTag: '{@attach} is not supported'
};
const UNSUPPORTED_DIRECTIVES: Record<string, string> = {
	SpreadAttribute: 'spread attributes are not supported',
	ClassDirective: 'class: is not supported; use style={[base, active && selected]}',
	StyleDirective: 'style: directives are not supported; use style={{ ... }}',
	OnDirective: 'on:event is not supported; use onevent={...}',
	UseDirective: 'use: actions are not supported',
	TransitionDirective: 'transitions are not supported in v0',
	AnimateDirective: 'animations are not supported in v0',
	AttachTag: '{@attach} is not supported'
};
const isTag = (name: string): name is Tag => name in KINDS;

/** A node's name when it has one (elements, attributes), else the node. */
const nameSpan = (node: Svelte): Span =>
	node.name_loc ? { start: node.name_loc.start.character, end: node.name_loc.end.character } : { start: node.start, end: node.end };
const spanOf = (node: Svelte): Span => ({ start: node.start, end: node.end });

export function lower(ast: SvelteAst, source: string, reporter: Reporter): Component {
	const a = ast as Svelte;
	if (a.css) reporter.report(a.css, '<style> is not supported; use style={...} with $style({...}) values');
	if (a.module) reporter.report(a.module, '<script module> is not supported in v0');
	if (a.options) reporter.report(a.options, '<svelte:options> is not supported');
	return {
		script: a.instance ? lowerScript(a.instance, reporter) : null,
		template: new TemplateLowering(source, reporter).children(a.fragment.nodes)
	};
}

// ------------------------------------------------------------------ script

/** `$state`, `$derived`, `$derived.by`, … for a rune callee, else null. */
const calleeName = (callee: Estree): string | null => {
	if (callee.type === 'Identifier') return callee.name;
	if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier')
		return `${callee.object.name}.${callee.property.name}`;
	return null;
};

function lowerScript(instance: Svelte, reporter: Reporter): Script {
	const program = instance.content;
	const lang = instance.attributes.find((a: Svelte) => a.name === 'lang')?.value?.[0]?.data === 'ts' ? 'ts' : 'js';
	const script: Script = {
		lang,
		span: { start: program.start, end: program.end },
		body: program.body,
		imports: [],
		state: [],
		derived: [],
		props: [],
		propsDeclarator: null,
		patchImports: [],
		runes: new Set()
	};

	for (const statement of program.body) {
		if (statement.type === 'ImportDeclaration') {
			const from = statement.source.value;
			if (/\.(css|scss|sass|less|styl|stylus|pcss|postcss|sss)($|\?)/.test(from))
				reporter.report(statement.source, 'stylesheets are not supported; use style={...} with $style({...}) values');
			else if (/\.pat($|\?)/.test(from)) {
				const [first, ...rest] = statement.specifiers;
				if (statement.importKind === 'type' || first?.type !== 'ImportDefaultSpecifier' || rest.length)
					reporter.report(statement, 'a .pat file is imported as one component: import Card from "./Card.pat"');
			} else if (from === 'patch') {
				if (statement.importKind === 'type') continue;
				for (const sp of statement.specifiers) {
					if (sp.importKind === 'type') continue;
					const name = sp.type === 'ImportSpecifier' ? (sp.imported.name ?? sp.imported.value) : null;
					const imported = PATCH_EXPORTS.find((e) => e === name);
					if (imported) script.patchImports.push({ local: sp.local.name, imported });
					else reporter.report(sp, `"patch" provides ${PATCH_EXPORTS.join(', ')} (and the type Context)`);
				}
			}
			// Vite only converts CommonJS for npm dependencies, not local files.
			else if (/^\.{0,2}\/.*\.c[jt]s$/.test(from))
				reporter.report(statement.source, 'local CommonJS modules are not supported; use an ES module (.ts, .js, .mjs). CommonJS npm packages are fine');
			script.imports.push(statement);
		} else if (statement.type === 'TSImportEqualsDeclaration') {
			reporter.report(statement, '`import x = require(...)` is not supported; use an ES import');
		} else if (/^(Export|TSExport)/.test(statement.type)) {
			reporter.report(statement, 'a .pat file cannot export anything; it is a component, and takes its inputs from $props()');
		} else if (statement.type === 'VariableDeclaration') {
			for (const d of statement.declarations) {
				const init = unwrap(d.init);
				const rune = init?.type === 'CallExpression' ? calleeName(init.callee) : null;
				if (rune === '$props') {
					script.runes.add(init);
					lowerProps(d, script, reporter);
				} else if (rune === '$state' || rune === '$derived' || rune === '$derived.by') {
					script.runes.add(init);
					runeArguments(rune, init, reporter);
					if (rune === '$state' && statement.kind !== 'let') reporter.report(statement, '$state must be declared with let');
					if (d.id.type !== 'Identifier') {
						reporter.report(d.id, `${rune} must be assigned to a plain identifier`);
						continue;
					}
					if (rune !== '$state') script.derived.push(d.id);
					else script.state.push({ id: d.id, call: init, info: { id: d.id.name } });
				}
			}
		} else if (statement.type === 'ExpressionStatement') {
			const call = unwrap(statement.expression);
			if (call.type === 'CallExpression' && calleeName(call.callee) === '$effect') {
				script.runes.add(call);
				runeArguments('$effect', call, reporter);
			}
		}
	}
	return script;
}

/** `$state` takes at most one initial value; `$derived`, `$derived.by` and `$effect` take exactly one argument. */
function runeArguments(rune: string, call: Estree, reporter: Reporter) {
	const count = call.arguments.length;
	if (rune === '$state') {
		if (count > 1) reporter.report(call, '$state takes at most one initial value');
	} else if (count !== 1) reporter.report(call, rune === '$derived' ? '$derived takes exactly one expression' : `${rune} takes exactly one function`);
}

/** `let { a, b: local, c = fallback }: Props = $props()`. */
function lowerProps(d: Estree, script: Script, reporter: Reporter) {
	if (script.propsDeclarator) return reporter.report(d, '$props() can only be declared once');
	script.propsDeclarator = d;
	if (d.id.type !== 'ObjectPattern') return reporter.report(d.id, 'destructure the props: let { name, count = 0 } = $props()');
	if (d.init.arguments.length) reporter.report(d.init, '$props() takes no arguments');
	for (const p of d.id.properties) {
		const value = p.type === 'Property' ? p.value : null;
		const local = value?.type === 'AssignmentPattern' ? value.left : value;
		if (p.type !== 'Property' || p.computed || local?.type !== 'Identifier') {
			reporter.report(p, p.type === 'RestElement' ? 'rest props are not supported; name each prop' : 'each prop must be a name, optionally renamed or with a default: { a, b: c, d = 1 }');
			continue;
		}
		script.props.push({ key: p.key.name ?? String(p.key.value), local, fallback: value.type === 'AssignmentPattern' ? value.right : null });
	}
}

// ---------------------------------------------------------------- template

class TemplateLowering {
	constructor(
		private source: string,
		private reporter: Reporter
	) {}

	private unsupported(node: Svelte) {
		this.reporter.report(nameSpan(node), UNSUPPORTED_NODES[node.type] ?? `<${node.name ?? node.type}> is not supported`);
	}

	/** The children of a container. Runs of text and `{expr}` become one Text node. */
	children(nodes: Svelte[]): TemplateNode[] {
		const out: TemplateNode[] = [];
		let group: Svelte[] = [];
		const flush = () => {
			const content = this.inline(group);
			if (content.length) out.push({ type: 'text', span: { start: group[0].start, end: group[group.length - 1].end }, content });
			group = [];
		};
		for (const node of nodes) {
			if (node.type === 'Text' || node.type === 'ExpressionTag') {
				group.push(node);
				continue;
			}
			if (node.type === 'Comment') continue;
			flush();
			if (node.type === 'RegularElement') out.push(...this.element(node));
			else if (node.type === 'Component') out.push(...this.component(node));
			else if (node.type === 'SnippetBlock') out.push(...this.snippet(node));
			else if (node.type === 'RenderTag') out.push(...this.render(node));
			else if (node.type === 'IfBlock') out.push(this.ifBlock(node));
			else if (node.type === 'EachBlock') out.push(...this.eachBlock(node));
			else this.unsupported(node);
		}
		flush();
		return out;
	}

	private ifBlock(node: Svelte): If {
		const result: If = { type: 'if', span: spanOf(node), branches: [], otherwise: null };
		for (let current = node; current; ) {
			result.branches.push({ test: current.test, body: this.children(current.consequent.nodes) });
			const alternate = current.alternate?.nodes ?? [];
			const elseIf = alternate.find((n: Svelte) => n.type === 'IfBlock' && n.elseif);
			if (elseIf) current = elseIf;
			else {
				if (current.alternate) result.otherwise = this.children(alternate);
				current = null;
			}
		}
		return result;
	}

	private eachBlock(node: Svelte): Each[] {
		if (node.fallback) this.reporter.report(nameSpan(node.fallback.nodes[0] ?? node), '{:else} inside {#each} is not supported; use {#if list.length === 0}');
		const body = this.children(node.body.nodes);
		if (!node.context || node.context.type !== 'Identifier') {
			this.reporter.report(node, '{#each} needs `as item` with a plain identifier');
			return [];
		}
		// svelte gives the index as a bare name; it follows the item and its type annotation.
		const at = node.index ? this.source.indexOf(node.index, (node.context.typeAnnotation ?? node.context).end) : -1;
		const index = node.index ? { type: 'Identifier', name: node.index, start: at, end: at + node.index.length } : null;
		return [{ type: 'each', span: spanOf(node), list: node.expression, item: node.context, index, key: node.key ?? null, body }];
	}

	/** `<Card a={x}>content</Card>`: attributes are props, the content is the `children` snippet. */
	private component(node: Svelte): TemplateNode[] {
		const children = this.children(node.fragment.nodes);
		if (node.name.includes('.')) {
			this.reporter.report(nameSpan(node), `<${node.name}>: a component tag must be a plain name; assign it first (const Item = ${node.name})`);
			return children;
		}
		const props: ComponentUse['props'] = [];
		for (const a of node.attributes) {
			if (a.type === 'Attribute') props.push({ name: a.name, span: spanOf(a), nameSpan: nameSpan(a), value: attributeValue(a) });
			else if (a.type === 'BindDirective')
				this.reporter.report(nameSpan(a), `components have no bind:; pass the value and a callback that changes it: ${a.name}={x} on${a.name}={(next) => (x = next)}`);
			else this.reporter.report(nameSpan(a), UNSUPPORTED_DIRECTIVES[a.type] ?? `${a.type} is not supported on a component`);
		}
		for (const child of children)
			if (child.type === 'snippet')
				this.reporter.report(child.name, `a snippet declared inside <${node.name}> is not passed to it; declare it outside and pass it as a prop: ${child.name.name}={${child.name.name}}`);
		const explicit = props.find((p) => p.name === 'children');
		if (explicit && children.length) this.reporter.report(explicit.nameSpan, 'children is given both as a prop and as content');
		const loc = nameSpan(node);
		const name = { type: 'Identifier', name: node.name, start: loc.start, end: loc.end };
		return [{ type: 'component', span: spanOf(node), nameSpan: loc, name, props, children: children.length ? children : null }];
	}

	private snippet(node: Svelte): Snippet[] {
		const body = this.children(node.body.nodes);
		const params = node.parameters.filter((p: Estree) => {
			if (unwrap(p)?.type === 'Identifier') return true;
			this.reporter.report(p, 'snippet parameters must be plain names');
			return false;
		});
		return [{ type: 'snippet', span: spanOf(node), name: node.expression, params: params.map(unwrap), body }];
	}

	private render(node: Svelte): Render[] {
		const chain = node.expression.type === 'ChainExpression';
		const call = chain ? node.expression.expression : node.expression;
		if (call.arguments.some((a: Estree) => a.type === 'SpreadElement')) {
			this.reporter.report(node, '{@render} arguments cannot be spread');
			return [];
		}
		return [{ type: 'render', span: spanOf(node), callee: call.callee, args: call.arguments, optional: chain && call.optional }];
	}

	/** One element, or (for an unsupported tag) its lowered children so their problems are reported too. */
	private element(node: Svelte): TemplateNode[] {
		const tag = node.name;
		if (tag === 'portal') return this.portal(node);
		if (!isTag(tag)) {
			this.reporter.report(nameSpan(node), `<${tag}> is not supported (use main, div, button, p, span, input, textarea)`);
			return this.children(node.fragment.nodes);
		}
		const kind = KINDS[tag];
		const { style, attributes } = this.attributes(node, kind);
		const base = { type: 'element' as const, tag, span: spanOf(node), nameSpan: nameSpan(node), style, attributes };
		const nodes = node.fragment.nodes;
		if (kind === 'frame') return [{ ...base, kind, children: this.children(nodes) }];
		if (kind === 'text') return [{ ...base, kind, content: this.inline(nodes) }];
		if (nodes.some((n: Svelte) => n.type !== 'Text' || n.data.trim()))
			this.reporter.report(nameSpan(node), `<${tag}> cannot have children; use value={...}`);
		return [{ ...base, kind }];
	}

	/** `<portal id="name" />`: only a static, non-empty id. */
	private portal(node: Svelte): TemplateNode[] {
		const needsId = '<portal> needs a static id: <portal id="name" />';
		let name: string | null = null;
		let id: Svelte = null;
		for (const a of node.attributes) {
			if (a.type === 'Attribute' && a.name === 'id') {
				id = a;
				const value = Array.isArray(a.value) && a.value.length === 1 && a.value[0].type === 'Text' ? a.value[0].data : '';
				if (value) name = value;
				else this.reporter.report(nameSpan(a), needsId);
			} else {
				const what = a.type === 'Attribute' ? `attribute "${a.name}"` : (UNSUPPORTED_DIRECTIVES[a.type] ?? a.type);
				this.reporter.report(nameSpan(a), `${what} is not supported on <portal>; it only takes id="..."`);
			}
		}
		if (!id) this.reporter.report(nameSpan(node), needsId);
		if (node.fragment.nodes.some((n: Svelte) => n.type !== 'Text' || n.data.trim()))
			this.reporter.report(nameSpan(node), '<portal> cannot have children; elements render into it with portal="..."');
		return name === null ? [] : [{ type: 'portal', span: spanOf(node), nameSpan: nameSpan(node), name }];
	}

	/** `kind` is null for a <span> nested in text, which only takes style=. */
	private attributes(node: Svelte, kind: Element['kind'] | null) {
		let style: Estree | null = null;
		const attributes: Attribute[] = [];
		const inText = kind === null;
		const where = `<${node.name}>${inText ? ' inside text' : ''}`;
		const expressionOf = (a: Svelte): Estree | null => {
			if (a.value !== true && !Array.isArray(a.value)) return a.value.expression;
			this.reporter.report(nameSpan(a), `${a.name} needs an expression: ${a.name}={...}`);
			return null;
		};
		for (const a of node.attributes) {
			const span = spanOf(a);
			if (a.type === 'BindDirective') {
				if (a.name === 'this' ? inText : a.name !== 'value' || (kind !== 'input' && kind !== 'textarea'))
					this.reporter.report(nameSpan(a), inText ? `bind:${a.name} is not supported on ${where}` : 'only bind:value on <input>/<textarea> and bind:this are supported');
				else attributes.push({ type: 'bind', name: a.name, span, nameSpan: nameSpan(a), expression: a.expression });
			} else if (a.type !== 'Attribute') {
				this.reporter.report(nameSpan(a), UNSUPPORTED_DIRECTIVES[a.type] ?? `${a.type} is not supported`);
			} else if (a.name === 'style') {
				if (Array.isArray(a.value) && a.value.some((part: Svelte) => part.type === 'Text'))
					this.reporter.report(nameSpan(a), 'CSS strings are not supported; use style={$style({...})} or style={{ ... }}');
				else style = expressionOf(a);
			} else if (a.name === 'class') {
				this.reporter.report(nameSpan(a), 'class= is not supported; use style={...}');
			} else if (/^on[a-z]+$/.test(a.name) && !inText) {
				const handler = expressionOf(a);
				if (handler) attributes.push({ type: 'event', name: a.name.slice(2), span, nameSpan: nameSpan(a), handler });
			} else if (!inText && (UNIVERSAL_ATTRIBUTES.includes(a.name) || ATTRIBUTES[node.name as Tag]?.includes(a.name))) {
				attributes.push({ type: 'attribute', name: a.name, span, nameSpan: nameSpan(a), value: attributeValue(a) });
			} else {
				this.reporter.report(nameSpan(a), `attribute "${a.name}" is not supported on ${where}`);
			}
		}
		return { style, attributes };
	}

	/**
	 * Text content. Static whitespace collapses to one space and is trimmed at
	 * the edges (across nested spans); expression values are kept verbatim.
	 */
	private inline(nodes: Svelte[]): Inline[] {
		const content = this.inlineParts(nodes, { space: true });
		const trimEnd = (list: Inline[]) => {
			const last = list[list.length - 1];
			if (last?.type === 'static') {
				const trimmed = last.value.trimEnd();
				if (trimmed) last.value = trimmed;
				else list.pop();
			} else if (last?.type === 'span') trimEnd(last.content);
		};
		trimEnd(content);
		return content;
	}

	private inlineParts(nodes: Svelte[], state: { space: boolean }): Inline[] {
		const out: Inline[] = [];
		for (const node of nodes) {
			if (node.type === 'Comment') continue;
			if (node.type === 'Text') {
				let text = node.data.replace(/\s+/g, ' ');
				if (state.space && text.startsWith(' ')) text = text.slice(1);
				if (!text) continue;
				out.push({ type: 'static', value: text });
				state.space = text.endsWith(' ');
			} else if (node.type === 'ExpressionTag') {
				out.push({ type: 'expression', expression: node.expression });
				state.space = false;
			} else if (node.type === 'RegularElement') {
				if (node.name !== 'span') {
					this.reporter.report(nameSpan(node), `<${node.name}> cannot appear inside text; only <span> can`);
					out.push(...this.inlineParts(node.fragment.nodes, state));
					continue;
				}
				const { style } = this.attributes(node, null);
				out.push({ type: 'span', span: spanOf(node), nameSpan: nameSpan(node), style, content: this.inlineParts(node.fragment.nodes, state) });
			} else if (node.type === 'IfBlock' || node.type === 'EachBlock' || node.type === 'SnippetBlock' || node.type === 'RenderTag') {
				this.reporter.report(node, 'blocks cannot appear inside text; use a ternary {cond ? "a" : "b"} or move the block into a <div>');
			} else if (node.type === 'Component') {
				this.reporter.report(nameSpan(node), 'components cannot appear inside text; move it into a <div>');
			} else this.unsupported(node);
		}
		return out;
	}
}

function attributeValue(a: Svelte): AttributeValue {
	if (a.value === true) return true;
	if (!Array.isArray(a.value)) return { expression: a.value.expression };
	return { parts: a.value.map((part: Svelte) => (part.type === 'Text' ? part.data : part.expression)) };
}
