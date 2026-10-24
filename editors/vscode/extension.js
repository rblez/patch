// Starts the PAT language server (`patch lsp`) for .pat documents.
//
// Run from the repository, it uses ../../src/cli.ts. Installed from a .vsix, it
// uses the `patch` command that `bun link` puts in ~/.bun/bin. Both are run
// through bun directly because editors launched from the Dock often do not
// have ~/.bun/bin on PATH.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { window, workspace } = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

const exists = (file) => {
	try {
		fs.accessSync(file);
		return true;
	} catch {
		return false;
	}
};

exports.activate = () => {
	const config = workspace.getConfiguration('patch');
	const bunBin = path.join(os.homedir(), '.bun', 'bin');
	const repoEntry = path.join(__dirname, '..', '..', 'src', 'cli.ts');
	const linked = path.join(bunBin, 'patch');
	const entry =
		config.get('entry') || (exists(repoEntry) ? repoEntry : exists(linked) ? fs.realpathSync(linked) : null);
	if (!entry) {
		window.showErrorMessage('PAT: run `bun link` in the patch repository (or set patch.entry) to enable diagnostics.');
		return;
	}
	const bun = config.get('bun') || (exists(path.join(bunBin, 'bun')) ? path.join(bunBin, 'bun') : 'bun');
	const server = { command: bun, args: [entry, 'lsp'], transport: TransportKind.stdio };
	client = new LanguageClient('pat', 'PAT', { run: server, debug: server }, {
		documentSelector: [{ language: 'pat' }]
	});
	return client.start();
};

exports.deactivate = () => client?.stop();
