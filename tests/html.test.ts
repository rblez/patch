import { expect, test } from 'bun:test';
import { compile } from '../src';
import { mount } from '../src/runtime/dom';
import { buildStandalone } from '../src/targets/browser/vite';

const SOURCE = `<script lang="ts">
	let filter: 'all' | 'done' = $state('all');
	let ran = $state('no');
	$effect(() => { ran = 'yes'; });
</script>
<main><p>{filter} {ran}</p></main>`;

/** Runs `start` against a minimal document stand-in; returns the rendered text after effects had their chance. */
async function render(start: (root: any) => void) {
	const text: { data: string }[] = [];
	const node = (): any => ({
		style: { setProperty() {}, removeProperty() {} },
		setAttribute() {},
		appendChild: (n: any) => n,
		insertBefore: (n: any) => n,
		addEventListener() {}
	});
	const root = node();
	const doc = { head: node(), getElementById: () => root, createElement: node, createComment: () => ({}), createTextNode: (data: string) => (text.push({ data }), text.at(-1)) };
	const previous = (globalThis as any).document;
	(globalThis as any).document = doc;
	try {
		start(root);
		await new Promise((resolve) => setTimeout(resolve, 0));
	} finally {
		(globalThis as any).document = previous;
	}
	return text.map((t) => t.data).join('');
}

const mountSource = (options?: Parameters<typeof mount>[2]) => (root: any) => {
	const program = new Function(`return (${compile(SOURCE, 'html.pat').module.replace(/^export default /m, '')})`)();
	mount(program, root, options);
};

test('mounting from overridden state skips effects; a plain mount runs them', async () => {
	expect(await render(mountSource({ overrides: { filter: 'done' }, design: true }))).toBe('done no');
	expect(await render(mountSource())).toBe('all yes');
});

test('an HTML snapshot bundles the app with its state baked into the mount', async () => {
	const path = `${import.meta.dir}/.html-snapshot.pat`;
	await Bun.write(path, SOURCE);
	try {
		const html = await buildStandalone(path, { overrides: { filter: 'done' }, design: true });
		expect(html).toStartWith('<!doctype html>');
		const script = /<script type="module">\n([\s\S]*)\n<\/script>/.exec(html)![1];
		expect(await render(() => new Function(script)())).toBe('done no');
	} finally {
		await Bun.file(path).delete();
	}
});
