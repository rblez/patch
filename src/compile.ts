// The compiler pipeline:
//
//   source ─ parse ─ lower ─► IR ─ bind ─► bindings ─┬─ check (script, template, styles) + typecheck ─► diagnostics
//                                                    └─ emit (only without errors) ─► ES module
//
// The compiled module keeps the script's imports at the top and
// default-exports `program($$rt)` (see schema/program.ts).

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { bind, isSignal, type Bindings } from './bind';
import { checkNames } from './check/names';
import { checkScript } from './check/script';
import { checkAnchorReferences, checkStyles } from './check/styles';
import { checkTemplate, checkTemplateNames } from './check/template';
import { CompileError, Reporter, type Diagnostic } from './diagnostics';
import { Edits } from './emit/edits';
import { emitScript } from './emit/script';
import { TemplateEmitter } from './emit/template';
import { elements, fragments, type Component, type StateInfo, type Tag, type TemplateNode } from './ir';
import { lower } from './lower';
import { parse } from './parse';
import { location } from './schema/path';
import { collectStyles, type Styles } from './styles';
import { globalNames, typecheck, type TemplateWrite } from './typecheck';

export type Compiled = {
	/** Absolute path of the .pat file; the script's relative imports resolve from it. */
	path: string;
	/** ES module source: the script's imports, then `export default function program($$rt) { ... }`. */
	module: string;
	/** Specifiers the module still imports after type-only imports are removed. */
	imports: string[];
	state: StateInfo[];
	/** Where the template renders imported components (see `componentSites`). */
	components: ComponentSite[];
	/** The .pat source and the script's offsets in it, for checking design-time state values. */
	script: { lang: 'ts' | 'js'; source: string; start: number; end: number } | null;
};

/**
 * `<Tag>` at `id` (`line:column`) renders the component imported from
 * `path`. `repeated`: inside an `{#each}` of this file, so its instances'
 * paths carry each keys.
 */
export type ComponentSite = { tag: string; id: string; path: string; repeated: boolean };

export type Analysis = { diagnostics: Diagnostic[] };

type Front = { component: Component; bindings: Bindings; styles: Styles };

/** parse → lower → bind → style analysis. Null when the source does not parse. */
export function front(source: string, reporter: Reporter): Front | null {
	const ast = parse(source, reporter);
	if (!ast) return null;
	const component = lower(ast, source, reporter);
	const bindings = bind(component);
	return { component, bindings, styles: collectStyles(component, bindings) };
}

const ELEMENT_TYPES: Record<Tag, string> = {
	main: 'HTMLElement',
	div: 'HTMLDivElement',
	button: 'HTMLButtonElement',
	p: 'HTMLParagraphElement',
	span: 'HTMLSpanElement',
	input: 'HTMLInputElement',
	textarea: 'HTMLTextAreaElement'
};

/** What each `bind:this` assigns to its variable: the element while mounted, else `undefined`. */
function boundElements(component: Component, bindings: Bindings): TemplateWrite[] {
	const writes: TemplateWrite[] = [];
	for (const element of elements(component.template)) {
		if (element.type !== 'element') continue;
		for (const a of element.attributes)
			if (a.type === 'bind' && a.name === 'this' && bindings.reference(a.expression)?.symbol)
				writes.push({ name: a.expression.name, type: `${ELEMENT_TYPES[element.tag]} | undefined`, ...a.span });
	}
	return writes;
}

/** The .pat files the script imports: local name → absolute path. */
function componentImports(component: Component, filename: string): Map<string, { path: string; statement: any }> {
	const out = new Map<string, { path: string; statement: any }>();
	for (const statement of component.script?.imports ?? []) {
		const from: string = statement.source.value;
		const local = statement.specifiers[0]?.local?.name;
		if (/\.pat($|\?)/.test(from) && local) out.set(local, { path: resolve(dirname(resolve(filename)), from.split('?')[0]), statement });
	}
	return out;
}

