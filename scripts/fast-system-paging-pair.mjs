// Run the predecessor's unchanged literal kernels; only scheduling/timing adaptation lives here.
export async function measurePagingPair(sides, measurePaging, pagingNames, knobs) {
  const definitions = [],
    samples = [],
    schedule = [];
  for (const name of knobs.workloads ?? pagingNames) {
    const completed = [0, 0],
      waiting = [[], []],
      calls = [[], []],
      creations = [[], []];
    let owner, failure;
    const expected = () =>
      completed[0] === completed[1]
        ? (completed[0] % 2) ^ Number(knobs.reverse ?? false)
        : completed[0] < completed[1]
          ? 0
          : 1;
    const drain = () => {
      if (owner === undefined) {
        const next = expected();
        if (waiting[next].length) {
          owner = next;
          schedule.push({ workload: name, sample: completed[next], side: sides[next].label });
          waiting[next].shift().resolve();
        }
      }
    };
    const acquire = (side) => {
      if (failure) return Promise.reject(failure);
      if (owner === side) return undefined;
      const permit = new Promise((resolve, reject) => waiting[side].push({ resolve, reject }));
      drain();
      return permit;
    };
    const abort = (error) => {
      failure = error;
      waiting.flat().forEach((item) => item.reject(error));
    };
    const results = await Promise.all(
      sides.map(async (side, index) => {
        let cpuId = 0;
        const wrapped = {
          ...side,
          createCpu: async (options) => {
            // Do not instantiate/reset the second side while the first side's cold run awaits
            // compilation. This permit is held through the entire sample, including setup.
            const queued = performance.now(),
              permit = acquire(index);
            if (permit) await permit;
            const began = performance.now();
            const cpu = await side.createCpu(options),
              id = ++cpuId;
            creations[index].push({ elapsedMs: performance.now() - began, waitMs: began - queued });
            return new Proxy(cpu, {
              get(target, property) {
                if (property === 'run')
                  return async (...args) => {
                    const queued = performance.now(),
                      permit = acquire(index);
                    if (permit) await permit;
                    const began = performance.now();
                    const result = await target.run(...args);
                    calls[index].push({
                      cpuId: id,
                      waitMs: began - queued,
                      elapsedMs: performance.now() - began,
                      resources: result.resources,
                    });
                    return result;
                  };
                if (property === 'inspectTranslations')
                  return (...args) => {
                    const result = target.inspectTranslations(...args);
                    if (owner !== index)
                      throw Error('paging sample released the wrong scheduling owner');
                    completed[index]++;
                    owner = undefined;
                    drain();
                    return result;
                  };
                const result = Reflect.get(target, property, target);
                return typeof result === 'function' ? result.bind(target) : result;
              },
            });
          },
        };
        try {
          return await measurePaging(wrapped, { ...knobs, workloads: [name] });
        } catch (error) {
          abort(error);
          throw error;
        }
      }),
    );
    if (completed[0] !== knobs.samples || completed[1] !== knobs.samples)
      throw Error('paired paging sample counts differ');
    if (JSON.stringify(results[0].definitions) !== JSON.stringify(results[1].definitions))
      throw Error('paired paging workload definitions differ');
    definitions.push(
      ...results[0].definitions.map((definition) =>
        definition.prewarmedArtifact
          ? {
              ...definition,
              predecessorPairedSchedule: definition.pairedSchedule,
              predecessorLeafComparison: definition.leafComparison,
              pairedSchedule:
                'Within this one leaf workload, baseline/current samples alternate A/B then B/A; --reverse flips the first order. Warm/cold workloads are separate rows here. Each sample has an independent untimed prewarm.',
              leafComparison:
                'Per-leaf baseline/current build comparison; no isolated warm-versus-cold latency comparison is claimed by this driver.',
            }
          : definition,
      ),
    );
    for (let index = 0; index < sides.length; index++) {
      const definition = results[index].definitions[0],
        seen = new Set();
      const measured = calls[index].filter((call) => {
        const first = !seen.has(call.cpuId);
        seen.add(call.cpuId);
        if (definition.prewarmedArtifact && first) {
          if (call.resources.compilations !== 1)
            throw Error('leaf warmup was not an independent untimed compilation');
          return false;
        }
        return true;
      });
      let cursor = 0;
      for (const sample of results[index].samples) {
        const creation = creations[index][definition.prewarmedArtifact ? sample.sample : 0];
        if (!creation) throw Error('sample CPU creation was not recorded');
        const group = measured.slice(cursor, cursor + sample.calls);
        cursor += sample.calls;
        if (group.length !== sample.calls)
          throw Error('paired timing call count differs from literal kernel');
        const elapsedMs = group.reduce((sum, call) => sum + call.elapsedMs, 0),
          waitMs = group.reduce((sum, call) => sum + call.waitMs, 0);
        samples.push({
          ...sample,
          driverQueuedElapsedMs: sample.elapsedMs,
          driverQueuedWallMs: sample.wallMs,
          driverQueuedCreationMs: sample.creationMs,
          schedulerCreationWaitMs: creation.waitMs,
          schedulerWaitMs: waitMs,
          elapsedMs,
          wallMs: sample.wallMs - waitMs,
          creationMs: creation.elapsedMs,
        });
      }
      if (cursor !== measured.length) throw Error('unattributed measured paging calls');
    }
  }
  samples.sort(
    (a, b) =>
      a.workload.localeCompare(b.workload) || a.sample - b.sample || a.side.localeCompare(b.side),
  );
  return {
    definitions,
    samples,
    schedule,
    reverse: knobs.reverse ?? false,
    timing:
      'Unchanged predecessor kernels retain one CPU/artifact across regular samples and independent prewarmed leaf samples. Whole samples alternate A/B then B/A; CPU creation and run timers are measured inside the permit, excluding scheduler wait. A proxy adds one symmetric await around Cpu.run. Original queued elapsed/wall/creation and explicit waits are retained; wallMs subtracts run wait and includes per-cycle reset/guards. Untimed leaf warmups are excluded by per-CPU identity, not guessed from elapsed time.',
  };
}
