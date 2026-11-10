import {
  using,
  snapshot,
  initial,
  same,
  equal,
  createCpu,
  LIMITS,
  hex,
  type Scenario,
} from '../exception-delivery/fixture.js';

export function reviewNumericScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'hardware debug review FX fields exclude padding and software tail and reject tentative invalid restores',
      async run() {
        await using(
          compiler,
          '0fae030fae0b',
          snapshot(),
          async (cpu) => {
            cpu.setXmmState(Array.from({ length: 16 }, (_, index) => BigInt(index + 1)));
            const numeric = [cpu.readX87State(), cpu.readXmmState(), cpu.readMxcsr()];
            cpu.setDebugState({
              addresses: [0x6018n, 0x602cn, 0x61e0n, 0n],
              dr6: 0n,
              dr7: 0x0ddd0415n,
            });
            cpu.setState(initial(0x1000n, { 3: 0x6000n }, 0x202n));
            const saved = await cpu.run({ budget: 1n });
            equal(saved.reason, 'debug-exception', 'FXSAVE write trap');
            equal(
              saved.debugException?.breakpoints,
              1,
              'MXCSR written but ST padding and tail preserved',
            );
            equal(saved.state.rip, 0x1003n, 'FXSAVE retired');
            same(cpu.readMemory(0x6018n, 8), hex('801f0000ffff0000'), 'literal MXCSR and MASK');
            same(cpu.readMemory(0x602an, 6), new Uint8Array(6).fill(0xa5), 'raw80 padding');
            same(cpu.readMemory(0x61a0n, 96), new Uint8Array(96).fill(0xa5), 'whole software tail');
            same(cpu.readMemory(0x6200n, 16), new Uint8Array(16).fill(0xa5), 'guard beyond image');
            same(
              [cpu.readX87State(), cpu.readXmmState(), cpu.readMxcsr()],
              numeric,
              'save preserves numeric state',
            );
            cpu.setDebugState({
              addresses: [0x6018n, 0x602cn, 0x61e0n, 0n],
              dr6: 0n,
              dr7: 0x0fff0415n,
            });
            const restored = await cpu.run({ budget: 1n });
            equal(restored.reason, 'debug-exception', 'FXRSTOR read trap');
            equal(restored.debugException?.breakpoints, 1, 'padding and tail not observed');
            same(
              [cpu.readX87State(), cpu.readXmmState(), cpu.readMxcsr()],
              numeric,
              'literal numeric state restored',
            );
            cpu.writeMemory(0x6018n, hex('00000100'));
            cpu.setState(initial(0x1003n, { 3: 0x6000n }, 0x202n));
            cpu.setDebugState({ addresses: [0x6018n, 0n, 0n, 0n], dr6: 0x8008n, dr7: 0xf0401n });
            const failed = await cpu.run({ budget: 1n });
            equal(failed.reason, 'general-protection', 'image validation before data trap');
            equal(failed.retired, 0n, 'invalid image not restored');
            equal(cpu.readDebugState().dr6, 0xffff8ff8n, 'tentative source not published');
            same(
              [cpu.readX87State(), cpu.readXmmState(), cpu.readMxcsr()],
              numeric,
              'invalid restore preserves numeric banks',
            );
          },
          { data: [{ base: 0x6000n, bytes: 'a5'.repeat(528) }] },
        );
      },
    },
    {
      name: 'hardware debug review masked writes match selected linear bytes and private nominal failure commits none',
      async run() {
        for (const deniedTail of [false, true]) {
          const cpu = await createCpu({
            compiler,
            limits: LIMITS,
            entry: 0x1000n,
            memory: {
              backings: [
                { id: 'code', bytes: hex('660ff7c1') },
                { id: 'data', bytes: new Uint8Array(16).fill(0xa5) },
              ],
              mappings: [
                {
                  base: 0x1000n,
                  backing: 'code',
                  offset: 0,
                  length: 4,
                  permissions: { read: true, write: false, execute: true },
                },
                {
                  base: 0x6000n,
                  backing: 'data',
                  offset: 0,
                  length: 15,
                  permissions: { read: false, write: true, execute: false },
                },
                {
                  base: 0x600fn,
                  backing: 'data',
                  offset: 15,
                  length: 1,
                  permissions: { read: false, write: !deniedTail, execute: false },
                },
                {
                  base: 0x7000n,
                  backing: 'data',
                  offset: 0,
                  length: 16,
                  permissions: { read: true, write: false, execute: false },
                },
              ],
            },
            memoryLimits: { maxBackings: 2, maxMappings: 4, maxBackingBytes: 20 },
          });
          try {
            const xmm = Array<bigint>(16).fill(0n);
            xmm[0] = 0x100f0e0d0c0b0a090807060504030201n;
            xmm[1] = 1n << 71n;
            cpu.setXmmState(xmm);
            cpu.setDebugState({
              addresses: [0x6000n, 0x6008n, 0x600fn, 0x7008n],
              dr6: 0n,
              dr7: 0x11110455n,
            });
            cpu.setState(initial(0x1000n, { 7: 0x6000n }, 0x202n));
            const before = cpu.readState();
            const result = await cpu.run({ budget: 1n });
            equal(
              result.reason,
              deniedTail ? 'data-fault' : 'debug-exception',
              'nominal admission before publication',
            );
            equal(result.retired, deniedTail ? 0n : 1n, 'masked retirement');
            equal(
              result.debugException?.breakpoints,
              deniedTail ? undefined : 2,
              'only selected byte8, no alias hit',
            );
            equal(
              cpu.readDebugState().dr6,
              deniedTail ? 0xffff0ff0n : 0xffff0ff2n,
              'only committed mask',
            );
            same(result.state.registers, before.registers, 'all scalar banks preserved');
            same(cpu.readXmmState(), xmm, 'MASKMOV source banks preserved');
            same(
              cpu.readMemory(0x7000n, 16),
              hex(deniedTail ? 'a5'.repeat(16) : 'a5'.repeat(8) + '09' + 'a5'.repeat(7)),
              'complete alias guard',
            );
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'hardware debug review unmasked SIMD fault suppresses a tentative match without leaking it to the next instruction',
      async run() {
        await using(
          compiler,
          'f30f5e0390',
          snapshot(),
          async (cpu) => {
            const xmm = Array<bigint>(16).fill(0n);
            xmm[0] = 0x3f800000n;
            cpu.setXmmState(xmm);
            cpu.setMxcsr(0x1d80);
            cpu.setDebugState({ addresses: [0x6000n, 0n, 0n, 0n], dr6: 0x8008n, dr7: 0xf0401n });
            cpu.setState(initial(0x1000n, { 3: 0x6000n }, 0x202n));
            const failed = await cpu.run({ budget: 1n });
            equal(failed.reason, 'simd-exception', 'unmasked ZE before data trap');
            equal(failed.retired, 0n, 'faulting DIVSS not retired');
            equal(cpu.readMxcsr(), 0x1d84, 'numeric status effect');
            same(cpu.readXmmState(), xmm, 'unmasked destination suppressed');
            equal(cpu.readDebugState().dr6, 0xffff8ff8n, 'no tentative status');
            cpu.setState(initial(0x1004n, {}, 0x202n));
            const unrelated = await cpu.run({ budget: 1n });
            equal(unrelated.reason, 'budget', 'no candidate leak to NOP');
            equal(cpu.readDebugState().dr6, 0xffff8ff8n, 'unrelated instruction preserves DR6');
            cpu.setMxcsr(0x1f80);
            cpu.setState(initial(0x1000n, { 3: 0x6000n }, 0x202n));
            const retry = await cpu.run({ budget: 1n });
            equal(retry.reason, 'debug-exception', 'masked completion selects read slot');
            equal(retry.debugException?.breakpoints, 1, 'current source differs from old DR6');
            equal(cpu.readXmmState()[0], 0x7f800000n, 'masked infinity committed');
            equal(cpu.readDebugState().dr6, 0xffff8ff1n, 'BT retained, B3 replaced by B0');
          },
          { data: [{ base: 0x6000n, bytes: '00000000' }] },
        );
      },
    },
  ];
}
