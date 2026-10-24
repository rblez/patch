// One evaluated state of a program: plain data with every style resolved and
// fonts inherited. `runtime/realize.ts` produces it; the Figma snapshot
// target consumes it.

import type { Font, Style } from './style';

export type { Font };

/**
 * An element's resolved style. Its anchor is not a style value here but
 * `anchor`: the concrete id of the element it is anchored to, or null when
 * that element is not rendered. Absent when it is not anchored.
 */
type Styled = { style: Omit<Style, 'anchor'>; anchor?: string | null };

export type Run = { text: string; font: Font };

export type Concrete = Styled &
	(
		| { type: 'frame'; id: string; tag: string; font: Font; children: Concrete[] }
		| { type: 'text'; id: string; tag: string | null; font: Font; runs: Run[] }
		| {
				type: 'input';
				id: string;
				tag: 'input' | 'textarea';
				font: Font;
				value: string;
				placeholder: string;
				inputType: string;
		  }
	);
