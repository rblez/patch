// The Figma target: an evaluated state as editable Figma layers on the clipboard.

import type { Concrete } from '../../schema/concrete';
import { toFigma, type FigmaFrame } from './adapter';
import { encodeFigmaClipboard } from './encode';
import { layout } from './layout';
import { loadFonts } from './fonts';
import { deriveTexts } from './glyphs';
import { measureWith, type WidthOf } from './text';

export { copyFigmaClipboard } from './clipboard';
export { decodeFigmaClipboard } from './encode';

/**
 * Concrete tree → laid-out Figma layers with their glyphs, read from the
 * installed font files. A given `widthOf` measures instead, without glyphs.
 */
export function toFigmaLayers(tree: Concrete[], name: string, widthOf?: WidthOf): { root: FigmaFrame; blobs: Uint8Array[]; warnings: string[] } {
	const { root, warnings } = toFigma(tree, name);
	const fonts = widthOf ? null : loadFonts();
	layout(root, widthOf ? measureWith(widthOf) : measureWith(fonts!.widthOf, fonts!.metricsOf));
	const blobs = fonts ? deriveTexts(root, fonts) : [];
	return { root, blobs, warnings: [...warnings, ...(fonts?.warnings() ?? [])] };
}

/** Concrete tree → the HTML Figma pastes as layers. */
export async function snapshotToFigma(tree: Concrete[], name: string, widthOf?: WidthOf) {
	const { root, blobs, warnings } = toFigmaLayers(tree, name, widthOf);
	return { html: encodeFigmaClipboard(root, blobs), root, warnings };
}
