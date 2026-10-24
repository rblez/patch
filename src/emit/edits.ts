// Source edits keyed by original offsets, rendered for any sub-range. Script
// and template expressions are emitted as the author's text with these edits
// applied, so formatting and comments survive.

export class Edits {
	private inserts = new Map<number, { end: string[]; start: string[] }>();
	private replaces = new Map<number, { end: number; text: string }>();
	constructor(private source: string) {}
	private slot(pos: number) {
		let slot = this.inserts.get(pos);
		if (!slot) this.inserts.set(pos, (slot = { end: [], start: [] }));
		return slot;
	}
	/** Text after a node ending at `pos`. Later calls land further out. */
	after(pos: number, text: string) {
		this.slot(pos).end.push(text);
	}
	/** Text before a node starting at `pos`. Later calls land further out. */
	before(pos: number, text: string) {
		this.slot(pos).start.unshift(text);
	}
	replace(start: number, end: number, text: string) {
		this.replaces.set(start, { end, text });
	}
	render(start: number, end: number) {
		let out = '';
		for (let i = start; ; ) {
			const slot = this.inserts.get(i);
			if (slot) out += slot.end.join('') + slot.start.join('');
			if (i >= end) return out;
			const replace = this.replaces.get(i);
			if (replace) {
				out += replace.text;
				i = replace.end;
			} else out += this.source[i++];
		}
	}
}