function componentSites(component: Component, bindings: Bindings, filename: string, position: (offset: number) => string): ComponentSite[] {
	const imports = componentImports(component, filename);
	const sites: ComponentSite[] = [];
	const walk = (nodes: TemplateNode[], repeated: boolean) => {
		for (const node of nodes) {
			const symbol = node.type === 'component' ? bindings.reference(node.name)?.symbol : null;
			const imported = node.type === 'component' && symbol && symbol === bindings.topLevel(node.name.name) ? imports.get(node.name.name) : undefined;
			if (node.type === 'component' && imported) sites.push({ tag: node.name.name, id: position(node.span.start), path: imported.path, repeated });
			for (const fragment of fragments(node)) walk(fragment, repeated || node.type === 'each');
		}
	};
	walk(component.template, false);
	return sites;
}

function check(source: string, filename: string, reporter: Reporter): Front | null {
	const result = front(source, reporter);
	if (!result) return null;
	const { component, bindings, styles } = result;
	for (const { path, statement } of componentImports(component, filename).values())
		if (!existsSync(path)) reporter.report(statement.source, `cannot find component ${statement.source.value}`);
	checkScript(component, bindings, reporter);
	checkTemplate(component, bindings, reporter);
	checkTemplateNames(component, bindings, globalNames(resolve(filename)), reporter);
	checkNames(component.template, reporter);
	checkAnchorReferences(styles, bindings, reporter);
	checkStyles(styles, reporter);
	reporter.diagnostics.sort((a, b) => a.start - b.start);

	// TypeScript diagnostics for the script. A PAT error already covering the
	// same spot wins (e.g. an `import "./App.pat"` is not also "Cannot find module").
	const script = component.script;
	if (script?.lang === 'ts') {
		const pat = reporter.diagnostics.filter((d) => d.severity === 'error');
		const writes = boundElements(component, bindings);
		for (const { write, ...d } of typecheck(source, resolve(filename), script.span.start, script.span.end, writes)) {
			if (pat.some((p) => p.start <= d.start && d.start < p.end)) continue;
			const message = write === undefined ? d.message : `bind:this sets "${writes[write].name}" to ${writes[write].type}: ${d.message}`;
			reporter.diagnostics.push({ ...d, message, source: 'typescript', ...reporter.position(d.start) });
		}
	}
	return result;
}

/** Validation only: every diagnostic, no code generation. */
export function analyze(source: string, options: { filename?: string } = {}): Analysis {
	const reporter = new Reporter(source);
	check(source, options.filename ?? 'app.pat', reporter);
	return { diagnostics: reporter.diagnostics };
}

/**
 * Validation, type checking and code generation. `filename` is the .pat path
 * (relative to the working directory or absolute). Throws a CompileError
 * listing every diagnostic.
 */
export function compile(source: string, filename = 'app.pat'): Compiled {
	const reporter = new Reporter(source);
	const result = check(source, filename, reporter);
	if (!result || reporter.hasErrors()) throw new CompileError(reporter.diagnostics, source, filename);
	const { component, bindings } = result;

	const edits = new Edits(source);
	const script = emitScript(component, bindings, source, edits);
	const position = (offset: number) => {
		const { line, column } = reporter.position(offset);
		return location(line, column);
	};
	const template = new TemplateEmitter(
		edits,
		position,
		(node) => (isSignal(bindings.reference(node)?.symbol) ? `${node.name}.v` : node.name)
	).fragment(component.template);
	const ts = `${script.imports.join('\n')}\nexport default function program($$rt) {\n${script.code}\nreturn ${template};\n}\n`;
	const module = new Bun.Transpiler({ loader: 'ts', target: 'browser' }).transformSync(ts);
	const imports = new Bun.Transpiler({ loader: 'js' }).scanImports(module).map((i) => i.path);
	const info = component.script;
	return {
		path: resolve(filename),
		module,
		imports,
		state: info?.state.map((d) => d.info) ?? [],
		components: componentSites(component, bindings, filename, position),
		script: info ? { lang: info.lang, source, start: info.span.start, end: info.span.end } : null
	};
}
