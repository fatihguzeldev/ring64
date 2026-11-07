import type { AlignmentFault, ExecutionContext, RunResult } from '../../../host/index.js';
import { check, equal, fault, memory } from '../../support/fixture.js';
import {
  LONG,
  banks,
  bytes,
  changed,
  context,
  input,
  outcome,
  using,
  xmm,
  type Scenario,
} from './fixture.js';

function alignment(result: RunResult, expected: AlignmentFault): void {
  check(result.alignmentFault, 'missing alignment diagnostic');
  equal(result.fault, undefined, 'alignment excludes linear fault');
  equal(result.segmentFault, undefined, 'alignment excludes segment fault');
  for (const key of [
    'segment',
    'instructionPc',
    'offset',
    'address',
    'width',
    'access',
    'alignment',
  ] as const)
    equal(result.alignmentFault[key], expected[key], `alignment ${key}`);
}
function noAlignment(result: RunResult): void {
  equal(result.alignmentFault, undefined, 'no alignment diagnostic');
}

export function boundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'SIMD canonical and address-domain span checks precede alignment before mapping',
      async run() {
        for (const opcode of ['660f6f00', '660fdb00', '660f7f00'])
          for (const entry of [
            { address: 0x6001n, reason: 'alignment-fault' },
            { address: 0x6000n, reason: 'data-fault', cause: 'unmapped', failing: 0x6000n },
            {
              address: 0x800000000001n,
              reason: 'data-fault',
              cause: 'noncanonical',
              failing: 0x800000000001n,
            },
            {
              address: 0x7ffffffffff9n,
              reason: 'data-fault',
              cause: 'noncanonical',
              failing: 0x800000000000n,
            },
            {
              address: 0xfffffffffffffff9n,
              reason: 'data-fault',
              cause: 'address-range',
              failing: 1n << 64n,
            },
          ] as const) {
            await using(compiler, opcode, LONG, async (cpu) => {
              const raw = banks(),
                before = input(0x1000n, { 0: entry.address }, 0xcd7n);
              cpu.setState(before);
              cpu.setXmmState(raw);
              const result = await cpu.run({ budget: 1n, repeatBudget: 3n });
              outcome(result, entry.reason, 1n, 0n, 3n, 0n, before);
              xmm(cpu, raw);
              const access = opcode === '660f7f00' ? 'write' : 'read';
              if (entry.reason === 'alignment-fault')
                alignment(result, {
                  instructionPc: 0x1000n,
                  segment: 'ds',
                  offset: entry.address,
                  address: entry.address,
                  width: 16,
                  access,
                  alignment: 16,
                });
              else {
                noAlignment(result);
                fault(result, {
                  instructionPc: 0x1000n,
                  segment: 'ds',
                  address: entry.address,
                  width: 16,
                  access,
                  cause: entry.cause,
                  failingAddress: entry.failing,
                });
              }
            });
          }
      },
    },
    {
      name: 'SIMD segment unusable type and limit checks precede misalignment and mapping',
      async run() {
        for (const code32 of [false, true])
          for (const stack32 of [false, true])
            for (const cause of ['unusable', 'type', 'limit'] as const)
              for (const write of [false, true]) {
                const execution = context('protected', code32, stack32);
                const selected = execution.segments.ds;
                selected.base = 1n;
                if (cause === 'unusable') selected.usable = false;
                if (cause === 'type') selected.type = write ? 'read-only' : 'code';
                if (cause === 'limit') selected.limit = 0x6008;
                const code = (code32 ? '' : '67') + '660f' + (write ? '7f' : '6f') + '00';
                await using(compiler, code, execution, async (cpu) => {
                  const raw = banks(),
                    before = input(0x1000n, { 0: 0x6001n }, 0xcd7n);
                  cpu.setState(before);
                  cpu.setXmmState(raw);
                  const result = await cpu.run({ budget: 1n, repeatBudget: 7n });
                  outcome(result, 'segment-fault', 1n, 0n, 7n, 0n, before);
                  xmm(cpu, raw);
                  noAlignment(result);
                  equal(result.fault, undefined, 'segment excludes linear');
                  check(result.segmentFault, 'missing segment diagnostic');
                  const expected = {
                    instructionPc: 0x1000n,
                    segment: 'ds',
                    offset: 0x6001n,
                    width: 16,
                    access: write ? 'write' : 'read',
                    cause,
                    failingOffset: cause === 'limit' ? 0x6009n : 0x6001n,
                  };
                  for (const key of [
                    'instructionPc',
                    'segment',
                    'offset',
                    'width',
                    'access',
                    'cause',
                    'failingOffset',
                  ] as const)
                    equal(result.segmentFault[key], expected[key], `segment ${key}`);
                });
              }
      },
    },
    {
      name: 'SIMD non-long64 linear-domain overflow precedes misalignment after segment translation',
      async run() {
        for (const code32 of [false, true])
          for (const write of [false, true]) {
            const execution = context('protected', code32, false);
            execution.segments.ds.base = 0xffff0000n;
            const code = (code32 ? '' : '67') + '660f' + (write ? '7f' : '6f') + '00';
            await using(compiler, code, execution, async (cpu) => {
              const raw = banks(),
                before = input(0x1000n, { 0: 0xfff9n }, 0xcd7n);
              cpu.setState(before);
              cpu.setXmmState(raw);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(result, 'data-fault', 1n, 0n, 0n, 0n, before);
              xmm(cpu, raw);
              noAlignment(result);
              fault(result, {
                instructionPc: 0x1000n,
                segment: 'ds',
                address: 0xfffffff9n,
                width: 16,
                access: write ? 'write' : 'read',
                cause: 'address-range',
                failingAddress: 1n << 32n,
              });
            });
          }
      },
    },
    {
      name: 'SIMD uses translated alignment with nonzero CS and data bases in every CS.D and SS.B combination',
      async run() {
        const value = 0x8877665544332211fedcba9876543210n;
        for (const code32 of [false, true])
          for (const stack32 of [false, true])
            for (const offset of [0x6000n, 0x600fn]) {
              const execution = context('protected', code32, stack32);
              execution.segments.cs.base = 0x10000n;
              execution.segments.ds.base = 1n;
              const code = (code32 ? '' : '67') + '660f6f00';
              await using(
                compiler,
                code,
                execution,
                async (cpu) => {
                  const raw = banks(),
                    before = input(0x1000n, { 0: offset }, 0xcd7n);
                  cpu.setState(before);
                  cpu.setXmmState(raw);
                  const result = await cpu.run({ budget: 1n, repeatBudget: 11n });
                  if (offset === 0x6000n) {
                    outcome(result, 'alignment-fault', 1n, 0n, 11n, 0n, before);
                    xmm(cpu, raw);
                    alignment(result, {
                      instructionPc: 0x1000n,
                      segment: 'ds',
                      offset,
                      address: 0x6001n,
                      width: 16,
                      access: 'read',
                      alignment: 16,
                    });
                  } else {
                    outcome(
                      result,
                      'budget',
                      1n,
                      1n,
                      11n,
                      0n,
                      changed(before, 0x1000n + BigInt(code.length / 2)),
                    );
                    raw[0] = value;
                    xmm(cpu, raw);
                    noAlignment(result);
                  }
                  memory(cpu, 0x6010n, bytes(value));
                },
                { codeBase: 0x11000n, data: [{ base: 0x6010n, bytes: bytes(value) }] },
              );
            }
      },
    },
    {
      name: 'SIMD FS translation supports high canonical bytes through u64 maximum and clears repaired alignment diagnostics',
      async run() {
        const value = 0x112233445566778899aabbccddeeff00n;
        for (const fsBase of [0xffff800000000001n, 0xfffffffffffffff0n]) {
          const offset = fsBase === 0xfffffffffffffff0n ? 0n : 0x600fn;
          const address = BigInt.asUintN(64, fsBase + offset);
          const execution: ExecutionContext = { mode: 'long64', fsBase, gsBase: 0n };
          await using(
            compiler,
            '64660f6f00',
            execution,
            async (cpu) => {
              const raw = banks(),
                before = input(0x1000n, { 0: offset }, 0xcd7n);
              cpu.setState(before);
              cpu.setXmmState(raw);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(result, 'budget', 1n, 1n, 0n, 0n, changed(before, 0x1005n));
              raw[0] = value;
              xmm(cpu, raw);
              noAlignment(result);
              memory(cpu, address, bytes(value));
            },
            { data: [{ base: address, bytes: bytes(value) }] },
          );
        }
        await using(
          compiler,
          '64660f6f00',
          { mode: 'long64', fsBase: 1n, gsBase: 0n },
          async (cpu) => {
            const raw = banks(),
              before = input(0x1000n, { 0: 0x6000n }, 0xcd7n);
            cpu.setState(before);
            cpu.setXmmState(raw);
            const failed = await cpu.run({ budget: 1n, repeatBudget: 0n });
            outcome(failed, 'alignment-fault', 1n, 0n, 0n, 0n, before);
            xmm(cpu, raw);
            alignment(failed, {
              instructionPc: 0x1000n,
              segment: 'fs',
              offset: 0x6000n,
              address: 0x6001n,
              width: 16,
              access: 'read',
              alignment: 16,
            });
            cpu.setXmmState(raw);
            const zero = await cpu.run({ budget: 0n });
            outcome(zero, 'budget', 0n, 0n, 0n, 0n, before);
            noAlignment(zero);
            cpu.setContext({ mode: 'long64', fsBase: 16n, gsBase: 0n });
            const repaired = await cpu.run({ budget: 1n, repeatBudget: 2n });
            outcome(repaired, 'budget', 1n, 1n, 2n, 0n, changed(before, 0x1005n));
            raw[0] = value;
            xmm(cpu, raw);
            noAlignment(repaired);
            equal(failed.alignmentFault?.address, 0x6001n, 'old diagnostic remains owned');
          },
          { data: [{ base: 0x6010n, bytes: bytes(value) }] },
        );
      },
    },
    {
      name: 'SIMD narrow transfers reach the last guest byte without wide overread and retain complete fault state on domain overflow',
      async run() {
        const value = 0x8877665544332211n;
        for (const [code, width, insert] of [
          ['660fc40003', 2, true],
          ['f30f1000', 4, false],
          ['f20f1000', 8, false],
          ['660f6e00', 4, false],
          ['66480f6e00', 8, false],
          ['f30f7e00', 8, false],
        ] as const) {
          const address = (1n << 64n) - BigInt(width),
            low = value & ((1n << BigInt(width * 8)) - 1n);
          await using(
            compiler,
            code,
            LONG,
            async (cpu) => {
              const raw = banks(),
                before = input(0x1000n, { 0: address }, 0xcd7n);
              cpu.setState(before);
              cpu.setXmmState(raw);
              const successful = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(
                successful,
                'budget',
                1n,
                1n,
                0n,
                0n,
                changed(before, 0x1000n + BigInt(code.length / 2)),
              );
              raw[0] = insert ? (raw[0]! & ~(0xffffn << 48n)) | (low << 48n) : low;
              xmm(cpu, raw);
              noAlignment(successful);
              const next = input(0x1000n, { 0: address + 1n }, 0xcd7n);
              cpu.setState(next);
              const failed = await cpu.run({ budget: 1n, repeatBudget: 5n });
              outcome(failed, 'data-fault', 1n, 0n, 5n, 0n, next);
              xmm(cpu, raw);
              noAlignment(failed);
              fault(failed, {
                instructionPc: 0x1000n,
                segment: 'ds',
                address: address + 1n,
                width,
                access: 'read',
                cause: 'address-range',
                failingAddress: 1n << 64n,
              });
              memory(cpu, address, bytes(value, width));
            },
            { data: [{ base: address, bytes: bytes(value, width) }] },
          );
        }
      },
    },
  ];
}
