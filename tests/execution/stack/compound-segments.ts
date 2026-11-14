import { createCpu } from '../../../host/index.js';
import { exit, memory as scalarMemory, initial } from '../../support/fixture.js';
import { using as usingProfile, type Profile } from '../identity-time/oracle.js';
import {
  PC,
  compoundProfiles,
  input,
  expected,
  linear,
  same,
  equal,
  put,
  hex,
  type CompoundProfile,
  type Scenario,
} from './compound-fixture.js';

export function compoundSegmentScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'compound ENTER final SS-limit byte permits write-only storage and never probes its neighboring byte',
      async run() {
        for (const limitFailure of [false, true])
          for (const prefix of ['', '6467']) {
            const profile = structuredClone(
              compoundProfiles.find((p) => p.name === 'protected/16/16')!,
            ) as CompoundProfile;
            if ('segments' in profile.execution) {
              profile.execution.segments.ss.limit = limitFailure ? 0xfffe : 0xffff;
              profile.execution.segments.fs.base = 0x20000n;
            }
            const code = prefix + 'c8010000';
            await linear(
              compiler,
              code,
              profile,
              async (cpu) => {
                const before = input(profile, { 4: 0x1122334400010002n, 5: 0x5566778800021234n });
                cpu.setState(before);
                cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                exit(
                  result,
                  limitFailure ? 'segment-fault' : 'budget',
                  1n,
                  limitFailure ? 0n : 1n,
                  limitFailure
                    ? before
                    : expected(before, PC + BigInt(code.length / 2), {
                        4: 0x112233440001ffffn,
                        5: 0x5566778800020000n,
                      }),
                );
                if (limitFailure)
                  same(
                    result.segmentFault,
                    {
                      instructionPc: PC,
                      segment: 'ss',
                      offset: 0xffffn,
                      width: 1,
                      access: 'write',
                      cause: 'limit',
                      failingOffset: 0xffffn,
                    },
                    'only endpoint byte has SS limit fault',
                  );
                same(
                  cpu.readTimeState(),
                  { tsc: limitFailure ? 100n : 101n, tscAux: 0x89abcdef },
                  'SS endpoint ledger',
                );
                // Physical/data administration is separate from guest read permission.
                cpu.setMappings([
                  {
                    base: PC,
                    backing: 'code',
                    offset: 0,
                    length: code.length / 2,
                    permissions: { read: true, write: false, execute: true },
                  },
                  {
                    base: 0n,
                    backing: 'data0',
                    offset: 0,
                    length: 2,
                    permissions: { read: true, write: true, execute: false },
                  },
                  {
                    base: 0xffffn,
                    backing: 'data1',
                    offset: 0,
                    length: 1,
                    permissions: { read: true, write: true, execute: false },
                  },
                ]);
                scalarMemory(cpu, 0n, '3412');
                scalarMemory(cpu, 0xffffn, 'a5');
              },
              {
                data: [
                  { base: 0n, bytes: 'a5a5', read: false },
                  { base: 0xffffn, bytes: 'a5', read: false },
                ],
              },
            );
          }
      },
    },
    {
      name: 'compound canonical real odd-SP PUSHA retains ordered payload and earlier private refusals before future SS',
      async run() {
        const profile: Profile = { mode: 'real', bits: 16, stack: 16, family: 'pg0' };
        for (const width of [2, 4])
          for (const sp of [1n, 3n, 5n, 7n, 9n, 11n, 13n, 15n])
            for (const privateFirst of [false, true]) {
              const first = (sp - BigInt(width)) & 0xffffn;
              const privateApplicable = first + BigInt(width) <= 0x10000n && sp < 7n;
              if (privateFirst && !privateApplicable) continue;
              const code = (width === 4 ? '66' : '') + '60';
              await usingProfile({ createCpu, compiler }, code, profile, async (cpu) => {
                const before = initial(
                  PC,
                  { 0: 0x1122334455667788n, 1: 0x9988776655443322n, 4: 0x1122334400010000n + sp },
                  2n,
                );
                cpu.setState(before);
                cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
                const wanted = cpu.readPhysicalMemory(0n, 0x50000);
                if (privateFirst)
                  cpu.setMappings([
                    {
                      base: 0n,
                      backing: 'ram',
                      offset: 0,
                      length: Number(first),
                      permissions: { read: true, write: true, execute: true },
                    },
                    {
                      base: first,
                      backing: 'ram',
                      offset: Number(first),
                      length: width,
                      permissions: { read: true, write: false, execute: true },
                    },
                    {
                      base: first + BigInt(width),
                      backing: 'ram',
                      offset: Number(first) + width,
                      length: 0x50000 - Number(first) - width,
                      permissions: { read: true, write: true, execute: true },
                    },
                  ]);
                const gp = sp >= 7n;
                let cursor = sp,
                  ordinal = 0;
                if (!gp && !privateFirst)
                  while (ordinal < 8) {
                    cursor = (cursor - BigInt(width)) & 0xffffn;
                    if (cursor + BigInt(width) > 0x10000n) break;
                    put(wanted, Number(cursor), before.registers[ordinal]!, width);
                    ordinal += 1;
                  }
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                exit(
                  result,
                  gp
                    ? 'protection-fault'
                    : privateFirst
                      ? 'physical-memory-fault'
                      : 'segment-fault',
                  1n,
                  0n,
                  before,
                );
                if (gp)
                  same(
                    result.protectionFault,
                    { vector: 13, errorCode: 0, phase: 'target', instructionPc: PC },
                    'canonical GP before payload',
                  );
                else if (privateFirst)
                  same(
                    result.physicalMemoryFault,
                    {
                      instructionPc: PC,
                      address: first,
                      access: 'write',
                      physicalAddress: first,
                      width,
                      failingPhysicalAddress: first,
                      physicalAccess: 'write',
                      cause: 'permission',
                      phase: 'final-access',
                      segment: 'ss',
                    },
                    'first actual private store precedes later SS',
                  );
                else
                  same(
                    result.segmentFault,
                    {
                      instructionPc: PC,
                      segment: 'ss',
                      offset: cursor,
                      width,
                      access: 'write',
                      cause: 'limit',
                      failingOffset: 0x10000n,
                    },
                    'first real slot outside segment',
                  );
                same(
                  cpu.readPhysicalMemory(0n, wanted.length),
                  wanted,
                  'literal real partial payload and guards',
                );
                same(
                  cpu.readTimeState(),
                  { tsc: 100n, tscAux: 0x89abcdef },
                  'source refusal no retirement',
                );
              });
            }
      },
    },
    {
      name: 'compound real PUSHA source SS escalates only through bounded delivery attempts',
      async run() {
        const profile: Profile = { mode: 'real', bits: 16, stack: 16, family: 'pg0' };
        for (const allowance of [0n, 1n, 2n])
          await usingProfile({ createCpu, compiler }, '60', profile, async (cpu) => {
            cpu.writePhysicalMemory(0x7030n, hex('00200000'));
            cpu.writePhysicalMemory(0x7020n, hex('00300000'));
            const before = initial(PC, { 0: 0x1122334455667788n, 4: 3n }, 2n);
            cpu.setState(before);
            cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
            const result = await cpu.run({
              budget: 1n,
              repeatBudget: 0n,
              eventDelivery: { budget: allowance },
            });
            equal(
              result.reason,
              allowance === 2n ? 'shutdown' : 'event-budget',
              'bounded real source escalation',
            );
            equal(result.retired, 0n, 'failed source never retires');
            equal(result.deliveryAttempts, allowance, 'each entry attempt is charged separately');
            equal(result.remainingDeliveryBudget, 0n, 'exact entry allowance consumed');
            same(result.state.registers, before.registers, 'escalation keeps original source GPRs');
            same(
              result.state.event,
              allowance === 2n
                ? { kind: 'shutdown' }
                : {
                    kind: 'pending',
                    exception: {
                      vector: allowance === 0n ? 12 : 8,
                      instructionPc: PC,
                      returnPc: PC,
                      savedFlags: 0x10002n,
                      errorCode: 0,
                    },
                  },
              'source SS versus retained DF versus shutdown',
            );
            same(
              cpu.readPhysicalMemory(1n, 2),
              hex('8877'),
              'PUSHA prefix exists before failed entry',
            );
            same(
              cpu.readTimeState(),
              { tsc: 100n, tscAux: 0x89abcdef },
              'delivery is not retired time',
            );
          });
      },
    },
  ];
}
