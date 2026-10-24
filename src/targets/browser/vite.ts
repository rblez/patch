// Vite integration for `patch dev`, `patch build` and `patch snapshot html`.
// The .pat file is an ordinary module in Vite's graph (compiled by
// `transform`), so Vite resolves its imports, watches it, reloads the page
// when it changes and shows compile and type errors in its overlay. A virtual
// entry mounts the program, optionally from overridden state. Imported .pat
// components are modules of the graph like the entry. `patch` (what .ts
// modules import createContext from) resolves to the runtime's context module.

import { basename, dirname, extname, resolve } from 'node:path';
import { build, createServer, type Plugin } from 'vite';
import { compile } from '../../compile';
import type { ApiOptions } from '../../runtime/api';
import { CompileError } from '../../diagnostics';
import { htmlPage, overlayError } from './html';

const ENTRY = '/@pat/entry.js';
const RESOLVED = '\0pat:entry';
const DOM = resolve(import.meta.dir, '../../runtime/dom.ts');
export const PATCH_MODULE = resolve(import.meta.dir, '../../runtime/context.ts');
const REPO = resolve(import.meta.dir, '../../..');

export function patPlugin(file: string, mount: ApiOptions = {}): Plugin {
	return {
		name: 'pat',
		resolveId: (id) => (id === ENTRY ? RESOLVED : id === 'patch' ? PATCH_MODULE : undefined),
		load(id) {
			if (id !== RESOLVED) return;
			return [
				`import program from ${JSON.stringify(file)};`,
				`import { mount } from ${JSON.stringify(DOM)};`,
				`mount(program, document.getElementById("app"), ${JSON.stringify(mount)});`
			].join('\n');
		},
		transform(source, id) {
			const path = id.split('?')[0];
			if (!path.endsWith('.pat')) return;
			try {
				return { code: compile(source, path).module, map: null };
			} catch (error) {
				throw error instanceof CompileError ? overlayError(error, path) : error;
			}
		},
		configureServer(server) {
			server.middlewares.use(async (req, res, next) => {
				if (req.method !== 'GET' || !req.headers.accept?.includes('text/html')) return next();
				const html = htmlPage(title(file), `<script type="module" src="${ENTRY}"></script>`);
				res.setHeader('Content-Type', 'text/html');
				res.end(await server.transformIndexHtml(req.url ?? '/', html));
			});
		}
	};
}

const title = (file: string) => basename(file, extname(file));

export async function startDevServer(input: string, port = 5173) {
	const file = resolve(input);
	const server = await createServer({
		configFile: false,
		root: dirname(file),
		appType: 'custom',
		plugins: [patPlugin(file)],
		server: { port, fs: { allow: [dirname(file), REPO] } }
	});
	await server.listen();
	server.printUrls();
	return server;
}

/**
 * Bundles the app and its imports with Vite into one self-contained HTML
 * document. `mount` starts it from overridden state; with `design`, its
 * effects start at the first interaction.
 */
export async function buildStandalone(input: string, mount: ApiOptions = {}): Promise<string> {
	const file = resolve(input);
	const result = await build({
		configFile: false,
		root: dirname(file),
		logLevel: 'warn',
		plugins: [patPlugin(file, mount)],
		build: {
			write: false,
			modulePreload: false,
			assetsInlineLimit: () => true,
			rolldownOptions: { input: ENTRY, output: { codeSplitting: false } }
		}
	});
	const outputs = (Array.isArray(result) ? result : [result]).flatMap((r) => ('output' in r ? r.output : []));
	const chunks = outputs.filter((o) => o.type === 'chunk');
	const css = outputs.filter((o) => o.type === 'asset' && o.fileName.endsWith('.css'));
	const other = outputs.filter((o) => o.type === 'asset' && !o.fileName.endsWith('.css'));
	if (chunks.length !== 1 || other.length) throw new Error(`Cannot inline build output: ${outputs.map((o) => o.fileName).join(', ')}`);
	const styles = css.map((o) => `<style>\n${String(o.type === 'asset' && o.source).replace(/<\/style/gi, '<\\/style')}\n</style>\n`).join('');
	const code = chunks[0].type === 'chunk' ? chunks[0].code : '';
	return htmlPage(title(file), `${styles}<script type="module">\n${code.replace(/<\/script/gi, '<\\/script')}\n</script>`);
}
