import {
  LONG,
  context,
  profiles,
  using,
  input,
  changed,
  outcome,
  stack,
  clone,
  x87,
  banks,
  xmm,
  equal,
  bytes,
  memory,
  pending,
  noFault,
  type Scenario,
} from '../x87/fixture.js';

const MASK64 = (1n << 64n) - 1n;
function transitioned(before: ReturnType<typeof stack>, destination?: number, value = 0n) {
  const after = clone(before);
  after.statusWord &= ~0x3800;
  after.tagWord = 0;
  if (destination !== undefined) after.registers[destination] = (0xffffn << 64n) | (value & MASK64);
  return after;
}

export function literalScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'MMX physical register aliasing ignores TOP and empty tags across all imported profiles',
      async run() {
        for (const p of profiles) {
          const execution = p.mode === 'long64' ? LONG : context(p.mode, p.code32, p.stack32);
          await using(compiler, '0ffcc10f77', execution, async (cpu) => {
            const before = input(),
              numeric = stack({}, 5, 0x37f, 0x4700);
            numeric.registers[0] = 0x1234ff00ff00ff00ff00n;
            numeric.registers[1] = 0x56780102030405060708n;
            cpu.setState(before);
            cpu.setX87State(numeric);
            cpu.setXmmState(banks());
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1003n));
            const expected = transitioned(numeric, 0, 0x0002020404060608n);
            x87(cpu, expected);
            xmm(cpu, banks());
            noFault(result);
            const empty = await cpu.run({ budget: 1n });
            outcome(empty, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1005n));
            expected.tagWord = 0xffff;
            x87(cpu, expected);
            noFault(empty);
          });
        }
      },
    },
    {
      name: 'MMX lane edge packets cover saturation packs products shifts and byte masks',
      async run() {
        const packets: [string, bigint, bigint, bigint][] = [
          ['0fecc1', 0x7f807f807f807f80n, 0x017fff80017fff80n, 0x7fff7e807fff7e80n],
          ['0fdcc1', 0xff00fe01fd02fc03n, 0x010202fe03fd04fcn, 0xff02ffffffffffffn],
          ['0ff4c1', 0xdeadbeefffffffffn, 0x0123456700000002n, 0x00000001fffffffen],
          ['0ff5c1', 0x8000800080008000n, 0x8000800080008000n, 0x8000000080000000n],
          ['0ff6c1', 0x00010203040506ffn, 0x0000000000000000n, 0x114n],
          ['0fd1c1', 0xffff800000010002n, 0x1000000000000001n, 0n],
          ['0fe1c1', 0xffff800000010002n, 64n, 0xffffffff00000000n],
          ['0f63c1', 0x0080ff7f007fff80n, 0x7fff80000000ffffn, 0x7f8000ff7f807f80n],
          ['0f70c11b', 0n, 0x1111222233334444n, 0x4444333322221111n],
        ];
        for (const [code, left, right, expected] of packets)
          await using(compiler, code, LONG, async (cpu) => {
            const before = input(),
              numeric = stack({}, 6);
            numeric.registers[0] = left;
            numeric.registers[1] = right;
            cpu.setState(before);
            cpu.setX87State(numeric);
            const result = await cpu.run({ budget: 1n });
            outcome(
              result,
              'budget',
              1n,
              1n,
              1n,
              0n,
              changed(before, 0x1000n + BigInt(code.length / 2)),
            );
            x87(cpu, transitioned(numeric, 0, expected));
            noFault(result);
          });
      },
    },
    {
      name: 'MMX GP writes preserve nonlong upper halves and MOVDQ2Q MOVQ2DQ hand over live XMM locals',
      async run() {
        for (const execution of [LONG, context('protected')])
          await using(compiler, 'b8ffffffff0f6ec00f7ec1', execution, async (cpu) => {
            const before = input(),
              numeric = stack({}, 3);
            cpu.setState(before);
            cpu.setX87State(numeric);
            const result = await cpu.run({ budget: 3n });
            const upper = execution.mode === 'long64' ? 0n : before.registers[0]! & ~0xffffffffn;
            outcome(
              result,
              'budget',
              3n,
              3n,
              3n,
              0n,
              changed(before, 0x100bn, {
                0: upper | 0xffffffffn,
                1:
                  (execution.mode === 'long64' ? 0n : before.registers[1]! & ~0xffffffffn) |
                  0xffffffffn,
              }),
            );
            x87(cpu, transitioned(numeric, 0, 0xffffffffn));
          });
        await using(compiler, '660fefc0f20fd6c0f30fd6c8', LONG, async (cpu) => {
          const before = input(),
            numeric = stack({}, 2),
            vector = banks();
          cpu.setState(before);
          cpu.setX87State(numeric);
          cpu.setXmmState(vector);
          const result = await cpu.run({ budget: 3n });
          outcome(result, 'budget', 3n, 3n, 3n, 0n, changed(before, 0x100cn));
          vector[0] = 0n;
          vector[1] = 0n;
          xmm(cpu, vector);
          x87(cpu, transitioned(numeric, 0, 0n));
        });
      },
    },
    {
      name: 'MMX conversion rounding packets preserve XMM upper halves and publish x87 only after success',
      async run() {
        for (const [rc, low] of [
          0x4b800000cb800000n,
          0x4b800000cb800001n,
          0x4b800001cb800000n,
          0x4b800000cb800000n,
        ].entries()) {
          // Low lane is +16777217; the upper lane is -16777217.
          const reordered = ((low & 0xffffffffn) << 32n) | (low >> 32n);
          await using(compiler, '0f2ac0', LONG, async (cpu) => {
            const before = input(),
              numeric = stack({}, 7),
              vector = banks();
            numeric.registers[0] = 0x1234feffffff01000001n;
            cpu.setState(before);
            cpu.setX87State(numeric);
            cpu.setXmmState(vector);
            cpu.setMxcsr(0x1f80 | (rc << 13));
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1003n));
            vector[0] = (vector[0]! & ~MASK64) | reordered;
            xmm(cpu, vector);
            x87(cpu, transitioned(numeric));
            equal(cpu.readMxcsr(), 0x1fa0 | (rc << 13), 'precision sticky');
          });
        }
        for (const [mxcsr, raised, after, stage] of [
          [0x1f00, 1, 0x1f01, 'pre-computation'],
          [0x0f80, 0x21, 0x0fa1, 'post-computation'],
        ] as const)
          await using(compiler, '0f2dc0', LONG, async (cpu) => {
            const before = input(),
              numeric = stack({}, 5),
              vector = banks();
            vector[0] = 0x3fc000007fc12345n;
            cpu.setState(before);
            cpu.setX87State(numeric);
            cpu.setXmmState(vector);
            cpu.setMxcsr(mxcsr);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'simd-exception', 1n, 0n, 1n, 0n, before);
            equal(result.simdException?.stage, stage, 'exception stage');
            equal(result.simdException?.raised, raised, 'raised conditions');
            equal(cpu.readMxcsr(), after, 'only permitted sticky conditions');
            x87(cpu, numeric);
            xmm(cpu, vector);
          });
      },
    },
    {
      name: 'CVTPI2PD memory uniquely bypasses pending x87 while other MMX operations fault before data access',
      async run() {
        for (const code of ['0f77', '0f2a03', '0f6f03'])
          await using(compiler, code, LONG, async (cpu) => {
            const before = input(0x1000n, { 3: 0x6000n }),
              numeric = stack({}, 5, 0x37b, 0x8084);
            cpu.setState(before);
            cpu.setX87State(numeric);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'x87-exception', 1n, 0n, 1n, 0n, before);
            pending(result, numeric, 0x1000n);
            x87(cpu, numeric);
          });
        await using(
          compiler,
          '660f2a030f77',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 3: 0x6000n }),
              numeric = stack({}, 5, 0x37b, 0x8084),
              vector = banks();
            cpu.setState(before);
            cpu.setX87State(numeric);
            cpu.setXmmState(vector);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1004n));
            vector[0] = 0xc0000000000000003ff0000000000000n;
            xmm(cpu, vector);
            x87(cpu, numeric);
            noFault(result);
            const trap = await cpu.run({ budget: 1n });
            pending(trap, numeric, 0x1004n);
            x87(cpu, numeric);
          },
          { data: [{ base: 0x6000n, bytes: bytes(0xfffffffe00000001n, 8) }] },
        );
      },
    },
    {
      name: 'MMX stores write exact widths and preserve guard bytes',
      async run() {
        await using(
          compiler,
          '0f7f03',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 3: 0x6001n }),
              numeric = stack({}, 4);
            numeric.registers[0] = 0x12348877665544332211n;
            cpu.setState(before);
            cpu.setX87State(numeric);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1003n));
            x87(cpu, transitioned(numeric));
            memory(cpu, 0x6000n, 'a51122334455667788a5');
          },
          { data: [{ base: 0x6000n, bytes: 'a5'.repeat(10) }] },
        );
      },
    },
  ];
}
