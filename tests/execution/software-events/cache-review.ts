import {
  using,
  snapshot,
  loadedCode,
  loadedData,
  withGate,
  gate,
  image,
  initial,
  outcome,
  fullState,
  guarded,
  preserveNumeric,
  same,
  equal,
  hex,
  CODE64,
  DATA32,
  STACK,
  FILL,
  type Scenario,
} from './fixture.js';

export function cacheReviewScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'software completed INT and IRET survive later translation refusal without replaying their frames',
      async run() {
        const execution = snapshot();
        execution.segments.cs = loadedCode(64, 0x18);
        execution.segments.ss = loadedData(32);
        const address = withGate(execution);
        const gateBytes = gate(64, 8, 0x2000n, 0);
        const frame = image([0x1002n, 0x18n, 2n, 0x7020n, 16n], 8);
        await using(
          compiler,
          'cd4090',
          execution,
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            const before = initial(0x1000n, { 4: 0x7020n }, 2n);
            cpu.setState(before);
            const entered = await cpu.run({ budget: 2n, repeatBudget: 11n });
            outcome(entered, 'resource-limit', 2n, 1n, 11n);
            fullState(entered, before, 0x2000n, 0x6ff8n, 2n);
            same(
              cpu.readContext(),
              { ...execution, segments: { ...execution.segments, cs: loadedCode(64) } },
              'handler context survives unavailable next translation',
            );
            const returned = await cpu.run({ budget: 2n, repeatBudget: 11n });
            outcome(returned, 'resource-limit', 2n, 1n, 11n);
            fullState(returned, before, 0x1002n, 0x7020n, 2n);
            same(cpu.readContext(), execution, 'returned context survives continuation refusal');
            for (const result of [entered, returned]) {
              equal(result.resources.compilations, 1, 'one admitted source translation');
              equal(result.resources.nativeEntries, 1, 'completed transfer entered once');
              equal(result.resources.dispatches, 1, 'transfer completed before refusal');
              equal(result.resources.cachedArtifacts, 0, 'changed-context source owner pruned');
            }
            guarded(cpu, STACK, FILL, [[0x6ff8n, frame]]);
            const resumed = await cpu.run({ budget: 1n, repeatBudget: 11n });
            outcome(resumed, 'budget', 1n, 1n, 11n);
            fullState(resumed, before, 0x1003n, 0x7020n, 2n);
            same(cpu.readContext(), execution, 'resumed NOP does not repeat a handoff');
            guarded(cpu, STACK, FILL, [[0x6ff8n, frame]]);
            same(cpu.readMemory(0x1000n, 3), hex('cd4090'), 'caller source retained');
            same(
              cpu.readMemory(0x4008n, 24),
              hex(CODE64 + DATA32 + CODE64),
              'descriptors retained',
            );
            same(cpu.readMemory(address, 16), hex(gateBytes), 'gate retained');
            numeric();
          },
          {
            limits: { maxTranslationsPerRun: 1 },
            data: [
              { base: 0x4008n, bytes: CODE64 + DATA32 + CODE64, write: false },
              { base: address, bytes: gateBytes, write: false },
              { base: 0x2000n, bytes: '48cf', execute: true },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
  ];
}
