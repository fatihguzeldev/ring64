import { fastReuseFixture, seedFastNumeric } from './fast-system-kernels.mjs';

export const reuseNames = [
  'fast-syscall-sysret64',
  'fast-sysret32',
  'fast-sysenter-sysexit32',
  'fast-sysenter-sysexit64',
  'fast-syscall-gs-stack',
  'fast-budget-one-roundtrip',
  'fast-debug-enabled-miss',
];
const canonical = (value) =>
  JSON.stringify(value, (_, x) =>
    typeof x === 'bigint'
      ? x.toString()
      : x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
        : x,
  );
function equal(actual, expected, label) {
  if (canonical(actual) !== canonical(expected)) throw Error(label + ': checkpoint differs');
}

// Each side is primed independently, then only scalar and non-source data are rearmed.
// The old baseline is measured honestly: it may compile again after that warm-up.
export async function measureReuse(
  side,
  { iterations = 101, samples = 7, workloads = reuseNames, requireReuse = false, onPhase } = {},
) {
  const definitions = [],
    results = [];
  for (const name of workloads) {
    if (!reuseNames.includes(name)) throw Error('unknown reuse workload');
    const f = fastReuseFixture(name, iterations);
    const cpu = await side.createCpu({
      compiler: side.compiler,
      memoryModel: 'ia32e-paged',
      paging: f.paging,
      fastSystem: f.fastSystem,
      context: f.context,
      memory: { backings: [{ id: 'ram', bytes: f.ram }], mappings: f.mappings },
      memoryLimits: { maxBackings: 1, maxMappings: 3, maxBackingBytes: f.ram.length },
      entry: f.initial.rip,
      limits: {
        maxInstructions: 128,
        maxSourceBytes: 2048,
        maxArtifactBytes: 262144,
        maxCachedArtifacts: 32,
        maxCachedBytes: 4194304,
        maxTranslationsPerRun: 8 * iterations + 32,
      },
    });
    try {
      if (f.row.debug)
        cpu.setDebugState({
          ...cpu.readDebugState(),
          addresses: [0x401800n, 0n, 0n, 0n],
          dr7: 0x401n,
        });
      const debugBefore = cpu.readDebugState();
      const numericBefore = seedFastNumeric(cpu);
      const rearm = () => {
        // No context, code, page-table or mapping reset: retain the returned context.
        cpu.setState(f.initial);
        if (f.row.kind === 'gs') cpu.writePhysicalMemory(0xe010n, new Uint8Array(8));
      };
      const run = async () => {
        const resources = {},
          timings = {};
        let retired = 0n,
          calls = 0,
          elapsedMs = 0;
        const execute = async (budget) => {
          const began = performance.now();
          const r = await cpu.run({ budget });
          elapsedMs += performance.now() - began;
          equal(r.reason, 'budget', name + ' reason');
          retired += r.retired;
          calls++;
          for (const [key, value] of Object.entries(r.resources))
            if (typeof value === 'number' && !key.startsWith('cached'))
              resources[key] = (resources[key] ?? 0) + value;
          for (const [key, value] of Object.entries(r.timings))
            timings[key] = (timings[key] ?? 0) + value;
        };
        if (f.row.resume) for (let i = 0; i < f.row.perCycle * iterations; i++) await execute(1n);
        else await execute(BigInt(f.row.perCycle * iterations));
        equal(retired, BigInt(f.row.perCycle * iterations), name + ' retirement');
        return { calls, retired, elapsedMs, resources, timings };
      };
      const guard = () => {
        equal(cpu.readState(), f.expected, name + ' full scalar');
        equal(cpu.readContext(), f.context, name + ' returned context');
        equal(cpu.readPagingState(), f.paging, name + ' paging');
        equal(cpu.readFastSystemState(), f.fastSystem, name + ' bank');
        equal(cpu.readDebugState(), debugBefore, name + ' debug bank');
        equal(
          canonical([cpu.readXmmState(), cpu.readMxcsr(), cpu.readX87State()]),
          numericBefore,
          name + ' numeric banks',
        );
        const expected = f.ram.slice();
        if (f.row.kind === 'gs') {
          const put = (at, value) => {
            for (let i = 0; i < 8; i++) expected[at + i] = Number((value >> BigInt(i * 8)) & 255n);
          };
          put(0xe000, 0x403ff0n);
          put(0xe010, BigInt(iterations));
          put(0xdfe8, f.initial.registers[0]);
        }
        equal([...cpu.readPhysicalMemory(0n, expected.length)], [...expected], name + ' all RAM');
      };
      onPhase?.('warm-up');
      rearm();
      await run();
      guard();
      const warmOwners = cpu.inspectTranslations();
      definitions.push({
        name,
        iterations,
        instructions: f.row.perCycle * iterations,
        work: iterations,
        workUnit: 'complete user/kernel round trip',
        rearm: 'scalar state and GS data counter only; no source writes or context import',
        timing:
          'elapsedMs sums awaited Cpu.run intervals only. batchWallMs also includes per-call reason/work assertions and aggregation; both exclude rearm, warm-up and final full-state/RAM guards.',
        warmOwners: warmOwners.length,
        warmBytes: warmOwners.reduce((sum, m) => sum + m.byteLength, 0),
      });
      for (let sample = 0; sample < samples; sample++) {
        onPhase?.('measured');
        rearm();
        const began = performance.now();
        const result = await run();
        const batchWallMs = performance.now() - began;
        guard();
        const translations = cpu.inspectTranslations();
        if (
          requireReuse &&
          (result.resources.compilations !== 0 || result.resources.generatedBytes !== 0)
        )
          throw Error(name + ': warm context recompiled');
        if (requireReuse) equal(translations, warmOwners, name + ' stable retained owners');
        results.push({
          workload: name,
          side: side.label,
          sample,
          window: sample < 4 ? 'early' : 'later',
          batchWallMs,
          ...result,
          cachedArtifacts: translations.length,
          cachedBytes: translations.reduce((sum, m) => sum + m.byteLength, 0),
        });
      }
    } finally {
      cpu.dispose();
    }
  }
  return { definitions, samples: results };
}

export async function measureReusePair(sides, knobs) {
  const definitions = [],
    samples = [],
    schedule = [];
  for (const workload of knobs.workloads ?? reuseNames)
    for (let sample = 0; sample < knobs.samples; sample++) {
      const order = (sample % 2) ^ Number(knobs.reverse ?? false) ? [1, 0] : [0, 1];
      for (const index of order) {
        const side = sides[index];
        const result = await measureReuse(side, {
          ...knobs,
          samples: 1,
          workloads: [workload],
          requireReuse: side.label === 'current' && !knobs.baselineControl,
        });
        if (sample === 0)
          definitions.push(...result.definitions.map((row) => ({ ...row, side: side.label })));
        samples.push({ ...result.samples[0], sample, window: sample < 4 ? 'early' : 'later' });
        schedule.push({ workload, sample, side: side.label });
      }
    }
  return {
    definitions,
    samples,
    schedule,
    pairedSchedule:
      'Independent untimed warm-up per sample. Alternate A/B then B/A; reverse flips first order. Rearm preserves code, tables, mapping and returned context.',
  };
}
