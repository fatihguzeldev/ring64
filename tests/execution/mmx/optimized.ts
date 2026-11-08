import { createCpu } from '../../../host/index.js';
import { LIMITS } from '../../support/fixture.js';
import {
  LONG,
  input,
  changed,
  outcome,
  stack,
  clone,
  seed,
  other,
  x87,
  banks,
  xmm,
  equal,
  using,
  noFault,
  pending,
  ONE,
  NUMERIC_STATUS,
  hex,
  memory,
  type Scenario,
} from '../x87/fixture.js';

const MASK64 = (1n << 64n) - 1n;
function integerResult(before: ReturnType<typeof stack>, destination: number, value: bigint) {
  const after = clone(before);
  after.statusWord &= ~0x3800;
  after.tagWord = 0;
  after.registers[destination] = (0xffffn << 64n) | value;
  return after;
}

export function optimizedScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'MMX packs and unpacks use 64-bit halves without importing unused SIMD lanes',
      async run() {
        const packets: [string, bigint, bigint, bigint][] = [
          ['0f6bc1', 0x00008000ffff7fffn, 0x00007fffffff8000n, 0x7fff80007fff8000n],
          ['0f67c1', 0xffff000100ff0100n, 0x7fff0080007f0000n, 0xff807f000001ffffn],
          ['0f60c1', 0x0807060504030201n, 0x1817161514131211n, 0x1404130312021101n],
          ['0f68c1', 0x0807060504030201n, 0x1817161514131211n, 0x1808170716061505n],
          ['0f61c1', 0x4444333322221111n, 0xddddccccbbbbaaaan, 0xbbbb2222aaaa1111n],
          ['0f69c1', 0x4444333322221111n, 0xddddccccbbbbaaaan, 0xdddd4444cccc3333n],
          ['0f62c1', 0x2222222211111111n, 0xbbbbbbbbaaaaaaaan, 0xaaaaaaaa11111111n],
          ['0f6ac1', 0x2222222211111111n, 0xbbbbbbbbaaaaaaaan, 0xbbbbbbbb22222222n],
          ['0f63c0', 0x0080ff7f007fff80n, 0n, 0x7f807f807f807f80n],
        ];
        for (const [code, left, right, expected] of packets)
          await using(compiler, code, LONG, async (cpu) => {
            const before = input(),
              numeric = stack({}, 5, 0x0f7f, 0x4700);
            numeric.registers[0] = (0x1234n << 64n) | left;
            numeric.registers[1] = (0x5678n << 64n) | right;
            cpu.setState(before);
            seed(cpu, numeric);
            const result = await cpu.run({ budget: 1n, repeatBudget: 13n });
            outcome(result, 'budget', 1n, 1n, 13n, 0n, changed(before, 0x1003n));
            x87(cpu, integerResult(numeric, 0, expected));
            other(cpu);
            noFault(result);
          });
      },
    },
    {
      name: 'MMX integer paths and SIMD conversion helpers exchange live sources and partial destinations',
      async run() {
        // MOVDQA XMM1,XMM4; MOVD MM0,EAX; CVTPI2PS XMM1,MM0;
        // MOVQ2DQ XMM2,MM0; PXOR MM0,MM0; CVTPS2PI MM3,XMM1; PADDW MM3,MM0.
        const code = '660f6fcc0f6ec00f2ac8f30fd6d00fefc00f2dd90ffdd8';
        await using(compiler, code, LONG, async (cpu) => {
          const before = input(0x1000n, { 0: 0xfeedbeef01000001n });
          const numeric = stack({}, 5),
            vector = banks();
          cpu.setState(before);
          cpu.setX87State(numeric);
          cpu.setXmmState(vector);
          cpu.setMxcsr(0x1f80);
          const result = await cpu.run({ budget: 7n, repeatBudget: 11n });
          outcome(result, 'budget', 7n, 7n, 11n, 0n, changed(before, 0x1017n));
          vector[1] = (vector[4]! & ~MASK64) | 0x4b800000n;
          vector[2] = 0x01000001n;
          xmm(cpu, vector);
          const after = integerResult(numeric, 0, 0n);
          after.registers[3] = (0xffffn << 64n) | 0x01000000n;
          x87(cpu, after);
          equal(cpu.readMxcsr(), 0x1fa0, 'paired conversion precision status');
          noFault(result);
        });
      },
    },
    {
      name: 'unmasked MMX conversions preserve completed integer predecessors and repair at the cached helper',
      async run() {
        await using(compiler, '0f6ec00f2ac80fefc0', LONG, async (cpu) => {
          const before = input(0x1000n, { 0: 0xfeedbeef01000001n });
          const numeric = stack({}, 5),
            vector = banks();
          cpu.setState(before);
          cpu.setX87State(numeric);
          cpu.setXmmState(vector);
          cpu.setMxcsr(0x0f80);
          const failed = await cpu.run({ budget: 3n, repeatBudget: 7n });
          outcome(failed, 'simd-exception', 3n, 1n, 7n, 0n, changed(before, 0x1003n));
          x87(cpu, integerResult(numeric, 0, 0x01000001n));
          xmm(cpu, vector);
          equal(failed.simdException?.stage, 'post-computation', 'precision exception stage');
          equal(failed.simdException?.raised, 0x20, 'precision condition');
          equal(cpu.readMxcsr(), 0x0fa0, 'precision sticky before repair');
          equal(failed.x87Exception, undefined, 'exclusive SIMD exception');
          equal(failed.fault, undefined, 'no data fault');

          cpu.setMxcsr(0x1fa0);
          const resumed = await cpu.run({ budget: 2n, repeatBudget: 7n });
          outcome(resumed, 'budget', 2n, 2n, 7n, 0n, changed(before, 0x1009n));
          vector[1] = (vector[1]! & ~MASK64) | 0x4b800000n;
          xmm(cpu, vector);
          x87(cpu, integerResult(numeric, 0, 0n));
          equal(cpu.readMxcsr(), 0x1fa0, 'sticky precision survives repair');
          equal(resumed.resources.compilations, 0, 'conversion repair keeps compiled successor');
          noFault(resumed);
        });
      },
    },
    {
      name: 'standalone EMMS preserves raw banks and hands a coherent empty stack to x87 and back',
      async run() {
        await using(compiler, '0f77d9e80f6ff7', LONG, async (cpu) => {
          const before = input(),
            numeric = stack({}, 5, 0x37f, 0x4700);
          cpu.setState(before);
          seed(cpu, numeric);
          const empty = await cpu.run({ budget: 1n });
          outcome(empty, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
          const after = clone(numeric);
          after.statusWord &= ~0x3800;
          x87(cpu, after);
          other(cpu);
          noFault(empty);

          const pushed = await cpu.run({ budget: 1n });
          outcome(pushed, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1004n));
          after.registers[7] = ONE;
          after.tagWord = 0x3fff;
          after.statusWord = (after.statusWord & ~0x3a00) | 0x3800;
          after.instructionPointer = 0x1002n;
          x87(cpu, after, NUMERIC_STATUS);
          other(cpu);
          noFault(pushed);

          const copied = await cpu.run({ budget: 1n });
          outcome(copied, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1007n));
          x87(cpu, integerResult(after, 6, 0x8000000000000000n), NUMERIC_STATUS);
          other(cpu);
          noFault(copied);
          equal(copied.resources.compilations, 0, 'retained MMX successor');
        });
      },
    },
    {
      name: 'MMX stores commit numeric state before invalidating a compiled successor through a write-only alias',
      async run() {
        for (const budget of [1n, 2n]) {
          const original = '0f7f03b811000000909090',
            rewritten = '0f7f03b82a000000909090';
          const cpu = await createCpu({
            compiler,
            limits: LIMITS,
            context: LONG,
            entry: 0x1000n,
            memoryLimits: { maxBackings: 1, maxMappings: 3, maxBackingBytes: 13 },
            memory: {
              backings: [{ id: 'source', bytes: hex('a5' + original + 'a5') }],
              mappings: [
                {
                  base: 0x1000n,
                  backing: 'source',
                  offset: 1,
                  length: 11,
                  permissions: { read: true, write: false, execute: true },
                },
                {
                  base: 0x6000n,
                  backing: 'source',
                  offset: 4,
                  length: 8,
                  permissions: { read: false, write: true, execute: false },
                },
                {
                  base: 0x8000n,
                  backing: 'source',
                  offset: 0,
                  length: 13,
                  permissions: { read: true, write: false, execute: false },
                },
              ],
            },
          });
          try {
            const before = input(0x1000n, { 3: 0x6000n }),
              numeric = stack({}, 5),
              after = clone(numeric);
            numeric.registers[0] = 0x12349090900000002ab8n;
            after.registers[0] = numeric.registers[0];
            after.statusWord &= ~0x3800;
            after.tagWord = 0;
            cpu.setState(before);
            seed(cpu, numeric);
            const result = await cpu.run({ budget, repeatBudget: 17n });
            const state = changed(before, budget === 1n ? 0x1003n : 0x1008n);
            if (budget === 2n) state.registers[0] = 42n;
            outcome(result, 'budget', budget, budget, 17n, 0n, state);
            x87(cpu, after);
            other(cpu);
            noFault(result);
            memory(cpu, 0x8000n, 'a5' + rewritten + 'a5');
            equal(
              result.resources.dispatches,
              budget === 1n ? 0 : 1,
              'retirement precedes dispatch',
            );
            equal(result.resources.nativeEntries, Number(budget), 'modified successor entry');
            equal(
              result.resources.compilations,
              Number(budget),
              'invalidated successor compilation',
            );
            equal(
              result.resources.cachedArtifacts,
              budget === 1n ? 0 : 1,
              'invalidated source owner',
            );
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'retained MMX entries recheck changed pending state and use values repaired by a guest helper',
      async run() {
        await using(compiler, '0f6fc10f77dbe20f6fd1', LONG, async (cpu) => {
          const before = input(),
            initial = stack({}, 3);
          initial.registers[1] = 0x12341122334455667788n;
          cpu.setState(before);
          seed(cpu, initial);
          const first = await cpu.run({ budget: 1n });
          outcome(first, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1003n));
          x87(cpu, integerResult(initial, 0, initial.registers[1]! & MASK64));
          noFault(first);

          const numeric = stack({}, 5, 0x37b, 0x8084);
          numeric.registers[1] = 0x56788877665544332211n;
          cpu.setX87State(numeric);
          cpu.setState(changed(before, 0x1003n));
          const trap = await cpu.run({ budget: 1n, repeatBudget: 17n });
          outcome(trap, 'x87-exception', 1n, 0n, 17n, 0n, changed(before, 0x1003n));
          pending(trap, numeric, 0x1003n);
          x87(cpu, numeric);
          other(cpu);
          equal(trap.resources.compilations, 0, 'pending state is not a compilation constant');

          cpu.setState(changed(before, 0x1005n));
          const repaired = await cpu.run({ budget: 1n });
          outcome(repaired, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1007n));
          const after = clone(numeric);
          after.statusWord &= ~0x80ff;
          x87(cpu, after);
          noFault(repaired);

          const resumed = await cpu.run({ budget: 1n });
          outcome(resumed, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x100an));
          x87(cpu, integerResult(after, 2, numeric.registers[1]! & MASK64));
          other(cpu);
          noFault(resumed);
          equal(resumed.resources.compilations, 0, 'helper repair retains successor');
        });
      },
    },
  ];
}
