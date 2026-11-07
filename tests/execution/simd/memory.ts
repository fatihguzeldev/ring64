import { createCpu, type ExecutionContext } from '../../../host/index.js';
import { LIMITS, equal, fault, hex, memory } from '../../support/fixture.js';
import {
  LONG,
  banks,
  bytes,
  changed,
  context,
  input,
  outcome,
  profiles,
  using,
  xmm,
  type Scenario,
} from './fixture.js';

const rx = { read: true, write: false, execute: true };
const rw = { read: true, write: true, execute: false };

export function memoryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'SIMD failed narrow loads and partial inserts preserve nonzero destination upper bits',
      async run() {
        for (const [code, width] of [
          ['f30f1000', 4],
          ['f20f1000', 8],
          ['660f6e00', 4],
          ['66480f6e00', 8],
          ['f30f7e00', 8],
          ['660fc400ff', 2],
        ] as const)
          for (const available of [0, width - 1])
            await using(
              compiler,
              code,
              LONG,
              async (cpu) => {
                const raw = banks(),
                  before = input(0x1000n, { 0: 0x6001n }, 0xcd7n);
                cpu.setState(before);
                cpu.setXmmState(raw);
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                outcome(result, 'data-fault', 1n, 0n, 0n, 0n, before);
                fault(result, {
                  instructionPc: 0x1000n,
                  address: 0x6001n,
                  width,
                  access: 'read',
                  cause: 'unmapped',
                  failingAddress: 0x6001n + BigInt(available),
                  segment: 'ds',
                });
                xmm(cpu, raw);
                if (available) memory(cpu, 0x6001n, 'ab'.repeat(available));
              },
              { data: available ? [{ base: 0x6001n, bytes: 'ab'.repeat(available) }] : [] },
            );
      },
    },
    {
      name: 'SIMD wide and narrow transfers obey mode address width and exact guarded memory spans',
      async run() {
        for (const p of profiles)
          for (const override of [false, true]) {
            const execution: ExecutionContext =
              p.mode === 'long64' ? LONG : context(p.mode, p.code32, p.stack32);
            const address16 = p.mode !== 'long64' && p.code32 === override;
            // [BX] in address16; [RAX/EAX] otherwise. High raw bits test address truncation.
            const gpr = address16 ? 3 : 0;
            for (const [prefix, load, store, width, aligned] of [
              ['66', '6f', '7f', 16, true],
              ['f3', '6f', '7f', 16, false],
              ['', '28', '29', 16, true],
              ['66', '28', '29', 16, true],
              ['', '10', '11', 16, false],
              ['66', '10', '11', 16, false],
              ['f3', '10', '11', 4, false],
              ['f2', '10', '11', 8, false],
              ['66', '6e', '7e', 4, false],
              ['f3', '7e', '', 8, false],
              ['66', '', 'd6', 8, false],
            ] as const)
              for (const write of [false, true]) {
                const op = write ? store : load;
                if (!op) continue;
                const at = aligned ? 0x6000n : 0x6001n;
                const code =
                  (override ? '67' : '') + prefix + '0f' + op + (address16 ? '07' : '00');
                const value = 0x0123456789abcdeffedcba9876543210n;
                const payload = bytes(value, width);
                const frame = 'a5'.repeat(3) + payload + '5a'.repeat(3);
                await using(
                  compiler,
                  code,
                  execution,
                  async (cpu) => {
                    const raw = banks(),
                      expected = raw.slice();
                    raw[0] = value;
                    // Keep legacy/addr32 high raw GPR bits visible while selecting the same offset.
                    const before = input(
                      0x1000n,
                      { [gpr]: p.mode === 'long64' && !override ? at : 0x123400000000n | at },
                      0xcd7n,
                    );
                    cpu.setXmmState(raw);
                    cpu.setState(before);
                    if (!write) expected[0] = value & ((1n << BigInt(width * 8)) - 1n);
                    else expected[0] = value;
                    outcome(
                      await cpu.run({ budget: 1n, repeatBudget: 0n }),
                      'budget',
                      1n,
                      1n,
                      0n,
                      0n,
                      changed(before, 0x1000n + BigInt(code.length / 2)),
                    );
                    xmm(cpu, expected);
                    memory(cpu, at - 3n, frame);
                  },
                  { data: [{ base: at - 3n, bytes: frame }] },
                );
              }
          }
      },
    },
    {
      name: 'SIMD each byte of a split wide operand checks only its required permission and stores roll back atomically',
      async run() {
        const initial = 0x0123456789abcdeffedcba9876543210n;
        for (const read of [false, true])
          for (const write of [false, true])
            for (const store of [false, true])
              for (let failing = 0; failing < 16; failing++) {
                const code = store ? 'f30f7f00' : 'f30f6f00',
                  frame = 'a5'.repeat(8) + bytes(initial) + '5a'.repeat(8);
                const maps = [
                  { base: 0x1000n, backing: 'code', offset: 0, length: 4, permissions: rx },
                  { base: 0x7000n, backing: 'data', offset: 0, length: 32, permissions: rx },
                  ...Array.from({ length: 16 }, (_, i) => ({
                    base: 0x6000n + BigInt(i),
                    backing: 'data',
                    offset: 8 + i,
                    length: 1,
                    permissions: i === failing ? { read, write, execute: false } : rw,
                  })),
                ];
                const cpu = await createCpu({
                  compiler,
                  context: LONG,
                  entry: 0x1000n,
                  memory: {
                    backings: [
                      { id: 'code', bytes: hex(code) },
                      { id: 'data', bytes: hex(frame) },
                    ],
                    mappings: maps,
                  },
                  memoryLimits: { maxBackings: 2, maxMappings: 18, maxBackingBytes: 36 },
                  limits: LIMITS,
                });
                try {
                  const raw = banks(),
                    expected = raw.slice(),
                    before = input(0x1000n, { 0: 0x6000n }, 0xcd7n);
                  cpu.setXmmState(raw);
                  cpu.setState(before);
                  const succeeds = store ? write : read;
                  const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                  outcome(
                    result,
                    succeeds ? 'budget' : 'data-fault',
                    1n,
                    succeeds ? 1n : 0n,
                    0n,
                    0n,
                    succeeds ? changed(before, 0x1004n) : before,
                  );
                  if (!succeeds)
                    fault(result, {
                      instructionPc: 0x1000n,
                      address: 0x6000n,
                      width: 16,
                      access: store ? 'write' : 'read',
                      cause: 'permission',
                      failingAddress: 0x6000n + BigInt(failing),
                      segment: 'ds',
                    });
                  else if (!store) expected[0] = initial;
                  xmm(cpu, expected);
                  memory(
                    cpu,
                    0x7000n,
                    'a5'.repeat(8) +
                      (succeeds && store ? bytes(raw[0]!) : bytes(initial)) +
                      '5a'.repeat(8),
                  );
                  // Repair keeps both banks intact and cannot recompile a read-only data dependency.
                  if (!succeeds) {
                    cpu.setMappings(
                      maps.map((m) =>
                        m.base >= 0x6000n && m.base < 0x6010n ? { ...m, permissions: rw } : m,
                      ),
                    );
                    const retry = await cpu.run({ budget: 1n, repeatBudget: 0n });
                    outcome(retry, 'budget', 1n, 1n, 0n, 0n, changed(before, 0x1004n));
                    equal(retry.fault, undefined, 'repaired fault cleared');
                    if (!store) expected[0] = initial;
                    xmm(cpu, expected);
                    memory(
                      cpu,
                      0x7000n,
                      'a5'.repeat(8) + (store ? bytes(raw[0]!) : bytes(initial)) + '5a'.repeat(8),
                    );
                  }
                } finally {
                  cpu.dispose();
                }
              }
      },
    },
    {
      name: 'SIMD declared m128 count and low-half computations still check all sixteen source bytes',
      async run() {
        // Count low64, PMULUDQ even dwords, and SHUFPS choosing only low lanes.
        for (const code of ['660ff100', '660ff400', '0fc60000', '660f700000'])
          for (let split = 1; split < 16; split++)
            await using(
              compiler,
              code,
              LONG,
              async (cpu) => {
                const raw = banks(),
                  before = input(0x1000n, { 0: 0x6000n }, 0xcd7n);
                cpu.setXmmState(raw);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                outcome(result, 'data-fault', 1n, 0n, 0n, 0n, before);
                fault(result, {
                  instructionPc: 0x1000n,
                  address: 0x6000n,
                  width: 16,
                  access: 'read',
                  cause: 'unmapped',
                  failingAddress: 0x6000n + BigInt(split),
                  segment: 'ds',
                });
                xmm(cpu, raw);
                memory(cpu, 0x6000n, '00'.repeat(split));
              },
              { data: [{ base: 0x6000n, bytes: '00'.repeat(split) }] },
            );
      },
    },
    {
      name: 'SIMD narrow stores use their actual width on write-only destinations and preserve every guard',
      async run() {
        for (const [code, width] of [
          ['660f7e00', 4],
          ['66480f7e00', 8],
          ['660fd600', 8],
          ['f30f1100', 4],
          ['f20f1100', 8],
        ] as const) {
          const raw = banks(),
            value = raw[0]!,
            frame = 'a5'.repeat(5) + '00'.repeat(width) + '5a'.repeat(5);
          const cpu = await createCpu({
            compiler,
            context: LONG,
            entry: 0x1000n,
            memory: {
              backings: [
                { id: 'code', bytes: hex(code) },
                { id: 'data', bytes: hex(frame) },
              ],
              mappings: [
                {
                  base: 0x1000n,
                  backing: 'code',
                  offset: 0,
                  length: code.length / 2,
                  permissions: rx,
                },
                {
                  base: 0x6001n,
                  backing: 'data',
                  offset: 5,
                  length: width,
                  permissions: { read: false, write: true, execute: false },
                },
                { base: 0x7000n, backing: 'data', offset: 0, length: width + 10, permissions: rx },
              ],
            },
            memoryLimits: {
              maxBackings: 2,
              maxMappings: 3,
              maxBackingBytes: code.length / 2 + width + 10,
            },
            limits: LIMITS,
          });
          try {
            const before = input(0x1000n, { 0: 0x6001n }, 0xcd7n);
            cpu.setXmmState(raw);
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 1n, repeatBudget: 0n }),
              'budget',
              1n,
              1n,
              0n,
              0n,
              changed(before, 0x1000n + BigInt(code.length / 2)),
            );
            xmm(cpu, raw);
            memory(cpu, 0x7000n, 'a5'.repeat(5) + bytes(value, width) + '5a'.repeat(5));
          } finally {
            cpu.dispose();
          }
        }
      },
    },
  ];
}
