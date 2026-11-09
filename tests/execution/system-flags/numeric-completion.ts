import {
  using,
  snapshot,
  initial,
  outcome,
  debug,
  same,
  equal,
  hex,
  type Scenario,
} from './fixture.js';
import type { X87State } from '../../../host/index.js';

export function numericCompletionScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'system successful x87 MMX SIMD helper and numeric store effects precede a single-step trap',
      async run() {
        for (const kind of ['x87', 'mmx', 'simd', 'store'] as const) {
          const code = { x87: 'dec1', mmx: '0ffec1', simd: 'f30f58c1', store: '0fae1b' }[kind];
          await using(
            compiler,
            code,
            snapshot(),
            async (cpu) => {
              const raw: X87State = {
                registers: Array.from(
                  { length: 8 },
                  (_, i) => (BigInt(0x1234 + i) << 64n) | 0x8877665544332211n,
                ),
                controlWord: kind === 'simd' || kind === 'store' ? 0x37e : 0x37f,
                statusWord:
                  kind === 'simd' || kind === 'store' ? 0x8081 : kind === 'mmx' ? 0x2800 : 0,
                tagWord: kind === 'x87' ? 0xfff0 : 0xffff,
                opcode: 0x5a5,
                instructionPointer: 0x1122334455667788n,
                dataPointer: 0x8877665544332211n,
              };
              if (kind === 'x87') raw.registers[0] = raw.registers[1] = 0x3fff8000000000000000n;
              if (kind === 'mmx') {
                raw.registers[0] = 0x3fff0000000200000001n;
                raw.registers[1] = 0x40000000000400000003n;
              }
              const expectedX87 = structuredClone(raw);
              if (kind === 'x87') {
                expectedX87.registers[1] = 0x40008000000000000000n;
                expectedX87.tagWord = 0xfff3;
                expectedX87.statusWord = 0x0800;
                expectedX87.instructionPointer = 0x1000n;
              } else if (kind === 'mmx') {
                expectedX87.registers[0] = 0xffff0000000600000004n;
                expectedX87.tagWord = 0;
                expectedX87.statusWord = 0;
              }
              const xmm = Array.from(
                { length: 16 },
                (_, i) => (BigInt(i + 1) << 112n) | 0x112233445566778899aabbccn,
              );
              xmm[0] = (xmm[0]! & ~0xffffffffn) | 0x3f800000n;
              xmm[1] = (xmm[1]! & ~0xffffffffn) | 0x40000000n;
              const expectedXmm = xmm.slice();
              if (kind === 'simd') expectedXmm[0] = (xmm[0]! & ~0xffffffffn) | 0x40400000n;
              cpu.setX87State(raw);
              cpu.setXmmState(xmm);
              cpu.setMxcsr(0x1f80);
              const before = initial(0x1000n, { 3: 0x6008n }, 0x3d7fd7n, { sti: false, ss: true });
              cpu.setState(before);
              const resume = 0x1000n + BigInt(code.length / 2);
              const result = await cpu.run({ budget: 1n, repeatBudget: 7n, stop: resume });
              outcome(result, 'debug-exception', 1n, 1n, 7n);
              debug(result, 0x1000n, resume, true, 0x3c7fd7n);
              same(
                result.state,
                {
                  ...before,
                  flags: 0x3c7fd7n,
                  rip: resume,
                  interruptibility: { sti: false, ss: false },
                },
                `complete scalar ${kind}`,
              );
              same(cpu.readX87State(), expectedX87, `all raw80 state ${kind}`);
              same(cpu.readXmmState(), expectedXmm, `all XMM lanes ${kind}`);
              equal(cpu.readMxcsr(), 0x1f80, `exact MXCSR ${kind}`);
              same(cpu.readContext(), snapshot(), `complete context ${kind}`);
              const memory = hex('a5'.repeat(24));
              if (kind === 'store') memory.set([0x80, 0x1f, 0, 0], 8);
              same(cpu.readMemory(0x6000n, 24), memory, `store footprint and guards ${kind}`);
              same(
                cpu.readMemory(0x1000n, code.length / 2),
                hex(code),
                `instruction bytes ${kind}`,
              );
              const gated = await cpu.run({ budget: 0n });
              equal(gated.debugException, undefined, `no trap replay ${kind}`);
              same(cpu.readX87State(), expectedX87, `no effect replay ${kind}`);
            },
            { data: [{ base: 0x6000n, bytes: 'a5'.repeat(24) }] },
          );
        }
      },
    },
  ];
}
