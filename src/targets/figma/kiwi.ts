// Kiwi: the compact binary format Figma's documents and clipboard use.
//
// A schema is a list of definitions. Enums are varuints, structs are their
// fields in order, messages are `field id, value` pairs ending with 0. A
// payload carries its own schema in binary form, so a reader decodes it by
// field name.

export type Field = { name: string; type: string; array: boolean; value: number };
export type Definition = { name: string; kind: 'enum' | 'struct' | 'message'; fields: Field[] };
export type Schema = Definition[];

const KINDS = ['enum', 'struct', 'message'] as const;
const NATIVE = ['bool', 'byte', 'int', 'uint', 'float', 'string', 'int64', 'uint64'];

/** Parses kiwi's text syntax: `enum E { A = 0; }`, `struct S { float x; }`, `message M { uint id = 1; }`. */
export function parseSchema(text: string): Schema {
	const schema: Schema = [];
	const body = text.replace(/\/\/.*$/gm, '');
	for (const [, kind, name, inner] of body.matchAll(/\b(enum|struct|message)\s+(\w+)\s*\{([^}]*)\}/g)) {
		const fields: Field[] = [];
		for (const line of inner.split(';').map((l) => l.trim()).filter(Boolean)) {
			const m =
				kind === 'enum' ? line.match(/^()(\w+)\s*=\s*(\d+)$/) : kind === 'struct' ? line.match(/^([\w[\]]+)\s+(\w+)()$/) : line.match(/^([\w[\]]+)\s+(\w+)\s*=\s*(\d+)$/);
			if (!m) throw new Error(`Invalid ${kind} ${name} field "${line}"`);
			const array = m[1].endsWith('[]');
			fields.push({ name: m[2], type: m[1].replace('[]', ''), array, value: kind === 'struct' ? fields.length + 1 : Number(m[3]) });
		}
		schema.push({ name, kind: kind as Definition['kind'], fields });
	}
	for (const def of schema)
		for (const f of def.fields)
			if (def.kind !== 'enum' && !NATIVE.includes(f.type) && !schema.some((d) => d.name === f.type))
				throw new Error(`${def.name}.${f.name}: unknown type ${f.type}`);
	return schema;
}

class Writer {
	private bytes = new Uint8Array(1024);
	length = 0;
	private reserve(n: number) {
		if (this.length + n <= this.bytes.length) return;
		const next = new Uint8Array(Math.max(this.bytes.length * 2, this.length + n));
		next.set(this.bytes.subarray(0, this.length));
		this.bytes = next;
	}
	byte(v: number) {
		this.reserve(1);
		this.bytes[this.length++] = v & 255;
	}
	raw(bytes: Uint8Array) {
		this.reserve(bytes.length);
		this.bytes.set(bytes, this.length);
		this.length += bytes.length;
	}
	uint(v: number) {
		if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error(`Invalid uint ${v}`);
		do {
			const b = v & 127;
			v = Math.floor(v / 128);
			this.byte(v ? b | 128 : b);
		} while (v);
	}
	int(v: number) {
		if (!Number.isInteger(v) || v < -0x80000000 || v > 0x7fffffff) throw new Error(`Invalid int ${v}`);
		this.uint(((v << 1) ^ (v >> 31)) >>> 0);
	}
	/** The float's bits rotated so the exponent comes first; zero is a single byte. */
	float(v: number) {
		const view = new DataView(new ArrayBuffer(4));
		view.setFloat32(0, v);
		const bits = view.getUint32(0);
		const rotated = ((bits >>> 23) | (bits << 9)) >>> 0;
		if ((rotated & 255) === 0) return this.byte(0);
		for (let i = 0; i < 4; i++) this.byte(rotated >>> (i * 8));
	}
	string(v: string) {
		const encoded = new TextEncoder().encode(v);
		if (encoded.includes(0)) throw new Error('Kiwi strings cannot contain NUL');
		this.raw(encoded);
		this.byte(0);
	}
	result() {
		return this.bytes.slice(0, this.length);
	}
}

class Reader {
	offset = 0;
	constructor(private bytes: Uint8Array) {}
	byte() {
		if (this.offset >= this.bytes.length) throw new Error('Unexpected end of kiwi data');
		return this.bytes[this.offset++];
	}
	uint() {
		let v = 0;
		let scale = 1;
		for (;;) {
			const b = this.byte();
			v += (b & 127) * scale;
			if (!(b & 128)) return v;
			scale *= 128;
		}
	}
	int() {
		const v = this.uint();
		return v % 2 ? -(v + 1) / 2 : v / 2;
	}
	float() {
		const first = this.byte();
		if (first === 0) return 0;
		const rotated = (first | (this.byte() << 8) | (this.byte() << 16) | (this.byte() << 24)) >>> 0;
		const view = new DataView(new ArrayBuffer(4));
		view.setUint32(0, ((rotated << 23) | (rotated >>> 9)) >>> 0);
		return view.getFloat32(0);
	}
	string() {
		const end = this.bytes.indexOf(0, this.offset);
		if (end < 0) throw new Error('Unterminated kiwi string');
		const s = new TextDecoder().decode(this.bytes.subarray(this.offset, end));
		this.offset = end + 1;
		return s;
	}
}

