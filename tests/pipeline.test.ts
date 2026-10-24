import { expect, test } from 'bun:test';
import { analyze, compile } from '../src';
import { bind } from '../src/bind';
import { Reporter } from '../src/diagnostics';
import { lower } from '../src/lower';
import { parse } from '../src/parse';

const messages = (source: string) => analyze(source).diagnostics.map((d) => d.message);

const ir = (source: string) => {
	const reporter = new Reporter(source);
	const component = lower(parse(source, reporter)!, source, reporter);
	return { component, diagnostics: reporter.diagnostics.map((d) => d.message) };
};

test('binding resolves through scopes, shadowing and each items', () => {
	const { component } = ir(`<script>let n = $state(0); function f(n) { return n; } const g = () => n;</script>{#each items as n (n)}<p>{n}</p>{/each}<p>{n}</p>`);
	const kinds = bind(component).references.filter((r) => r.node.name === 'n').map((r) => r.symbol?.kind);
	// f's parameter, g's closure, the each key and body, the template outside the each.
	expect(kinds).toEqual(['local', 'state', 'item', 'item', 'state']);
});

test('every problem in a statement is reported, not just the first', () => {
	expect(messages(`<script>let a = $state([1]); let d = $derived(a); function f() { d = a.push(1); }</script><p>x</p>`)).toEqual([
		'"d" is $derived and read-only',
		'.push() mutates reactive "a" in place, which is not tracked; assign a new array instead'
	]);
	expect(messages(`<div style={['gap: 4px', { zIndex: 1 }]}></div>`)).toEqual([
		'CSS strings are not supported; use an object or $style({...})',
		'Unsupported style property "zIndex"'
	]);
});

test('the contents of unsupported constructs are still checked', () => {
	expect(messages(`<section><p style={{ padding: 1 }}>x</p><img /></section>`)).toEqual([
		'<section> is not supported (use main, div, button, p, span, input, textarea)',
		'"padding" is not supported on text elements (<p>, <span>); wrap the text in a <div> for boxes, padding and backgrounds',
		'<img> is not supported (use main, div, button, p, span, input, textarea)'
	]);
	expect(messages(`{#each [1] as [a] (a)}<div class="x"></div>{/each}`)).toEqual([
		'{#each} needs `as item` with a plain identifier',
		'class= is not supported; use style={...}'
	]);
});

test('a declaration cannot take a rune name, so a rune call is never a user function', () => {
	const reserved = (name: string) => `"${name}": names beginning with "$" are reserved for Patch runes`;
	// Shadowing $state used to compile `$state(1)` as a plain call and read `x.v`.
	expect(messages(`<script>function $state(v) { return v; } let x = $state(1);</script><p>{x}</p>`)).toEqual([reserved('$state')]);
	expect(messages(`<script>const $state = (v) => v; let x = $state(1);</script><p>{x}</p>`)).toEqual([reserved('$state')]);
	expect(messages(`<script>import { $state } from './runes.js'; let x = $state(1);</script><p>{x}</p>`)).toEqual([reserved('$state')]);
	expect(messages(`<script>function f($foo, { a: $_bar }) { try {} catch ($$e) {} }</script><p>x</p>`)).toEqual([reserved('$foo'), reserved('$_bar'), reserved('$$e')]);
	expect(messages(`{#each [1] as $item, $i ($item)}<p>{$i}</p>{/each}{#snippet $s($p)}<p>{$p}</p>{/snippet}`)).toEqual([
		reserved('$item'),
		reserved('$i'),
		reserved('$s'),
		reserved('$p')
	]);
	// The index is reported where it is written, not where its name appears in the item's type.
	const typed = `<script lang="ts">let xs = $state([1]);</script>{#each xs as item: $I, $I}<p>{$I}</p>{/each}`;
	expect(analyze(typed).diagnostics.map((d) => d.start)).toEqual([typed.lastIndexOf('$I, ') + 4]);
});

test('a bare $ is an ordinary name', () => {
	const source = `<script>const $ = (v) => v; let n = $state($(1)); const doubled = $derived(n * 2);</script><p>{$(doubled)}</p>`;
	expect(messages(source)).toEqual([]);
	expect(compile(source).module).toContain('$$rt.state("n", () => $(1))');
});

test('diagnostics are in source order', () => {
	const diagnostics = analyze(`<script>const s = $style({ zIndex: 1 })</script><div class="a"></div><p style={{ gap: 1 }}>x</p>`).diagnostics;
	expect(diagnostics.map((d) => d.start)).toEqual([...diagnostics.map((d) => d.start)].sort((a, b) => a - b));
	expect(diagnostics).toHaveLength(3);
});
