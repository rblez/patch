// PAT language server: publishes compiler diagnostics and serves style
// completions for open .pat documents. It knows nothing about PAT semantics;
// every rule lives in the compiler.

import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	CompletionItemKind,
	createConnection,
	DiagnosticSeverity,
	StreamMessageReader,
	StreamMessageWriter,
	TextDocuments,
	TextDocumentSyncKind,
	type CompletionItem,
	type Diagnostic as LspDiagnostic
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../compile';
import { complete } from '../complete';
import type { Diagnostic } from '../diagnostics';

export function startLanguageServer() {
	// stdout carries the protocol; anything else goes to stderr.
	console.log = console.info = console.warn = console.error;
	const connection = createConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
	const documents = new TextDocuments(TextDocument);

	// The .pat path: the script's imports and tsconfig are found from it.
	const filename = (uri: string) => {
		try {
			return uri.startsWith('file:') ? fileURLToPath(uri) : basename(uri);
		} catch {
			return basename(uri);
		}
	};

	const toLsp = (document: TextDocument, d: Diagnostic): LspDiagnostic => ({
		range: { start: document.positionAt(d.start), end: document.positionAt(d.end) },
		severity: d.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
		source: d.source,
		...(d.code === undefined ? {} : { code: d.code }),
		message: d.message
	});

	const validate = (document: TextDocument) => {
		const { uri, version } = document;
		let diagnostics: LspDiagnostic[];
		try {
			diagnostics = analyze(document.getText(), { filename: filename(uri) }).diagnostics.map((d) => toLsp(document, d));
		} catch (error: any) {
			// A compiler bug must not take the server down.
			console.error(error);
			diagnostics = [{
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
				severity: DiagnosticSeverity.Error,
				source: 'pat',
				message: `internal compiler error: ${error?.message ?? error}`
			}];
		}
		// Skip results for a version that has since been replaced or closed.
		if (documents.get(uri)?.version !== version) return;
		connection.sendDiagnostics({ uri, version, diagnostics });
	};

	connection.onInitialize(() => ({
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			completionProvider: { triggerCharacters: ['{', ',', ':', "'", '"'] }
		}
	}));
	connection.onCompletion(({ textDocument, position }): CompletionItem[] => {
		const document = documents.get(textDocument.uri);
		if (!document) return [];
		try {
			return complete(document.getText(), document.offsetAt(position), { filename: filename(document.uri) }).map((c) => ({
				label: c.label,
				kind: c.kind === 'property' ? CompletionItemKind.Property : CompletionItemKind.Value,
				detail: c.detail,
				insertText: c.insertText
			}));
		} catch (error) {
			console.error(error);
			return [];
		}
	});
	documents.onDidChangeContent(({ document }) => validate(document));
	documents.onDidClose(({ document }) => connection.sendDiagnostics({ uri: document.uri, diagnostics: [] }));

	documents.listen(connection);
	connection.listen();
}
