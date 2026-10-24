// Text widths from the installed font files, read with fontkit, on any OS.
//
// A family is found in the standard font folders: files whose name contains
// the family name are opened first, then every other font file. Within a
// family the face closest in weight and slant is used; a variable font is set
// to the exact weight. An optical-size axis stays at its default: Figma draws
// with static fonts, so text is measured the way Figma lays it out, though a
// browser narrows large text of such a font (`font-optical-sizing: auto`). A
// family that is not installed is measured with a common sans-serif, with a
// warning.

import * as fontkit from 'fontkit';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { approximateMetrics, type FontKey, type MetricsOf, type WidthOf } from './text';

type Face = { font: fontkit.Font; family: string[]; weight: number; italic: boolean };

function fontDirectories(): string[] {
	const home = homedir();
	const dirs =
		process.platform === 'darwin'
			? ['/System/Library/Fonts', '/Library/Fonts', join(home, 'Library/Fonts')]
			: process.platform === 'win32'
				? [join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'), join(process.env.LOCALAPPDATA ?? join(home, 'AppData/Local'), 'Microsoft/Windows/Fonts')]
				: ['/usr/share/fonts', '/usr/local/share/fonts', join(home, '.local/share/fonts'), join(home, '.fonts')];
	return dirs.filter((d) => existsSync(d));
}

let files: string[] | null = null;
function fontFiles(): string[] {
	if (files) return files;
	files = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			try {
				if (statSync(path).isDirectory()) walk(path);
				else if (/\.(ttf|otf|ttc|otc)$/i.test(name)) files!.push(path);
			} catch {}
		}
	};
	fontDirectories().forEach(walk);
	return files;
}

const compact = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const opened = new Map<string, Face[]>();
function faces(path: string): Face[] {
	let result = opened.get(path);
	if (result) return result;
	result = [];
	try {
		const file = fontkit.openSync(path);
		for (const font of 'fonts' in file ? file.fonts : [file]) {
			const os2 = font['OS/2'] as any;
			const family = [font.familyName, font.getName('preferredFamily', 'en')].filter((f): f is string => !!f).map(compact);
			const italic = !!os2?.fsSelection?.italic || font.italicAngle !== 0 || /italic|oblique/i.test(font.subfamilyName ?? '');
			result.push({ font, family, weight: os2?.usWeightClass ?? 400, italic });
		}
	} catch {}
	opened.set(path, result);
	return result;
}

const families = new Map<string, Face[]>();
/** Every installed face of `family` (or "`family` Variable"). */
function familyFaces(family: string): Face[] {
	const wanted = [compact(family), compact(`${family} Variable`)];
	const cached = families.get(wanted[0]);
	if (cached) return cached;
	const match = (paths: string[]) => paths.flatMap(faces).filter((f) => f.family.some((name) => wanted.includes(name)));
	const named = fontFiles().filter((p) => compact(p.split(/[\\/]/).pop()!).includes(wanted[0]));
	let found = match(named);
	if (!found.length) found = match(fontFiles().filter((p) => !named.includes(p)));
	families.set(wanted[0], found);
	return found;
}

const FALLBACKS = ['Helvetica', 'Arial', 'Segoe UI', 'DejaVu Sans', 'Liberation Sans', 'Noto Sans'];

/** The face for a family, weight and slant. */
function faceFor(key: Omit<FontKey, 'size'>): { face: Face; fallback: boolean } | null {
	let candidates = familyFaces(key.family);
	let fallback = false;
	for (const name of FALLBACKS) {
		if (candidates.length) break;
		candidates = familyFaces(name);
		fallback = true;
	}
	if (!candidates.length) return null;
	const score = (f: Face) => {
		const axis = f.font.variationAxes.wght;
		const weight = axis ? Math.min(axis.max, Math.max(axis.min, key.weight)) : f.weight;
		return Math.abs(weight - key.weight) + (f.italic === key.italic ? 0 : 1000);
	};
	return { face: candidates.reduce((a, b) => (score(b) < score(a) ? b : a)), fallback };
}

/** A variable font set to the weight and slant it is drawn at. */
function instance(font: fontkit.Font, key: FontKey): fontkit.Font {
	const axes = font.variationAxes;
	const clamp = (tag: string, v: number) => Math.min(axes[tag]!.max, Math.max(axes[tag]!.min, v));
	const settings: Record<string, number> = {};
	if (axes.wght) settings.wght = clamp('wght', key.weight);
	if (key.italic && axes.ital) settings.ital = 1;
	return Object.keys(settings).length ? font.getVariation(settings) : font;
}

export type Fonts = {
	widthOf: WidthOf;
	/** From the font file; approximated for a font that is not found. */
	metricsOf: MetricsOf;
	/** The font a style is drawn with (a variable font set to its weight and size), or null. */
	fontFor: (key: FontKey) => { font: fontkit.Font; id: string } | null;
	/** The families looked up so far that are not installed. */
	warnings: () => string[];
};

/** Measures and draws with the installed fonts. */
export function loadFonts(): Fonts {
	const warnings = new Set<string>();
	const resolved = new Map<string, ReturnType<typeof faceFor>>();
	const instances = new Map<string, fontkit.Font>();
	const widths = new Map<string, number>();
	const fontFor: Fonts['fontFor'] = (key) => {
		const face = `${key.family}\0${key.weight}\0${key.italic}`;
		if (!resolved.has(face)) {
			const found = faceFor(key);
			resolved.set(face, found);
			if (!found) warnings.add(`Font "${key.family}" is not installed and no fallback font was found; its text has no width`);
			else if (found.fallback) warnings.add(`Font "${key.family}" is not installed; its text was measured with a fallback font`);
		}
		const found = resolved.get(face);
		if (!found) return null;
		const id = `${face}\0${key.size}`;
		if (!instances.has(id)) instances.set(id, instance(found.face.font, key));
		return { font: instances.get(id)!, id };
	};
	const widthOf: WidthOf = (key, text) => {
		const sized = fontFor(key);
		if (!sized) return 0;
		const textId = `${sized.id}\0${text}`;
		let units = widths.get(textId);
		if (units === undefined) {
			units = sized.font.layout(text).advanceWidth / sized.font.unitsPerEm;
			widths.set(textId, units);
		}
		return units * key.size;
	};
	const metricsOf: MetricsOf = (key) => {
		const sized = fontFor(key);
		if (!sized) return approximateMetrics(key);
		const { font } = sized;
		return { ascent: (font.ascent / font.unitsPerEm) * key.size, descent: (-font.descent / font.unitsPerEm) * key.size };
	};
	return { widthOf, metricsOf, fontFor, warnings: () => [...warnings] };
}
