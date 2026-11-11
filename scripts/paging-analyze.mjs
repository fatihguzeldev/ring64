import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { encode } from './paging-support.mjs';

const args = process.argv.slice(2),
  outputAt = args.indexOf('--output');
const output = outputAt < 0 ? undefined : resolve(args.splice(outputAt, 2)[1]);
if (!args.length) throw Error('provide benchmark JSON files, optionally --output FILE');
const median = (values) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b),
    middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const stable = (item) =>
  JSON.stringify(item, (_, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
const report = [];
for (const path of args) {
  const result = JSON.parse(await readFile(path, 'utf8'));
  const rows = result.definitions.map((definition) => {
    const group = (side) =>
      result.samples.filter(
        (sample) => sample.workload === definition.name && sample.side === side,
      );
    const window = (samples, name) => {
      const selected = samples.filter((sample) => sample.window === name);
      return {
        samples: selected.length,
        elapsedMs: median(selected.map((sample) => sample.elapsedMs)),
        phaseMediansMs: Object.fromEntries(
          ['translationMs', 'browserCompileMs', 'instantiationMs', 'executionMs', 'totalMs'].map(
            (key) => [
              key,
              median(
                selected
                  .map((sample) => sample.timings?.[key])
                  .filter((value) => value !== undefined),
              ),
            ],
          ),
        ),
      };
    };
    const summary = (samples) => {
      if (!samples.length) return null;
      const later = samples.filter((sample) => sample.window === 'later'),
        used = later.length ? later : samples;
      const calls = median(
        used.map(
          (sample) => sample.calls ?? (definition.resume ? Number(definition.instructions) : 1),
        ),
      );
      const retired = median(
        used.map((sample) =>
          Number(sample.retired ?? definition.retiredPerSample ?? definition.instructions ?? 0),
        ),
      );
      return {
        elapsedMs: median(used.map((sample) => sample.elapsedMs)),
        minMs: Math.min(...used.map((sample) => sample.elapsedMs)),
        maxMs: Math.max(...used.map((sample) => sample.elapsedMs)),
        zeroSamples: samples.filter((sample) => sample.elapsedMs === 0).length,
        subMillisecondSamples: samples.filter((sample) => sample.elapsedMs < 1).length,
        calls,
        retired,
        resources: used.map((sample) => sample.resources),
        creationMs: samples[0].creationMs,
        first: window(samples, 'first'),
        early: window(samples, 'early'),
        later: window(samples, 'later'),
      };
    };
    const before = group('baseline'),
      after = group('current'),
      baseline = summary(before),
      current = summary(after);
    const difference = baseline && current ? current.elapsedMs - baseline.elapsedMs : null;
    const resourceMismatches = before.flatMap((sample) => {
      const other = after.find((row) => row.sample === sample.sample);
      return !other || stable(sample.resources) !== stable(other.resources) ? [sample.sample] : [];
    });
    const outputs = [
      'state',
      'context',
      'xmm',
      'mxcsr',
      'x87',
      'debug',
      'retired',
      'repeatIterations',
      'deliveryAttempts',
    ];
    const outputMismatches = before.flatMap((sample) => {
      const other = after.find((row) => row.sample === sample.sample);
      return !other || outputs.some((field) => stable(sample[field]) !== stable(other[field]))
        ? [sample.sample]
        : [];
    });
    return {
      name: definition.name,
      definition,
      baseline,
      current,
      ratio: baseline?.elapsedMs > 0 && current ? current.elapsedMs / baseline.elapsedMs : null,
      deltaMs: difference,
      deltaNsPerRunCall:
        difference !== null && current.calls > 0 ? (difference * 1e6) / current.calls : null,
      deltaNsPerRetiredInstruction:
        difference !== null && current.retired > 0 ? (difference * 1e6) / current.retired : null,
      deltaNsPerDefinedWorkUnit:
        difference !== null && Number(definition.work) > 0
          ? (difference * 1e6) / Number(definition.work)
          : null,
      workUnit: definition.throughputUnit ?? definition.workUnit,
      resourceMismatches,
      outputMismatches,
    };
  });
  const ratios = rows
    .map((row) => row.ratio)
    .filter((ratio) => ratio !== null)
    .sort((a, b) => a - b);
  report.push({
    path: resolve(path),
    runtime: result.environment?.runtime ?? result.runtime,
    sides: result.sides ?? result.manifest,
    reverse: result.reverse ?? false,
    definitions: result.definitions.length,
    availablePairs: rows.filter((row) => row.baseline && row.current).length,
    unavailable: result.unavailable ?? [],
    ratioDistribution: {
      count: ratios.length,
      min: ratios[0],
      median: median(ratios),
      p10: ratios[Math.floor((ratios.length - 1) * 0.1)],
      p90: ratios[Math.floor((ratios.length - 1) * 0.9)],
      max: ratios.at(-1),
      geometricMean:
        ratios.length && ratios.every((ratio) => ratio > 0)
          ? Math.exp(ratios.reduce((sum, ratio) => sum + Math.log(ratio), 0) / ratios.length)
          : null,
    },
    zeroRows: rows
      .filter((row) => row.baseline?.zeroSamples || row.current?.zeroSamples)
      .map((row) => row.name),
    unavailableRatioRows: rows.filter((row) => row.ratio === null).map((row) => row.name),
    resourcesExactlyMatched: rows.some((row) => row.baseline && row.current)
      ? rows.every((row) => row.resourceMismatches.length === 0)
      : null,
    outputsExactlyMatched: rows.some((row) => row.baseline && row.current)
      ? rows.every((row) => row.outputMismatches.length === 0)
      : null,
    rows,
  });
}
const evidence = {
  at: new Date().toISOString(),
  methodology:
    'Ratio is current/baseline of later-window elapsed medians, falling back to all samples only when no later window exists. Zero baselines remain null. Resource/output equality compares every paired sample. ns denominators are explicitly separate; defined work units are not automatically helper operations or guest instructions. First completions and one reused CPU creation value are retained rather than claimed as independent cold starts.',
  cohorts: report,
};
if (output) await writeFile(output, encode(evidence));
for (const cohort of report)
  console.log(
    encode({
      file: cohort.path,
      availablePairs: cohort.availablePairs,
      ratioDistribution: cohort.ratioDistribution,
      resourcesExactlyMatched: cohort.resourcesExactlyMatched,
      outputsExactlyMatched: cohort.outputsExactlyMatched,
      worst: cohort.rows
        .filter((row) => row.ratio !== null)
        .sort((a, b) => b.ratio - a.ratio)
        .slice(0, 8)
        .map(({ name, ratio, deltaMs, deltaNsPerRunCall, deltaNsPerRetiredInstruction }) => ({
          name,
          ratio,
          deltaMs,
          deltaNsPerRunCall,
          deltaNsPerRetiredInstruction,
        })),
    }),
  );
