import { measureCallGates } from './call-gate-kernels.mjs';

const stable = (value) =>
  JSON.stringify(value, (_, item) =>
    typeof item === 'bigint'
      ? item.toString()
      : item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
        : item,
  );
function equal(actual, expected, label) {
  if (stable(actual) !== stable(expected)) throw Error(`${label}: paired values differ`);
}
const omit = (value, names) =>
  Object.fromEntries(Object.entries(value).filter(([key]) => !names.includes(key)));

export async function measureCallGatesPair(sides, knobs) {
  if (sides.length !== 2) throw Error('call-gate pairing requires exactly two sides');
  const definitions = [],
    samples = [],
    pairs = [],
    schedule = [];
  for (const workload of knobs.workloads) {
    const completed = [0, 0],
      waiting = [[], []],
      creation = [],
      extra = [[], []];
    let owner, failure;
    const event = (index, kind, fields = {}) =>
      schedule.push({
        workload,
        sample: completed[index] - 1,
        side: sides[index].label,
        event: kind,
        atMs: performance.now(),
        ...fields,
      });
    const expected = () =>
      completed[0] === completed[1]
        ? (completed[0] % 2) ^ Number(knobs.reverse ?? false)
        : completed[0] < completed[1]
          ? 0
          : 1;
    const drain = () => {
      if (owner !== undefined || failure) return;
      const next = expected(),
        pending = waiting[next].shift();
      if (pending) {
        owner = next;
        event(next, 'grant');
        pending.resolve();
      }
    };
    const acquire = (index) => {
      if (failure) return Promise.reject(failure);
      if (owner === index) return undefined;
      event(index, 'request');
      const pending = new Promise((resolve, reject) => waiting[index].push({ resolve, reject }));
      drain();
      return pending;
    };
    const release = (index, sample, afterDispose = false) => {
      if (owner !== index) throw Error('call-gate sample released the wrong permit');
      event(index, 'release', { sample, afterDispose });
      owner = undefined;
      drain();
    };
    const abort = (error) => {
      failure ??= error;
      for (const item of waiting.flat()) item.reject(failure);
    };
    const results = await Promise.all(
      sides.map(async (side, index) => {
        try {
          // Acquire before invoking the kernel so other-side fixture allocation is gated too.
          const pending = acquire(index);
          if (pending) await pending;
          const wrapped = {
            ...side,
            createCpu: async (options) => {
              if (owner !== index) throw Error('CPU creation lacks its sample permit');
              event(index, 'creation-before');
              const at = performance.now(),
                cpu = await side.createCpu(options);
              creation[index] = { elapsedMs: performance.now() - at };
              event(index, 'creation-after');
              return cpu;
            },
          };
          const output = await measureCallGates(wrapped, {
            ...knobs,
            workloads: [workload],
            onSample: async (phase, packet) => {
              if (packet.sample !== completed[index] - 1)
                throw Error('call-gate sample ordinal changed');
              if (phase === 'before') {
                const pending = acquire(index);
                if (pending) await pending;
                event(index, 'sample-before');
              } else if (owner !== index) throw Error('call-gate guards ran outside their permit');
              const validateTime = index === 1 || knobs.aa;
              let time;
              if (validateTime) {
                const ticks =
                  BigInt(completed[index] + Number(phase === 'after')) *
                  packet.definition.effectiveWork.retiredInstructions;
                time = packet.cpu.readTimeState();
                equal(
                  time,
                  { tsc: BigInt.asUintN(64, ticks), tscAux: 0 },
                  `${workload} ${packet.sample} ${phase} time`,
                );
              }
              if (phase === 'after') {
                extra[index].push({
                  sample: packet.sample,
                  time,
                  timeValidated: validateTime,
                  translations: packet.cpu.inspectTranslations(),
                });
                event(index, 'guards-complete');
                completed[index]++;
                // Keep the final permit through the kernel's finally/dispose work.
                if (packet.sample !== knobs.samples - 1) release(index, packet.sample);
              }
            },
          });
          release(index, knobs.samples - 1, true);
          return output;
        } catch (error) {
          abort(error);
          throw error;
        }
      }),
    );
    equal(completed, [knobs.samples + 1, knobs.samples + 1], `${workload} completed sample counts`);
    equal(results[0].definitions, results[1].definitions, `${workload} literal definitions`);
    definitions.push(
      ...results[0].definitions.map((row) => ({
        ...row,
        predecessorKernelCeiling: row.ceiling,
        ceiling:
          'Inherited paired call-gate execution; both sides complete the same literal contract. No Unsupported denominator, native-cycle or application-throughput claim.',
        pairedSchedule:
          'Per-leaf whole samples alternate A/B then B/A, including first sample-1; reverse flips the initial order. CPU/fixture creation and final disposal hold the sample permit.',
      })),
    );
    for (let sample = -1; sample < knobs.samples; sample++) {
      const pair = results.map((result, index) => {
        const row = result.samples.find((row) => row.sample === sample),
          details = extra[index].find((row) => row.sample === sample);
        if (!row || !details) throw Error('missing paired call-gate sample');
        return {
          ...row,
          side: sides[index].label,
          kernelCreationMs: row.creationMs,
          creationMs: creation[index].elapsedMs,
          ...omit(details, ['sample']),
        };
      });
      const comparable = (row) => ({
        ...omit(row, [
          'side',
          'creationMs',
          'kernelCreationMs',
          'elapsedMs',
          'wallMs',
          'timings',
          'time',
          'timeValidated',
          'translations',
          'resources',
          'finalGauge',
        ]),
        resources: omit(row.resources, ['generatedBytes']),
        finalGauge: omit(row.finalGauge, ['cachedBytes', 'generatedBytes']),
        translations: row.translations.map((unit) => omit(unit, ['byteLength', 'owner'])),
      });
      equal(
        comparable(pair[0]),
        comparable(pair[1]),
        `${workload} ${sample} work/resource/unit flow`,
      );
      samples.push(...pair);
      const denominator = pair[0].elapsedMs,
        numerator = pair[1].elapsedMs;
      pairs.push({
        workload,
        sample,
        direction: `${sides[1].label}/${sides[0].label}`,
        denominatorMs: denominator,
        numeratorMs: numerator,
        ratio: denominator === 0 ? null : numerator / denominator,
        ratioDefined: denominator !== 0,
      });
    }
  }
  return {
    definitions,
    samples,
    pairs,
    schedule,
    reverse: knobs.reverse ?? false,
    timing:
      'Kernel elapsedMs/wallMs are retained directly and start after permit acquisition; no queue subtraction or Cpu.run proxy. Entire setup/run/full guards/current time checks are serialized. creationMs measures actual own CPU creation inside the permit; kernelCreationMs is retained separately. Schedule timestamps include scheduler and guard work and are not native execution timers.',
    timeChecks:
      'Current (both A/A sides) only: default TSC0/AUX0 plus authored effectiveWork.retiredInstructions per completed sample, modulo64. Scalar rearming does not reset this bank. Baseline has no required TimeState API.',
    byteComparisons:
      'Preserve/report generatedBytes, cachedBytes and unit.byteLength growth; compare the remaining authored work/resource/unit flow. Private owner IDs are retained but not required to match across independent CPUs.',
  };
}