/** The binary form of a schema, as it travels inside a payload. */
export function encodeSchema(schema: Schema): Uint8Array {
	const w = new Writer();
	w.uint(schema.length);
	for (const def of schema) {
		w.string(def.name);
		w.byte(KINDS.indexOf(def.kind));
		w.uint(def.fields.length);
		for (const f of def.fields) {
			w.string(f.name);
			const native = NATIVE.indexOf(f.type);
			w.int(def.kind === 'enum' ? 0 : native >= 0 ? -1 - native : schema.findIndex((d) => d.name === f.type));
			w.byte(f.array ? 1 : 0);
			w.uint(f.value);
		}
	}
	return w.result();
}

export function decodeSchema(bytes: Uint8Array): Schema {
	const r = new Reader(bytes);
	const raw = Array.from({ length: r.uint() }, () => {
		const name = r.string();
		const kind = KINDS[r.byte()];
		if (!kind) throw new Error(`Invalid kiwi definition kind in ${name}`);
		const fields = Array.from({ length: r.uint() }, () => ({ name: r.string(), type: r.int(), array: !!r.byte(), value: r.uint() }));
		return { name, kind, fields };
	});
	return raw.map((d) => ({
		...d,
		fields: d.fields.map((f) => ({ ...f, type: d.kind === 'enum' ? '' : f.type < 0 ? NATIVE[-1 - f.type] : raw[f.type].name }))
	}));
}

/** Encodes `value` as the message (or struct) named `root`. Unknown keys are an error. */
export function encode(schema: Schema, root: string, value: unknown): Uint8Array {
	const defs = new Map(schema.map((d) => [d.name, d]));
	const w = new Writer();
	const one = (type: string, v: any, path: string) => {
		switch (type) {
			case 'bool':
				return w.byte(v ? 1 : 0);
			case 'byte':
				return w.byte(v);
			case 'int':
				return w.int(v);
			case 'uint':
				return w.uint(v);
			case 'float':
				return w.float(v);
			case 'string':
				return w.string(String(v));
		}
		const def = defs.get(type);
		if (!def) throw new Error(`${path}: unsupported type ${type}`);
		if (def.kind === 'enum') {
			const field = def.fields.find((f) => f.name === v);
			if (!field) throw new Error(`${path}: ${JSON.stringify(v)} is not a ${type}`);
			return w.uint(field.value);
		}
		if (!v || typeof v !== 'object') throw new Error(`${path}: expected a ${type}`);
		for (const key of Object.keys(v))
			if (v[key] !== undefined && !def.fields.some((f) => f.name === key)) throw new Error(`${path}: ${type} has no field "${key}"`);
		for (const f of def.fields) {
			const fv = v[f.name];
			if (def.kind === 'message') {
				if (fv === undefined) continue;
				w.uint(f.value);
			} else if (fv === undefined) throw new Error(`${path}.${f.name}: missing struct field`);
			field(f, fv, `${path}.${f.name}`);
		}
		if (def.kind === 'message') w.uint(0);
	};
	const field = (f: Field, v: any, path: string) => {
		if (!f.array) return one(f.type, v, path);
		if (!Array.isArray(v) && !(v instanceof Uint8Array)) throw new Error(`${path}: expected an array`);
		w.uint(v.length);
		Array.from(v as ArrayLike<unknown>).forEach((item, i) => one(f.type, item, `${path}[${i}]`));
	};
	one(root, value, root);
	return w.result();
}

/** Decodes a value encoded with `schema`; enum values come back as names. */
export function decode(schema: Schema, root: string, bytes: Uint8Array): any {
	const defs = new Map(schema.map((d) => [d.name, d]));
	const r = new Reader(bytes);
	const one = (type: string): any => {
		switch (type) {
			case 'bool':
				return !!r.byte();
			case 'byte':
				return r.byte();
			case 'int':
				return r.int();
			case 'uint':
				return r.uint();
			case 'float':
				return r.float();
			case 'string':
				return r.string();
		}
		const def = defs.get(type)!;
		if (def.kind === 'enum') {
			const v = r.uint();
			return def.fields.find((f) => f.value === v)?.name ?? v;
		}
		const out: Record<string, unknown> = {};
		if (def.kind === 'struct') for (const f of def.fields) out[f.name] = field(f);
		else
			for (let id = r.uint(); id; id = r.uint()) {
				const f = def.fields.find((f) => f.value === id);
				if (!f) throw new Error(`${type}: unknown field id ${id}`);
				out[f.name] = field(f);
			}
		return out;
	};
	const field = (f: Field) => (f.array ? Array.from({ length: r.uint() }, () => one(f.type)) : one(f.type));
	return one(root);
}
