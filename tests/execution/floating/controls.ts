import { createCpu } from '../../../host/index.js';
import { LIMITS, equal, fault, hex, memory, throws } from '../../support/fixture.js';
import {
  LONG,
  banks,
  bytes,
  changed,
  context,
  input,
  mxcsr,
  noFault,
  outcome,
  profiles,
  simdFault,
  using,
  xmm,
  type Scenario,
} from './fixture.js';
const rx = { read: true, write: false, execute: true };
const rw = { read: true, write: true, execute: false };

export function controlScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'MXCSR state imports and raw execution preserve all register projections across imported modes',
      async run() {
        for (const p of profiles) {
          const execution = p.mode === 'long64' ? LONG : context(p.mode, p.code32, p.stack32);
          await using(compiler, 'f30f6fc1', execution, async (cpu) => {
            mxcsr(cpu, 0x1f80);
            const raw = banks(),
              before = input(0x1000n, {}, 0xcd7n),
              expected = raw.slice();
            expected[0] = raw[1]!;
            cpu.setMxcsr(0xffff);
            cpu.setState(before);
            cpu.setXmmState(raw);
            cpu.setContext(execution);
            mxcsr(cpu, 0xffff);
            for (const invalid of [-1, 65536, NaN, Infinity, 1.5, '3', 1n, null])
              throws(() => cpu.setMxcsr(invalid as number), 'invalid MXCSR import');
            mxcsr(cpu, 0xffff);
            xmm(cpu, raw);
            const result = await cpu.run({ budget: 1n, repeatBudget: 7n });
            outcome(result, 'budget', 1n, 1n, 7n, 0n, changed(before, 0x1004n));
            noFault(result);
            xmm(cpu, expected);
            mxcsr(cpu, 0xffff);
          });
        }
      },
    },
    {
      name: 'MXCSR memory loads use exactly four unaligned bytes with every mode and address-size selection',
      async run() {
        for (const p of profiles)
          for (const override of [false, true]) {
            const execution = p.mode === 'long64' ? LONG : context(p.mode, p.code32, p.stack32),
              address16 = p.mode !== 'long64' && p.code32 === override,
              gpr = address16 ? 3 : 0;
            const code = (override ? '67' : '') + '0fae' + (address16 ? '17' : '10');
            await using(
              compiler,
              code,
              execution,
              async (cpu) => {
                const raw = banks(),
                  before = input(
                    0x1000n,
                    { [gpr]: p.mode === 'long64' && !override ? 0x6001n : 0x1122334400006001n },
                    0xcd7n,
                  );
                cpu.setState(before);
                cpu.setXmmState(raw);
                cpu.setMxcsr(0xffff);
                const result = await cpu.run({ budget: 1n, repeatBudget: 5n });
                outcome(
                  result,
                  'budget',
                  1n,
                  1n,
                  5n,
                  0n,
                  changed(before, 0x1000n + BigInt(code.length / 2)),
                );
                noFault(result);
                xmm(cpu, raw);
                mxcsr(cpu, 0x5fa5);
                memory(cpu, 0x6001n, 'a55f0000');
              },
              { data: [{ base: 0x6001n, bytes: 'a55f0000', read: true, write: false }] },
            );
          }
      },
    },
    {
      name: 'MXCSR reserved payloads export precise owned general-protection diagnostics after complete source reads',
      async run() {
        for (const value of [0x10000n, 0x80000000n, 0xffffffffn])
          await using(
            compiler,
            '0fae10',
            LONG,
            async (cpu) => {
              const raw = banks(),
                before = input(0x1000n, { 0: 0x6001n }, 0xcd7n);
              cpu.setState(before);
              cpu.setXmmState(raw);
              cpu.setMxcsr(0x9fa5);
              const result = await cpu.run({ budget: 2n, repeatBudget: 7n });
              outcome(result, 'general-protection', 2n, 0n, 7n, 0n, before);
              xmm(cpu, raw);
              mxcsr(cpu, 0x9fa5);
              const wanted = {
                instructionPc: 0x1000n,
                vector: 13,
                errorCode: 0,
                cause: 'mxcsr-reserved-bits',
                loadedValue: Number(value),
              };
              for (const key of Object.keys(wanted) as (keyof typeof wanted)[])
                equal(result.generalProtectionFault?.[key], wanted[key], `GP ${key}`);
              for (const key of [
                'fault',
                'segmentFault',
                'alignmentFault',
                'simdException',
              ] as const)
                equal(result[key], undefined, `exclusive ${key}`);
              cpu.setMxcsr(0x1f80);
              const zero = await cpu.run({ budget: 0n, repeatBudget: 0n });
              outcome(zero, 'budget', 0n, 0n, 0n, 0n, before);
              noFault(zero);
              mxcsr(cpu, 0x1f80);
              equal(result.generalProtectionFault?.loadedValue, Number(value), 'old owned record');
            },
            { data: [{ base: 0x6001n, bytes: bytes(value, 4) }] },
          );
        for (const available of [1, 2, 3])
          await using(
            compiler,
            '0fae10',
            LONG,
            async (cpu) => {
              const raw = banks(),
                before = input(0x1000n, { 0: 0x6001n }, 0xcd7n);
              cpu.setState(before);
              cpu.setXmmState(raw);
              cpu.setMxcsr(0x9fa5);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(result, 'data-fault', 1n, 0n, 0n, 0n, before);
              fault(result, {
                instructionPc: 0x1000n,
                segment: 'ds',
                address: 0x6001n,
                width: 4,
                access: 'read',
                cause: 'unmapped',
                failingAddress: 0x6001n + BigInt(available),
              });
              equal(result.generalProtectionFault, undefined, 'no partial-payload GP');
              equal(result.simdException, undefined, 'no numeric fault');
              xmm(cpu, raw);
              mxcsr(cpu, 0x9fa5);
            },
            { data: [{ base: 0x6001n, bytes: '000001'.slice(0, available * 2) }] },
          );
      },
    },
    {
      name: 'MXCSR stores require only write permission and preflight every split byte before changing guarded aliases',
      async run() {
        for (const read of [false, true])
          for (const write of [false, true])
            for (let split = 0; split < 4; split++) {
              const code = '0fae18',
                frame = 'a5'.repeat(3) + '11223344' + '5a'.repeat(3);
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
                    { base: 0x1000n, backing: 'code', offset: 0, length: 3, permissions: rx },
                    { base: 0x7000n, backing: 'data', offset: 0, length: 10, permissions: rx },
                    ...Array.from({ length: 4 }, (_, i) => ({
                      base: 0x6001n + BigInt(i),
                      backing: 'data',
                      offset: 3 + i,
                      length: 1,
                      permissions: i === split ? { read, write, execute: false } : rw,
                    })),
                  ],
                },
                memoryLimits: { maxBackings: 2, maxMappings: 6, maxBackingBytes: 13 },
                limits: LIMITS,
              });
              try {
                const raw = banks(),
                  before = input(0x1000n, { 0: 0x6001n }, 0xcd7n);
                cpu.setState(before);
                cpu.setXmmState(raw);
                cpu.setMxcsr(0xffff);
                const result = await cpu.run({ budget: 1n, repeatBudget: 3n });
                outcome(
                  result,
                  write ? 'budget' : 'data-fault',
                  1n,
                  write ? 1n : 0n,
                  3n,
                  0n,
                  write ? changed(before, 0x1003n) : before,
                );
                if (write) noFault(result);
                else
                  fault(result, {
                    instructionPc: 0x1000n,
                    address: 0x6001n,
                    width: 4,
                    access: 'write',
                    cause: 'permission',
                    failingAddress: 0x6001n + BigInt(split),
                    segment: 'ds',
                  });
                xmm(cpu, raw);
                mxcsr(cpu, 0xffff);
                memory(
                  cpu,
                  0x7000n,
                  'a5'.repeat(3) + (write ? 'ffff0000' : '11223344') + '5a'.repeat(3),
                );
              } finally {
                cpu.dispose();
              }
            }
      },
    },
    {
      name: 'MXCSR changes affect the next floating instruction in a cached artifact and status stores observe the updated value',
      async run() {
        await using(
          compiler,
          '0fae10f30f58c10fae1b',
          LONG,
          async (cpu) => {
            for (const [sample, control] of [0x1f80, 0x5f80, 0x7f80, 0x0f80].entries()) {
              const raw = banks(),
                before = input(0x1000n, { 0: 0x6001n, 3: 0x6101n }, 0xcd7n);
              raw[0] = (raw[0]! & ~0xffffffffn) | 0x3f800000n;
              raw[1] = (raw[1]! & ~0xffffffffn) | 0x33800000n;
              const expected = raw.slice();
              cpu.writeMemory(0x6001n, hex(bytes(BigInt(control), 4)));
              cpu.writeMemory(0x6100n, hex('a5'.repeat(6)));
              cpu.setState(before);
              cpu.setXmmState(raw);
              cpu.setMxcsr(0xffff);
              const result = await cpu.run({ budget: 3n, repeatBudget: 7n }),
                after = control | 0x20;
              if (control === 0x0f80) {
                outcome(result, 'simd-exception', 3n, 1n, 7n, 0n, changed(before, 0x1003n));
                simdFault(result, control, after, 0x20, 0x20, 'post-computation', 0x1003n);
                memory(cpu, 0x6100n, 'a5'.repeat(6));
              } else {
                expected[0] =
                  (raw[0]! & ~0xffffffffn) | (control === 0x5f80 ? 0x3f800001n : 0x3f800000n);
                outcome(result, 'budget', 3n, 3n, 7n, 0n, changed(before, 0x100an));
                noFault(result);
                memory(cpu, 0x6100n, 'a5' + bytes(BigInt(after), 4) + 'a5');
              }
              xmm(cpu, expected);
              mxcsr(cpu, after);
              if (sample > 0)
                equal(result.resources.compilations, 0, 'changed MXCSR source retains translation');
            }
          },
          {
            data: [
              { base: 0x6001n, bytes: '801f0000' },
              { base: 0x6100n, bytes: 'a5'.repeat(6) },
            ],
          },
        );
      },
    },
    {
      name: 'floating source segment canonical alignment and mapping checks suppress every numeric status effect',
      async run() {
        for (const [address, reason, cause] of [
          [0x800000000001n, 'data-fault', 'noncanonical'],
          [0x6001n, 'alignment-fault', ''],
          [0x6000n, 'data-fault', 'unmapped'],
        ] as const) {
          await using(compiler, '0f5800', LONG, async (cpu) => {
            const raw = banks(),
              before = input(0x1000n, { 0: address }, 0xcd7n);
            raw[0] = 0x7f800001n;
            cpu.setState(before);
            cpu.setXmmState(raw);
            cpu.setMxcsr(0);
            const result = await cpu.run({ budget: 1n, repeatBudget: 7n });
            outcome(result, reason, 1n, 0n, 7n, 0n, before);
            xmm(cpu, raw);
            mxcsr(cpu, 0);
            equal(result.simdException, undefined, 'memory check suppresses numeric exception');
            equal(result.generalProtectionFault, undefined, 'no control payload fault');
            if (reason === 'alignment-fault') {
              equal(result.alignmentFault?.address, address, 'linear alignment');
              equal(result.alignmentFault?.width, 16, 'packed width');
              equal(result.alignmentFault?.alignment, 16, 'required alignment');
              equal(result.fault, undefined, 'exclusive alignment');
              equal(result.segmentFault, undefined, 'exclusive segment');
            } else
              fault(result, {
                instructionPc: 0x1000n,
                address,
                width: 16,
                access: 'read',
                cause,
                failingAddress: address,
                segment: 'ds',
              });
          });
        }
        for (const code32 of [false, true])
          for (const stack32 of [false, true])
            for (const cause of ['unusable', 'limit'] as const) {
              const execution = context('protected', code32, stack32);
              execution.segments.ds.base = 1n;
              if (cause === 'unusable') execution.segments.ds.usable = false;
              else execution.segments.ds.limit = 0x6008;
              const code = (code32 ? '' : '67') + '0f5800';
              await using(compiler, code, execution, async (cpu) => {
                const raw = banks(),
                  before = input(0x1000n, { 0: 0x6001n }, 0xcd7n);
                raw[0] = 0x7f800001n;
                cpu.setState(before);
                cpu.setXmmState(raw);
                cpu.setMxcsr(0);
                const result = await cpu.run({ budget: 1n, repeatBudget: 7n });
                outcome(result, 'segment-fault', 1n, 0n, 7n, 0n, before);
                xmm(cpu, raw);
                mxcsr(cpu, 0);
                equal(result.segmentFault?.cause, cause, 'segment wins');
                equal(result.segmentFault?.width, 16, 'whole operand');
                equal(result.alignmentFault, undefined, 'no alignment');
                equal(result.simdException, undefined, 'no numeric');
                equal(result.fault, undefined, 'no mapping');
              });
            }
      },
    },
    {
      name: 'floating narrow memory and MXCSR controls work at high FS bases through the final guest byte',
      async run() {
        const fsBase = 0xfffffffffffffffcn;
        await using(
          compiler,
          '64f30f5800',
          { mode: 'long64', fsBase, gsBase: 0n },
          async (cpu) => {
            const raw = banks(),
              before = input(0x1000n, { 0: 0n }, 0xcd7n);
            raw[0] = (raw[0]! & ~0xffffffffn) | 0x3f800000n;
            const expected = raw.slice();
            expected[0] = (raw[0]! & ~0xffffffffn) | 0x40000000n;
            cpu.setState(before);
            cpu.setXmmState(raw);
            cpu.setMxcsr(0x1f80);
            const result = await cpu.run({ budget: 1n, repeatBudget: 7n });
            outcome(result, 'budget', 1n, 1n, 7n, 0n, changed(before, 0x1005n));
            noFault(result);
            xmm(cpu, expected);
            mxcsr(cpu, 0x1f80);
            memory(cpu, fsBase, '0000803f');
            const overflow = input(0x1000n, { 0: 1n }, 0xcd7n);
            cpu.setState(overflow);
            cpu.setXmmState(raw);
            cpu.setMxcsr(0);
            const failed = await cpu.run({ budget: 1n, repeatBudget: 0n });
            outcome(failed, 'data-fault', 1n, 0n, 0n, 0n, overflow);
            fault(failed, {
              instructionPc: 0x1000n,
              address: fsBase + 1n,
              width: 4,
              access: 'read',
              cause: 'address-range',
              failingAddress: 1n << 64n,
              segment: 'fs',
            });
            xmm(cpu, raw);
            mxcsr(cpu, 0);
          },
          { data: [{ base: fsBase, bytes: '0000803f' }] },
        );
        for (const code of ['640fae10', '640fae18'])
          await using(
            compiler,
            code,
            { mode: 'long64', fsBase, gsBase: 0n },
            async (cpu) => {
              const raw = banks(),
                before = input(0x1000n, { 0: 0n }, 0xcd7n);
              cpu.setState(before);
              cpu.setXmmState(raw);
              cpu.setMxcsr(0xffff);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(result, 'budget', 1n, 1n, 0n, 0n, changed(before, 0x1004n));
              noFault(result);
              xmm(cpu, raw);
              mxcsr(cpu, code.endsWith('10') ? 0x1f80 : 0xffff);
              memory(cpu, fsBase, code.endsWith('10') ? '801f0000' : 'ffff0000');
            },
            { data: [{ base: fsBase, bytes: '801f0000' }] },
          );
      },
    },
  ];
}
