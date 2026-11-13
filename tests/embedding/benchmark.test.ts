import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('frozen benchmarks preserve saved source and refuse changed artifacts before publishing', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), 'ring64-benchmark-'));
  try {
    await mkdir(join(directory, 'build'));
    await mkdir(join(directory, 'scripts'));
    await Promise.all([
      cp(join(root, 'build/host'), join(directory, 'build/host'), { recursive: true }),
      cp(join(root, 'build/ring64.wasm'), join(directory, 'build/ring64.wasm')),
      cp(join(root, 'benchmarks'), join(directory, 'benchmarks'), { recursive: true }),
      cp(join(root, 'scripts/benchmark.mjs'), join(directory, 'scripts/benchmark.mjs')),
      symlink(
        join(root, 'node_modules'),
        join(directory, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir',
      ),
      writeFile(join(directory, 'package.json'), '{"type":"module"}\n'),
      writeFile(
        join(directory, 'paging-source.json'),
        JSON.stringify({
          source: { commit: 'saved-frozen-source', workingTree: [' M captured-source.rs'] },
        }),
      ),
    ]);
    const script = join(directory, 'scripts/benchmark.mjs');
    const output = join(directory, 'accepted.json');
    const args = [
      script,
      '--iterations',
      '3',
      '--samples',
      '1',
      '--workloads',
      'integer-qword-add',
      '--output',
    ];
    const accepted = spawnSync(process.execPath, [...args, output], { encoding: 'utf8' });
    assert.ifError(accepted.error);
    assert.equal(accepted.status, 0, accepted.stderr);
    const report = JSON.parse(await readFile(output, 'utf8')) as {
      sides: {
        commit: string;
        workingTree: { dirty: boolean; changes: string[] };
        coreSha256: string;
      }[];
      samples: { resources: { nativeEntries: number; compilations: number } }[];
    };
    assert.equal(report.sides[0]?.commit, 'saved-frozen-source');
    assert.deepEqual(report.sides[0]?.workingTree, {
      dirty: true,
      changes: [' M captured-source.rs'],
    });
    assert.equal(report.samples.length, 1);
    assert.equal(report.samples[0]?.resources.nativeEntries, 1);
    assert.equal(report.samples[0]?.resources.compilations, 1);

    const wasm = join(directory, 'build/ring64.wasm');
    const before = await readFile(wasm);
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
    assert.equal(report.sides[0]?.coreSha256, hash(before));
    const hook = join(directory, 'mutate-after-compile.mjs');
    await writeFile(
      hook,
      `import { readFile, writeFile } from 'node:fs/promises';
const path = ${JSON.stringify(wasm)};
const bytes = await readFile(path);
const compile = WebAssembly.compile;
let changed = false;
WebAssembly.compile = async function(input, ...options) {
  const module = await Reflect.apply(compile, WebAssembly, [input, ...options]);
  if (!changed && Buffer.from(input).equals(bytes)) {
    changed = true;
    await writeFile(path, Buffer.concat([bytes, Buffer.from([0, 1, 0])]));
    console.error('artifact changed after native compilation');
  }
  return module;
};
`,
    );
    const rejectedOutput = join(directory, 'rejected.json');
    const rejected = spawnSync(
      process.execPath,
      ['--import', pathToFileURL(hook).href, ...args, rejectedOutput],
      { encoding: 'utf8' },
    );
    assert.ifError(rejected.error);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /artifact changed after native compilation/);
    assert.match(rejected.stderr, /built artifacts changed during observation: current/);
    assert.notEqual(hash(await readFile(wasm)), hash(before));
    await assert.rejects(access(rejectedOutput), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

type TimingSummary = {
  wallMs: number | null;
  first: { wallMs: number | null };
  later: { wallMs: number | null };
};
type AnalyzedTiming = {
  name: string;
  ratio: number | null;
  deltaMs: number | null;
  wallRatio: number | null;
  wallDeltaMs: number | null;
  baseline: TimingSummary;
  current: TimingSummary;
  timingScopes?: { elapsedMs: string; wallMs: string; phaseMediansMs: string };
};

type WallComparison = Pick<AnalyzedTiming, 'name' | 'wallRatio' | 'wallDeltaMs' | 'timingScopes'>;
async function analyzeTimings(
  definitions: object[],
  samples: object[],
): Promise<{
  rows: AnalyzedTiming[];
  cli: { worst: WallComparison[] };
}> {
  const directory = await mkdtemp(join(tmpdir(), 'ring64-timing-analysis-'));
  try {
    const input = join(directory, 'input.json');
    const output = join(directory, 'analysis.json');
    await writeFile(input, JSON.stringify({ definitions, samples }));
    const script = fileURLToPath(new URL('../../scripts/paging-analyze.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [script, input, '--output', output], {
      encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(await readFile(output, 'utf8')) as {
      cohorts: { rows: AnalyzedTiming[] }[];
    };
    return { rows: evidence.cohorts[0]!.rows, cli: JSON.parse(result.stdout) };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('resume analysis preserves summed timings and compares contiguous wall time separately', async () => {
  const name = 'far-call-ret-64-resume';
  const samples = [0, 4, 5].flatMap((sample) =>
    ['baseline', 'current'].map((side) => ({
      workload: name,
      side,
      sample,
      window: sample === 0 ? 'first' : 'later',
      elapsedMs: sample === 0 ? 100 : side === 'baseline' ? 14 : 14.35,
      wallMs: sample === 0 ? (side === 'baseline' ? 100 : 200) : side === 'baseline' ? 16 : 15.9,
      resources: { nativeEntries: 9000 },
    })),
  );
  const {
    rows: [row],
    cli,
  } = await analyzeTimings([{ name, resume: true, instructions: '9000' }], samples);
  assert.ok(row);
  assert.equal(row.ratio, 14.35 / 14);
  assert.ok(Math.abs(row.deltaMs! - 0.35) < 1e-9);
  assert.equal(row.wallRatio, 15.9 / 16);
  assert.ok(Math.abs(row.wallDeltaMs! + 0.1) < 1e-9);
  assert.equal(row.baseline.wallMs, 16);
  assert.equal(row.current.wallMs, 15.9);
  assert.equal(row.baseline.first.wallMs, 100);
  assert.equal(row.current.first.wallMs, 200);
  assert.equal(row.current.later.wallMs, 15.9);
  assert.match(row.timingScopes!.elapsedMs, /sum.*run/i);
  assert.match(row.timingScopes!.wallMs, /including.*checks/i);
  assert.match(row.timingScopes!.phaseMediansMs, /not.*native/i);
  assert.equal(cli.worst[0]?.wallRatio, row.wallRatio);
  assert.equal(cli.worst[0]?.wallDeltaMs, row.wallDeltaMs);
});

test('wall comparisons retain zeros and refuse missing or invalid measurement series', async () => {
  const cases = [
    { name: 'zero-baseline', before: [0], after: [1], ratio: null, delta: 1 },
    { name: 'zero-current', before: [2], after: [0], ratio: 0, delta: -2 },
    { name: 'both-zero', before: [0], after: [0], ratio: null, delta: 0 },
    { name: 'missing', before: [undefined], after: [1], ratio: null, delta: null },
    { name: 'partial', before: [2, undefined], after: [3, 3], ratio: null, delta: null },
    { name: 'negative', before: [-1], after: [1], ratio: null, delta: null },
    { name: 'null', before: [null], after: [1], ratio: null, delta: null },
    { name: 'nonnumeric', before: ['2'], after: [1], ratio: null, delta: null },
    {
      name: 'ratio-overflow',
      before: [Number.MIN_VALUE],
      after: [Number.MAX_VALUE],
      ratio: null,
      delta: Number.MAX_VALUE,
    },
    {
      name: 'median-overflow',
      before: [Number.MAX_VALUE, Number.MAX_VALUE],
      after: [1, 1],
      ratio: null,
      delta: null,
    },
    { name: 'ordinary', before: [undefined], after: [undefined], ratio: null, delta: null },
  ];
  const definitions = cases.map(({ name }) => ({
    name,
    resume: name !== 'ordinary',
    instructions: '9000',
  }));
  const samples = cases.flatMap(({ name, before, after }) =>
    [before, after].flatMap((values, side) =>
      values.map((wallMs, sample) => ({
        workload: name,
        side: side === 0 ? 'baseline' : 'current',
        sample: sample + 4,
        window: 'later',
        elapsedMs: side === 0 ? 10 : 11,
        ...(wallMs === undefined ? {} : { wallMs }),
        resources: { nativeEntries: 9000 },
      })),
    ),
  );
  const { rows } = await analyzeTimings(definitions, samples);
  for (const expected of cases) {
    const row = rows.find(({ name }) => name === expected.name)!;
    assert.equal(row.ratio, 1.1, expected.name);
    assert.equal(row.wallRatio, expected.ratio, expected.name);
    assert.equal(row.wallDeltaMs, expected.delta, expected.name);
    if (expected.name === 'ordinary') assert.equal(row.timingScopes, undefined);
  }
});

test('wall comparisons require matching sample ordinals and windows', async () => {
  const cases = [
    {
      name: 'missing-ordinal',
      before: [[4, 'later', 10]],
      after: [
        [4, 'later', 20],
        [5, 'later', 100],
      ],
    },
    { name: 'phase-mismatch', before: [[4, 'later', 10]], after: [[4, 'first', 20]] },
    {
      name: 'duplicate-before',
      before: [
        [4, 'later', 10],
        [4, 'later', 20],
      ],
      after: [
        [4, 'later', 20],
        [5, 'later', 100],
      ],
    },
    {
      name: 'duplicate-after',
      before: [
        [4, 'later', 10],
        [5, 'later', 20],
      ],
      after: [
        [4, 'later', 20],
        [4, 'later', 100],
      ],
    },
    { name: 'invalid-ordinal', before: [[4.5, 'later', 10]], after: [[4.5, 'later', 20]] },
  ];
  const samples = cases.flatMap(({ name, before, after }) =>
    [before, after].flatMap((values, side) =>
      values.map(([sample, window, wallMs]) => ({
        workload: name,
        side: side === 0 ? 'baseline' : 'current',
        sample,
        window,
        wallMs,
        elapsedMs: side === 0 ? 10 : 11,
        resources: { nativeEntries: 9000 },
      })),
    ),
  );
  const { rows } = await analyzeTimings(
    cases.map(({ name }) => ({ name, resume: true, instructions: '9000' })),
    samples,
  );
  for (const row of rows) {
    assert.equal(row.ratio, 1.1, row.name);
    assert.ok(row.baseline.wallMs! > 0, row.name);
    assert.ok(row.current.wallMs! > 0, row.name);
    assert.equal(row.wallRatio, null, row.name);
    assert.equal(row.wallDeltaMs, null, row.name);
  }
});
