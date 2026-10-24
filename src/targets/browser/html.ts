// The host document and Vite's error overlay.

import type { CompileError } from '../../diagnostics';

/** The host document: fonts, the #app element, and the given script tag. */
export function htmlPage(title: string, script: string): string {
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/</g, '&lt;')}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap">
</head>
<body>
<div id="app"></div>
${script}
</body>
</html>
`;
}

// Vite's overlay shows `message`, `loc` and `frame`, and only renders frames in
// its `line | code` / `| ^^^` shape.
export function overlayError(error: CompileError, file: string) {
	const lines = error.source.split('\n');
	const frame = error.diagnostics.map((d) => {
		const text = lines[d.line - 1] ?? '';
		const gutter = String(d.line);
		const width = Math.max(1, Math.min(d.end - d.start, text.length - d.column + 1));
		const code = d.code === undefined ? '' : ` (TS${d.code})`;
		return `${d.message}${code}\n${gutter} | ${text}\n${' '.repeat(gutter.length)} | ${text.slice(0, d.column - 1).replace(/[^\t]/g, ' ')}${'^'.repeat(width)}`;
	});
	const [first] = error.diagnostics;
	return Object.assign(new Error(first.message), {
		id: file,
		loc: { file, line: first.line, column: first.column },
		frame: frame.join('\n\n'),
		plugin: 'pat',
		stack: ''
	});
}
