import {
  using,
  snapshot,
  initial,
  outcome,
  debug,
  fullState,
  same,
  equal,
  image,
  encoded,
  gate,
  withGate,
  loadedCode,
  loadedData,
  CODE64,
  CODE32,
  DATA32,
  FILL,
  STACK,
  guarded,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function boundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'software wrapped V86 return reads nine individually checked slots across the16-bit stack boundary',
      async run() {
        const execution = snapshot('protected', 0, true, false);
        execution.segments.ss = loadedData(16);
        const values = [
          0x1234n,
          0x1000n,
          0x23703n,
          0xabcd7020n,
          0x2000n,
          0x3000n,
          0x4000n,
          0x5000n,
          0x6000n,
        ];
        const frame = image(values, 4);
        await using(
          compiler,
          'cf',
          execution,
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            const before = initial(0x1000n, { 4: 0x11223344abcdfff0n });
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'budget', 1n, 1n);
            fullState(result, before, 0x1234n, 0xabcd7020n, 0x3703n);
            equal(cpu.readContext().mode, 'virtual8086', 'complete wrapped VM frame');
            same(cpu.readMemory(0xfff0n, 16), frame.slice(0, 16), 'high source slots unchanged');
            same(cpu.readMemory(0n, 20), frame.slice(16), 'wrapped source slots unchanged');
            numeric();
          },
          {
            data: [
              { base: 0xfff0n, bytes: encoded(frame.slice(0, 16)), write: false },
              { base: 0n, bytes: encoded(frame.slice(16)), write: false },
            ],
          },
        );
      },
    },
    {
      name: 'software return slot geometry is nonwrapping and earlier private reads beat later geometry failures',
      async run() {
        const execution = snapshot('protected');
        execution.segments.ss.limit = 0x6003;
        await using(compiler, 'cf', execution, async (cpu) => {
          const numeric = preserveNumeric(cpu);
          const before = initial(0x1000n, { 4: 0x6000n }, 0x10002n);
          cpu.setState(before);
          const result = await cpu.run({ budget: 1n });
          outcome(result, 'data-fault', 1n, 0n);
          same(result.state, { ...before, flags: 2n }, 'incremental first-slot failure');
          equal(result.fault?.address, 0x6000n, 'first IP read wins');
          equal(result.segmentFault, undefined, 'later CS-slot limit not prechecked');
          numeric();
        });
        for (const width of [2, 4]) {
          const source = snapshot('protected', 0, true, false);
          source.segments.ss = loadedData(16);
          const start = 0x10000n - BigInt(width - 1);
          await using(
            compiler,
            `${width === 2 ? '66' : ''}cf`,
            source,
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              const before = initial(0x1000n, { 4: start });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              outcome(result, 'segment-fault', 1n, 0n);
              same(result.state, before, 'a slot cannot wrap inside its bytes');
              equal(result.segmentFault?.offset, start, 'whole slot start');
              equal(result.segmentFault?.width, width, 'whole slot width');
              equal(result.segmentFault?.failingOffset, 0x10000n, 'first out-of-limit byte');
              numeric();
            },
            {
              data: [
                { base: start, bytes: '00'.repeat(width - 1), write: false },
                { base: 0n, bytes: '00', write: false },
              ],
            },
          );
        }
      },
    },
    {
      name: 'software long IRET can end its last source slot exactly at MAX and rejects the next-byte attempt atomically',
      async run() {
        for (const overflow of [false, true]) {
          const execution = snapshot();
          const frame = image([0x3000n, 0x18n, 2n, 0x7000n, 0x20n], 8);
          const start = 0xffffffffffffffffn - BigInt(overflow ? 38 : 39);
          await using(
            compiler,
            '48cf',
            execution,
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              const before = initial(0x1000n, { 4: start });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              outcome(result, overflow ? 'data-fault' : 'budget', 1n, overflow ? 0n : 1n);
              if (overflow) {
                same(result.state, before, 'last slot admission aborts complete return');
                same(cpu.readContext(), execution, 'old context retained');
                equal(result.fault?.cause, 'address-range', 'private widened endpoint');
                equal(result.fault?.address, 0xfffffffffffffff9n, 'last SS slot start');
                equal(result.fault?.failingAddress, 1n << 64n, 'exact domain endpoint');
              } else fullState(result, before, 0x3000n, 0x7000n, 2n);
              same(
                cpu.readMemory(start, overflow ? 39 : 40),
                frame.slice(0, overflow ? 39 : 40),
                'source and boundary bytes unchanged',
              );
              numeric();
            },
            {
              data: [
                { base: 0x4018n, bytes: CODE64 + DATA32, write: false },
                { base: start, bytes: encoded(frame.slice(0, overflow ? 39 : 40)), write: false },
              ],
            },
          );
        }
      },
    },
    {
      name: 'software outer IRET invalidates null-but-usable high-DPL FS GS while retaining wide hidden facts',
      async run() {
        const execution = snapshot();
        for (const [index, name] of ['fs', 'gs'].entries()) {
          const key = name as 'fs' | 'gs';
          execution.segments[key] = {
            ...execution.segments[key],
            selector: 0,
            usable: true,
            dpl: 3,
            base: 0xffff800000001000n + BigInt(index) * 0x1000n,
          };
        }
        const frame = image([0x3000n, 0x1bn, 2n, 0x7000n, 0x23n], 8);
        await using(
          compiler,
          '48cf',
          execution,
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            const before = initial(0x1000n, { 4: 0x7000n });
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'budget', 1n, 1n);
            fullState(result, before, 0x3000n, 0x7000n);
            const segments = {
              ...execution.segments,
              cs: loadedCode(32, 0x1b, 3),
              ss: loadedData(32, 0x23, 3),
            };
            for (const name of ['ds', 'es', 'fs', 'gs'] as const)
              segments[name] = { ...segments[name], selector: 0, usable: false };
            const expected = { ...execution, mode: 'compatibility' as const, cpl: 3, segments };
            same(
              cpu.readContext(),
              expected,
              'null selector is an independent IRET cleanup predicate',
            );
            cpu.setContext(cpu.readContext());
            same(cpu.readContext(), expected, 'wide hidden facts roundtrip');
            numeric();
          },
          {
            data: [
              { base: 0x4018n, bytes: 'ffff000000fbcf00ffff000000f3cf00', write: false },
              { base: 0x7000n, bytes: encoded(frame), write: false },
            ],
          },
        );
      },
    },
    {
      name: 'software unchanged-context INT IRET loops retain bounded warmed artifacts without replay or recompilation',
      async run() {
        const execution = snapshot();
        execution.segments.cs = loadedCode(64);
        execution.segments.ss = loadedData(32);
        const address = withGate(execution);
        await using(
          compiler,
          'cd40ebfc',
          execution,
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            const before = initial(0x1000n, { 4: 0x7020n });
            cpu.setState(before);
            const warm = await cpu.run({ budget: 3n });
            outcome(warm, 'budget', 3n, 3n);
            same(warm.state, before, 'whole first round trip');
            const owners = cpu.inspectTranslations();
            for (let round = 0; round < 8; round++) {
              const result = await cpu.run({ budget: 3n });
              outcome(result, 'budget', 3n, 3n);
              same(result.state, before, 'whole repeated round trip');
              same(cpu.readContext(), execution, 'no spurious context generation');
              equal(result.resources.compilations, 0, 'warm variants retained');
              equal(
                result.resources.cachedArtifacts,
                warm.resources.cachedArtifacts,
                'artifact count bounded',
              );
              equal(
                result.resources.cachedBytes,
                warm.resources.cachedBytes,
                'artifact bytes bounded',
              );
              same(cpu.inspectTranslations(), owners, 'stable owner identities');
              guarded(cpu, STACK, FILL, [[0x6ff8n, image([0x1002n, 8n, 2n, 0x7020n, 16n], 8)]]);
              numeric();
            }
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE64 + DATA32, write: false },
              { base: address, bytes: gate(64, 8, 0x2000n, 0), write: false },
              { base: 0x2000n, bytes: '48cf', execute: true },
              { base: STACK, bytes: FILL },
            ],
          },
        );
      },
    },
    {
      name: 'software one public run crosses INT and IRET TF changes before stepping the resumed NOP',
      async run() {
        for (const mode of ['protected', 'long64'] as const) {
          const execution = snapshot(mode);
          const long = mode === 'long64';
          execution.segments.cs = loadedCode(long ? 64 : 32, 0x18);
          execution.segments.ss = loadedData(32);
          const address = withGate(execution);
          await using(
            compiler,
            'cd4090',
            execution,
            async (cpu) => {
              const numeric = preserveNumeric(cpu);
              const before = initial(0x1000n, { 4: 0x7020n }, 0x302n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 3n, repeatBudget: 41n, stop: 0x1003n });
              outcome(result, 'debug-exception', 3n, 3n, 41n);
              debug(result, 0x1002n, 0x1003n, true, 0x302n);
              same(
                result.state,
                { ...before, rip: 0x1003n },
                'INT does not step, IRET restores TF, resumed NOP steps',
              );
              same(
                cpu.readContext(),
                execution,
                'both loaded-code handoffs completed in the same run',
              );
              const slots = [0x1002n, 0x18n, 0x302n];
              if (long) slots.push(0x7020n, 16n);
              const frame = image(slots, long ? 8 : 4);
              guarded(cpu, STACK, FILL, [[long ? 0x6ff8n : 0x7014n, frame]]);
              const gated = await cpu.run({ budget: 0n });
              same(gated.state, result.state, 'observation does not replay any transition');
              equal(gated.debugException, undefined, 'completed trap is not redelivered');
              numeric();
            },
            {
              data: [
                {
                  base: 0x4008n,
                  bytes: (long ? CODE64 : CODE32) + DATA32 + (long ? CODE64 : CODE32),
                  write: false,
                },
                { base: address, bytes: gate(long ? 64 : 32, 8, 0x2000n, 0), write: false },
                { base: 0x2000n, bytes: long ? '48cf' : 'cf', execute: true },
                { base: STACK, bytes: FILL },
              ],
            },
          );
        }
      },
    },
  ];
}
