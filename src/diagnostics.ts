// Compiler diagnostics: the type every phase reports into, and how they are
// formatted for the terminal.

export type Diagnostic = {
	message: string;
	severity: 'error' | 'warning';
	source: 'pat' | 'typescript';
	/** TypeScript's diagnostic code. */
	code?: number;
	/** UTF-16 offsets into the source, end exclusive. */
	start: number;
	end: number;
	/** 1-based, for display. */
	line: number;
	column: number;
};

/** A source range. Every IR and ESTree node is one. */
export type Span = { start: number; end: number };

export class CompileError extends Error {
	constructor(
		readonly diagnostics: Diagnostic[],
		readonly source: string,
		readonly filename: string
	) {
		super(diagnostics.map((d) => formatDiagnostic(d, source, filename)).join('\n\n'));
	}
}

/** `file:line:col: message` plus the offending line with the range underlined. */
export function formatDiagnostic(d: Diagnostic, source: string, filename: string): string {
	const text = source.split('\n')[d.line - 1] ?? '';
	const width = Math.max(1, Math.min(d.end - d.start, text.length - d.column + 1));
	const code = d.code === undefined ? '' : ` TS${d.code}`;
	return `${filename}:${d.line}:${d.column}: ${d.severity}${code}: ${d.message}\n  ${text}\n  ${' '.repeat(d.column - 1)}${'^'.repeat(width)}`;
}

/** Collects diagnostics for one source. Every phase reports into the same one. */
export class Reporter {
	readonly diagnostics: Diagnostic[] = [];
	private lineStarts = [0];

	constructor(readonly source: string) {
		for (let i = 0; i < source.length; i++) if (source[i] === '\n') this.lineStarts.push(i + 1);
	}

	/** 1-based line and column of an offset. */
	position(offset: number) {
		let line = 0;
		while (line + 1 < this.lineStarts.length && this.lineStarts[line + 1] <= offset) line++;
		return { line: line + 1, column: offset - this.lineStarts[line] + 1 };
	}

	/**
	 * Reports a PAT diagnostic on `at`, clipped to its first line. The same
	 * problem reached along several paths (a shared style checked for every
	 * element using it) is reported once.
	 */
	report(at: Span, message: string, severity: Diagnostic['severity'] = 'error') {
		const start = at.start;
		const end = Math.max(start + 1, at.end);
		const lineEnd = this.source.indexOf('\n', start);
		const clipped = lineEnd > start && lineEnd < end ? lineEnd : end;
		if (this.diagnostics.some((d) => d.start === start && d.end === clipped && d.message === message)) return;
		this.diagnostics.push({ message, severity, source: 'pat', start, end: clipped, ...this.position(start) });
	}

	hasErrors() {
		return this.diagnostics.some((d) => d.severity === 'error');
	}
}
