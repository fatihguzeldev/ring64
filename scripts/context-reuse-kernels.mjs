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
export const populationNames = [1, 8, 32, 128].flatMap((n) =>
  ['first', 'last', 'miss'].map((position) => `contexts-${n}-${position}`),
);
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
  for (const workload of knobs.workloads ?? (knobs.population ? populationNames : reuseNames))
    for (let sample = 0; sample < knobs.samples; sample++) {
      const order = (sample % 2) ^ Number(knobs.reverse ?? false) ? [1, 0] : [0, 1];
      for (const index of order) {
        const side = sides[index];
        const result = await (knobs.population ? measurePopulation : measureReuse)(side, {
          ...knobs,
          samples: knobs.population ? 1 : 2,
          workloads: [workload],
          requireReuse: side.label === 'current' && !knobs.baselineControl,
        });
        if (sample === 0)
          definitions.push(...result.definitions.map((row) => ({ ...row, side: side.label })));
        samples.push(
          ...result.samples.map((row, batch) => ({
            ...row,
            replicate: sample,
            batch,
            sample: sample * result.samples.length + batch,
            window: knobs.population
              ? 'independent-warm-replicate'
              : batch === 0
                ? 'early-warm-batch'
                : 'later-warm-batch',
          })),
        );
        schedule.push({ workload, sample, side: side.label });
      }
    }
  return {
    definitions,
    samples,
    schedule,
    pairedSchedule:
      'Independent untimed warm-up per replicate. Reuse replicates contain two consecutive measured batches on that CPU; population replicates contain one. Alternate A/B then B/A; reverse flips first order. Rearm preserves code, tables, mapping and returned context.',
  };
}

export async function measurePopulation(
  side,
  {
    iterations = 101,
    samples = 7,
    workloads = populationNames,
    requireReuse = false,
    onPhase,
  } = {},
) {
  const definitions = [],
    results = [],
    n = Math.min(iterations, 101);
  for (const name of workloads) {
    if (!populationNames.includes(name)) throw Error('unknown population workload');
    const [, count, position] = name.split('-'),
      population = Number(count);
    const bytes = new Uint8Array((population + n * samples + 1) * 8);
    for (let i = 0; i < bytes.length / 8; i++)
      for (let j = 0; j < 8; j++)
        bytes[i * 8 + j] = Number((BigInt(i + 1) >> BigInt(j * 8)) & 255n);
    const cpu = await side.createCpu({
      compiler: side.compiler,
      code: { base: 0x1000n, bytes: Uint8Array.of(0x64, 0x48, 0x8b, 0x03, 0x82) },
      ram: { base: 0x4000n, bytes },
      limits: {
        maxInstructions: 1,
        maxSourceBytes: 32,
        maxArtifactBytes: 16384,
        maxCachedArtifacts: population,
        maxCachedBytes: 4194304,
        maxTranslationsPerRun: 1,
      },
    });
    try {
      const context = cpu.readContext(),
        initial = { rip: 0x1000n, flags: 2n, registers: Array(16).fill(0n) };
      const select = (index) =>
        cpu.setContext({
          ...context,
          segments: {
            ...context.segments,
            fs: { ...context.segments.fs, base: 0x4000n + BigInt(index * 8) },
          },
        });
      const check = (r, index) => {
        equal(r.reason, 'budget', name + ' reason');
        equal(r.retired, 1n, name + ' work');
        equal(r.state.registers, [BigInt(index + 1), ...Array(15).fill(0n)], name + ' full GPR');
        equal(r.state.flags, 2n, name + ' flags');
        equal(r.state.rip, 0x1004n, name + ' RIP');
      };
      onPhase?.('warm-up');
      for (let i = 0; i < population; i++) {
        select(i);
        cpu.setState(initial);
        check(await cpu.run({ budget: 1n }), i);
      }
      const target = position === 'first' ? population - 1 : 0;
      if (position !== 'miss') {
        select(target);
        cpu.setState(initial);
        check(await cpu.run({ budget: 1n }), target);
      }
      definitions.push({
        name,
        population,
        position,
        iterations: n,
        instructions: n,
        work: n,
        workUnit: 'one-instruction Cpu.run',
        cap: population,
        timing:
          'elapsedMs sums Cpu.run only; batchWallMs includes host rearming/assertions and miss-context selection. Context selection is outside elapsedMs; priming and full RAM guard are outside both. first/last describe newest-first candidate order, not global LRU.',
      });
      for (let sample = 0; sample < samples; sample++) {
        onPhase?.('measured');
        let elapsedMs = 0;
        const resources = {},
          began = performance.now();
        for (let i = 0; i < n; i++) {
          const index = position === 'miss' ? population + sample * n + i : target;
          if (position === 'miss') select(index);
          cpu.setState(initial);
          const at = performance.now(),
            r = await cpu.run({ budget: 1n });
          elapsedMs += performance.now() - at;
          check(r, index);
          for (const [key, value] of Object.entries(r.resources))
            if (typeof value === 'number' && !key.startsWith('cached'))
              resources[key] = (resources[key] ?? 0) + value;
        }
        const batchWallMs = performance.now() - began;
        equal([...cpu.readMemory(0x4000n, bytes.length)], [...bytes], name + ' data unchanged');
        const translations = cpu.inspectTranslations();
        if (translations.length > population) throw Error(name + ': global cap exceeded');
        if (requireReuse && position !== 'miss' && resources.compilations !== 0)
          throw Error(name + ': hot variant recompiled');
        results.push({
          workload: name,
          side: side.label,
          sample,
          calls: n,
          retired: BigInt(n),
          elapsedMs,
          batchWallMs,
          resources,
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
