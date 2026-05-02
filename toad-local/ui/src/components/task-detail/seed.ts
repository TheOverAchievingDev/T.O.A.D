export type PlanState = 'proposed' | 'approved' | 'rejected';
export type RiskSeverity = 'low' | 'med' | 'high';
export type ValidationKind = 'install' | 'lint' | 'typecheck' | 'test' | 'build' | 'security' | 'manual';
export type ValidationVerdict = 'passed' | 'failed' | 'not_run';
export type DiffStatus = 'added' | 'removed' | 'modified';
export type DiffLineKind = 'ctx' | 'add' | 'del';

export interface PlanRisk {
  sev: RiskSeverity;
  text: string;
}

export interface PlanValidationStep {
  kind: ValidationKind;
  cmd: string;
}

export interface PlanData {
  state: PlanState;
  proposer: string;
  decider: string;
  decidedAt: string;
  proposedAt: string;
  summary: string;
  approach: string[];
  filesExpected: string[];
  risks: PlanRisk[];
  validation: PlanValidationStep[];
}

export interface DiffLine {
  t: DiffLineKind;
  n1?: number;
  n2?: number;
  c: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFileData {
  path: string;
  added: number;
  removed: number;
  status: DiffStatus;
  expected: boolean;
  drift?: boolean;
  hunks: DiffHunk[];
}

export interface ValidationData {
  id: string;
  kind: ValidationKind;
  cmd: string;
  verdict: ValidationVerdict;
  duration: string | null;
  exitCode: number | null;
  ranAt: string | null;
  ranBy: string | null;
  output?: string[];
}

export const SEED_PLAN: PlanData = {
  state: 'approved',
  proposer: 'tom',
  decider: 'alice',
  decidedAt: '14:18',
  proposedAt: '14:09',
  summary: 'Introduce streamTranscribe() async iterator in src/audio/stream.ts with backpressure-aware chunking and a partial-frame flush on pause.',
  approach: [
    'Lift the existing chunker out of recorder.ts into stream.ts; expose a single async generator.',
    'Use a 4096-frame default; honor AUDIO_CHUNK_FRAMES env override at module load time.',
    "Buffer flush on pause emits trailing partial frame so we don't drop final audio.",
    'Wrap pause/resume with a dual-reversal guard so re-entrant calls collapse.',
    "Emit a 'partial' event for in-progress transcripts during long utterances.",
  ],
  filesExpected: ['src/audio/stream.ts', 'src/audio/buffer.ts', 'tests/stream.test.ts'],
  risks: [
    { sev: 'med', text: 'AudioWorklet timer drift on Firefox can desync chunk boundaries — verify by recording 5min and asserting frame count.' },
    { sev: 'low', text: 'Existing callers that depend on synchronous chunk delivery will need to be migrated; grepped 3 sites.' },
  ],
  validation: [
    { kind: 'test', cmd: 'pnpm test stream' },
    { kind: 'lint', cmd: 'pnpm lint src/audio' },
    { kind: 'typecheck', cmd: 'pnpm tsc --noEmit' },
    { kind: 'manual', cmd: 'Record 30s sample, verify partial events fire' },
  ],
};

export const SEED_DIFF_FILES: DiffFileData[] = [
  {
    path: 'src/audio/stream.ts',
    added: 128, removed: 41, status: 'modified', expected: true,
    hunks: [
      {
        header: '@@ -14,21 +14,46 @@ export interface ChunkOptions {',
        lines: [
          { t: 'ctx', n1: 14, n2: 14, c: 'export interface ChunkOptions {' },
          { t: 'ctx', n1: 15, n2: 15, c: '  frames?: number;' },
          { t: 'ctx', n1: 16, n2: 16, c: '  signal?: AbortSignal;' },
          { t: 'ctx', n1: 17, n2: 17, c: '}' },
          { t: 'ctx', n1: 18, n2: 18, c: '' },
          { t: 'del', n1: 19, c: 'export function chunkAudio(stream, opts = {}) {' },
          { t: 'del', n1: 20, c: '  const frames = opts.frames ?? 4096;' },
          { t: 'add', n2: 19, c: 'export async function* streamTranscribe(' },
          { t: 'add', n2: 20, c: '  source: AsyncIterable<AudioFrame>,' },
          { t: 'add', n2: 21, c: '  opts: ChunkOptions = {},' },
          { t: 'add', n2: 22, c: '): AsyncGenerator<TranscriptChunk> {' },
          { t: 'add', n2: 23, c: '  const frames = opts.frames ?? defaultChunkFrames();' },
          { t: 'add', n2: 24, c: '  let buf = new Float32Array(0);' },
        ],
      },
    ],
  },
  {
    path: 'src/audio/buffer.ts',
    added: 22, removed: 8, status: 'modified', expected: true,
    hunks: [
      {
        header: '@@ -3,8 +3,22 @@ export function concat(a, b) {',
        lines: [
          { t: 'ctx', n1: 3, n2: 3, c: 'export function concat(a: Float32Array, b: Float32Array) {' },
          { t: 'del', n1: 4, c: '  const r = new Float32Array(a.length + b.length);' },
          { t: 'add', n2: 4, c: '  if (a.length === 0) return b;' },
          { t: 'add', n2: 5, c: '  if (b.length === 0) return a;' },
          { t: 'ctx', n1: 5, n2: 6, c: '  r.set(a, 0);' },
        ],
      },
    ],
  },
  {
    path: 'src/billing/proration.ts',
    added: 18, removed: 4, status: 'modified', expected: false, drift: true,
    hunks: [
      {
        header: '@@ -45,4 +45,18 @@ function prorate(amount, days) {',
        lines: [
          { t: 'ctx', n1: 45, n2: 45, c: 'function prorate(amount, days) {' },
          { t: 'del', n1: 47, c: '  return amount * ratio;' },
          { t: 'add', n2: 47, c: '  // FIXME: edge case for partial-day rollovers' },
          { t: 'add', n2: 48, c: '  return Math.round(amount * ratio * 100) / 100;' },
        ],
      },
    ],
  },
  {
    path: 'tests/stream.test.ts',
    added: 64, removed: 0, status: 'added', expected: true,
    hunks: [
      {
        header: '@@ -0,0 +1,64 @@',
        lines: [
          { t: 'add', n2: 1, c: 'import { describe, it, expect } from "vitest";' },
          { t: 'add', n2: 2, c: 'import { streamTranscribe } from "../src/audio/stream";' },
          { t: 'add', n2: 3, c: '' },
          { t: 'add', n2: 4, c: 'describe("streamTranscribe", () => {' },
          { t: 'add', n2: 5, c: '  it("yields chunks at the configured frame size", async () => {' },
          { t: 'add', n2: 6, c: '    const out = [];' },
          { t: 'add', n2: 7, c: '    for await (const c of streamTranscribe(src, { frames: 4096 })) out.push(c);' },
          { t: 'add', n2: 8, c: '    expect(out).toHaveLength(2);' },
          { t: 'add', n2: 9, c: '  });' },
          { t: 'add', n2: 10, c: '});' },
        ],
      },
    ],
  },
];

export const SEED_VALIDATIONS: ValidationData[] = [
  {
    id: 'v1', kind: 'test', cmd: 'pnpm test stream', verdict: 'passed',
    duration: '1.7s', exitCode: 0, ranAt: '14:32', ranBy: 'tom',
    output: [
      'RUN  v1.6.0 /home/tom/work/ide-test', '',
      ' ✓ tests/stream.test.ts (8)',
      '   ✓ streamTranscribe',
      '     ✓ yields chunks at the configured frame size',
      '     ✓ flushes partial frame on pause',
      '     ✓ honors AUDIO_CHUNK_FRAMES env override',
      '', ' Test Files  1 passed (1)', '      Tests  8 passed (8)', '   Duration  1.20s',
    ],
  },
  {
    id: 'v2', kind: 'lint', cmd: 'pnpm lint src/audio', verdict: 'passed',
    duration: '0.8s', exitCode: 0, ranAt: '14:32', ranBy: 'tom',
    output: ['', '✓ Linted 12 files in src/audio — no warnings.'],
  },
  {
    id: 'v3', kind: 'typecheck', cmd: 'pnpm tsc --noEmit', verdict: 'failed',
    duration: '4.2s', exitCode: 2, ranAt: '14:33', ranBy: 'tom',
    output: [
      "src/audio/stream.ts:23:36 - error TS2304: Cannot find name 'AudioFrame'.", '',
      '  23   source: AsyncIterable<AudioFrame>,',
      '                                       ~~~~~~~~~~', '',
      'Found 1 error in src/audio/stream.ts:23',
    ],
  },
  {
    id: 'v4', kind: 'build', cmd: 'pnpm build', verdict: 'not_run',
    duration: null, exitCode: null, ranAt: null, ranBy: null,
  },
];
