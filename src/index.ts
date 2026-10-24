// Public compiler API.

export { analyze, compile, type Analysis, type Compiled } from './compile';
export { complete, type Completion } from './complete';
export { CompileError, formatDiagnostic, type Diagnostic } from './diagnostics';
export type { StateInfo } from './ir';
