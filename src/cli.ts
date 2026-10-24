#!/usr/bin/env bun
import { basename, extname } from 'node:path';
import { compile } from './compile';

const usage = `usage:
  patch dev <path> [--port 5173]
  patch build <path> [output.html]
  patch snapshot figma <path> [--state name=value]...
  patch snapshot html <path> [output.html] [--state name=value]...
  patch lsp

dev serves the app with Vite and reloads the browser when the file changes.
build bundles the app and its imports into one standalone HTML file (compile is an alias).
snapshot renders the app at its initial state, without running $effects:
  figma  copies it to the clipboard as editable Figma layers; paste it into Figma.
  html   writes the app as one standalone HTML file starting from that state
         (default <name>.snapshot.html). It stays interactive: $effects
         start at the first interaction.
--state replaces a $state's initial value: JSON, else a plain string, checked
against the variable's type.
Type errors fail build and snapshot; dev shows them in the browser overlay.
lsp runs the PAT language server over stdio.
Any other arguments are passed to the system patch(1).`;

const fail = (message: string): never => {
	console.error(message);
	process.exit(1);
};

const [command, ...rest] = process.argv.slice(2);
const commands = ['dev', 'build', 'compile', 'snapshot', 'lsp', 'help'];

// `patch` is also the standard Unix tool. Anything that is not one of our
// commands (e.g. `patch -p1 < fix.diff`) goes to the system binary unchanged.
const system = '/usr/bin/patch';
if (!commands.includes(command) && (command !== undefined || !process.stdin.isTTY) && (await Bun.file(system).exists())) {
	const proc = Bun.spawn([system, ...process.argv.slice(2)], { stdio: ['inherit', 'inherit', 'inherit'] });
	process.exit(await proc.exited);
}

try {
	if (command === 'lsp') (await import('./lsp/server')).startLanguageServer();
	else if (command === 'dev') await dev(rest);
	else if (command === 'build' || command === 'compile') await build(rest);
	else if (command === 'snapshot') await snapshot(rest);
	else fail(usage);
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}

async function dev(args: string[]) {
	const { positional, flags } = parse(args, ['--port']);
	if (positional.length !== 1) fail(usage);
	await (await import('./targets/browser/vite')).startDevServer(positional[0], flags['--port'] ? Number(flags['--port']) : undefined);
}

async function build(args: string[]) {
	const { positional } = parse(args, []);
	const [input, output] = positional;
	if (!input || positional.length > 2) fail(usage);
	const stem = input.slice(0, input.length - extname(input).length);
	const out = output ?? `${stem}.html`;
	await Bun.write(out, await (await import('./targets/browser/vite')).buildStandalone(input));
	console.error(`wrote ${out}`);
}

async function snapshot(args: string[]) {
	const { positional, state } = parse(args, [], true);
	const [target, input, output] = positional;
	if (target !== 'figma' && target !== 'html') fail(`patch snapshot needs a target: figma or html\n\n${usage}`);
	if (!input || positional.length > (target === 'html' ? 3 : 2)) fail(usage);
	const { evaluate, parseStateOverrides } = await import('./design');
	const compiled = compile(await Bun.file(input).text(), input);
	const overrides = parseStateOverrides(compiled, state);
	const stem = basename(input, extname(input));

	if (target === 'html') {
		const out = output ?? `${input.slice(0, input.length - extname(input).length)}.snapshot.html`;
		const html = await (await import('./targets/browser/vite')).buildStandalone(input, { overrides, design: true });
		await Bun.write(out, html);
		console.error(`wrote ${out}`);
		return;
	}

	const { copyFigmaClipboard, snapshotToFigma } = await import('./targets/figma');
	const { html, warnings } = await snapshotToFigma(await evaluate(compiled, overrides), stem);
	for (const warning of warnings) console.error(`warning: ${warning}`);
	await copyFigmaClipboard(html);
	console.error('Copied snapshot to clipboard');
}

function parse(args: string[], valued: string[], withState = false) {
	const positional: string[] = [];
	const flags: Record<string, string> = {};
	const state: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (withState && arg === '--state') state.push(args[++i] ?? fail('--state needs name=value'));
		else if (withState && arg.startsWith('--state=')) state.push(arg.slice('--state='.length));
		else if (valued.includes(arg)) flags[arg] = args[++i] ?? fail(`${arg} needs a value`);
		else if (arg.startsWith('--')) fail(`unknown option ${arg}\n\n${usage}`);
		else positional.push(arg);
	}
	return { positional, flags, state };
}
