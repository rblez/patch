// The part of Figma's document schema a snapshot writes. Names, field ids and
// enum values are Figma's; definitions, fields and enum members Patch never
// writes are left out. The payload carries this schema, and readers decode by
// it.

import { parseSchema } from './kiwi';

export const FIGMA_SCHEMA = parseSchema(`
enum MessageType { NODE_CHANGES = 1; }
enum NodePhase { CREATED = 0; }
enum NodeType { DOCUMENT = 1; CANVAS = 2; FRAME = 4; TEXT = 13; }
enum EditorType { DESIGN = 0; }
enum DocumentColorProfile { SRGB = 1; }
enum PaintType { SOLID = 0; }
enum BlendMode { PASS_THROUGH = 0; NORMAL = 1; }
enum EffectType { INNER_SHADOW = 0; DROP_SHADOW = 1; }
enum StrokeAlign { CENTER = 0; INSIDE = 1; OUTSIDE = 2; }
enum StrokeJoin { MITER = 0; }
enum StackMode { NONE = 0; HORIZONTAL = 1; VERTICAL = 2; }
enum StackSize { FIXED = 0; RESIZE_TO_FIT = 1; RESIZE_TO_FIT_WITH_IMPLICIT_SIZE = 2; }
enum StackJustify { MIN = 0; CENTER = 1; MAX = 2; SPACE_BETWEEN = 4; }
enum StackAlign { MIN = 0; CENTER = 1; MAX = 2; BASELINE = 3; }
enum StackCounterAlign { MIN = 0; CENTER = 1; MAX = 2; STRETCH = 3; AUTO = 4; BASELINE = 5; }
enum StackPositioning { AUTO = 0; ABSOLUTE = 1; }
enum StackWrap { NO_WRAP = 0; WRAP = 1; }
enum ConstraintType { MIN = 0; }
enum TextAlignHorizontal { LEFT = 0; CENTER = 1; RIGHT = 2; }
enum TextAlignVertical { TOP = 0; CENTER = 1; }
enum TextAutoResize { NONE = 0; WIDTH_AND_HEIGHT = 1; HEIGHT = 2; }
enum TextTruncation { DISABLED = 0; ENDING = 1; }
enum TextCase { ORIGINAL = 0; UPPER = 1; LOWER = 2; TITLE = 3; }
enum TextDecoration { NONE = 0; UNDERLINE = 1; STRIKETHROUGH = 2; }
enum NumberUnits { RAW = 0; PIXELS = 1; PERCENT = 2; }
enum FontStyle { NORMAL = 0; ITALIC = 1; }
enum Directionality { LTR = 0; }

struct GUID { uint sessionID; uint localID; }
struct ParentIndex { GUID guid; string position; }
struct Vector { float x; float y; }
struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
struct Color { float r; float g; float b; float a; }
struct Rect { float x; float y; float w; float h; }
struct Number { float value; NumberUnits units; }
struct FontName { string family; string style; string postscript; }
struct Blob { byte[] bytes; }

message OptionalVector { Vector value = 1; }

message Paint {
	PaintType type = 1;
	Color color = 2;
	float opacity = 3;
	bool visible = 4;
	BlendMode blendMode = 5;
}

message Effect {
	EffectType type = 1;
	Color color = 2;
	Vector offset = 3;
	float radius = 4;
	bool visible = 5;
	BlendMode blendMode = 6;
	float spread = 7;
	bool showShadowBehindNode = 8;
}

message Glyph {
	uint commandsBlob = 1;
	Vector position = 2;
	uint styleID = 3;
	float fontSize = 4;
	uint firstCharacter = 5;
	float advance = 6;
}

message Baseline {
	Vector position = 1;
	float width = 2;
	float lineY = 3;
	float lineHeight = 4;
	uint firstCharacter = 5;
	uint endCharacter = 6;
	float lineAscent = 7;
}

message Decoration {
	Rect[] rects = 1;
	uint styleID = 2;
}

message FontMetaData {
	FontName key = 1;
	float fontLineHeight = 2;
	FontStyle fontStyle = 4;
	int fontWeight = 5;
}

message DerivedTextLineData {
	Directionality directionality = 1;
}

message DerivedTextData {
	Vector layoutSize = 1;
	Baseline[] baselines = 2;
	Glyph[] glyphs = 3;
	Decoration[] decorations = 4;
	FontMetaData[] fontMetaData = 6;
	int truncationStartIndex = 8;
	float truncatedHeight = 9;
	float[] logicalIndexToCharacterOffsetMap = 10;
	DerivedTextLineData[] derivedLines = 12;
}

message TextData {
	string characters = 1;
	uint[] characterStyleIDs = 2;
	NodeChange[] styleOverrideTable = 3;
}

message NodeChange {
	GUID guid = 1;
	NodePhase phase = 2;
	ParentIndex parentIndex = 3;
	NodeType type = 4;
	string name = 5;
	bool visible = 6;
	float opacity = 8;
	Vector size = 11;
	Matrix transform = 12;
	float cornerRadius = 20;
	float fontSize = 21;
	float strokeWeight = 26;
	ConstraintType horizontalConstraint = 28;
	StrokeAlign strokeAlign = 29;
	StrokeJoin strokeJoin = 31;
	TextAlignHorizontal textAlignHorizontal = 32;
	TextAlignVertical textAlignVertical = 33;
	TextCase textCase = 34;
	TextDecoration textDecoration = 35;
	ConstraintType verticalConstraint = 37;
	Paint[] fillPaints = 38;
	Paint[] strokePaints = 39;
	Number lineHeight = 40;
	FontName fontName = 41;
	TextData textData = 42;
	Effect[] effects = 43;
	TextAutoResize textAutoResize = 46;
	uint styleID = 49;
	string fontVersion = 202;
	uint textUserLayoutVersion = 203;
	StackMode stackMode = 105;
	float stackSpacing = 107;
	bool frameMaskDisabled = 115;
	float rectangleTopLeftCornerRadius = 145;
	float rectangleTopRightCornerRadius = 146;
	float rectangleBottomLeftCornerRadius = 147;
	float rectangleBottomRightCornerRadius = 148;
	bool rectangleCornerRadiiIndependent = 149;
	Number letterSpacing = 165;
	float stackHorizontalPadding = 209;
	float stackVerticalPadding = 210;
	StackSize stackCounterSizing = 221;
	StackSize stackPrimarySizing = 229;
	StackJustify stackPrimaryAlignItems = 230;
	StackAlign stackCounterAlignItems = 231;
	float stackChildPrimaryGrow = 232;
	float stackPaddingRight = 233;
	float stackPaddingBottom = 234;
	StackCounterAlign stackChildAlignSelf = 236;
	StackPositioning stackPositioning = 269;
	uint textBidiVersion = 279;
	TextTruncation textTruncation = 280;
	bool bordersTakeSpace = 294;
	StackWrap stackWrap = 323;
	float stackCounterSpacing = 324;
	OptionalVector minSize = 325;
	OptionalVector maxSize = 326;
	DocumentColorProfile documentColorProfile = 349;
	int maxLines = 351;
	DerivedTextData derivedTextData = 359;
	uint textExplicitLayoutVersion = 396;
	EditorType pageType = 397;
}

message Message {
	MessageType type = 1;
	uint sessionID = 2;
	uint ackID = 3;
	NodeChange[] nodeChanges = 4;
	Blob[] blobs = 6;
	int pasteID = 12;
	string pasteFileKey = 14;
}
`);
