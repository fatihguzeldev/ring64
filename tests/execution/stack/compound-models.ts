import { createCpu } from '../../../host/index.js';
import { exit } from '../../support/fixture.js';
import {
  profiles,
  using as usingModel,
  input,
  execution,
  type Profile,
} from '../identity-time/oracle.js';
import { fixture, using, put, memory, preserved, same, hex } from '../supervisor-access/fixture.js';
import { expected, merge, PC, equal, type Scenario } from './compound-fixture.js';

const modelProfiles: Profile[] = [
  ...profiles
    .filter((p) => p.mode === 'real' || p.mode === 'protected' || p.mode === 'virtual8086')
    .map((p) => ({ ...p, family: 'pg0' as const })),
  ...profiles
    .filter((p) => p.mode === 'protected')
    .flatMap((p) => (['legacy32', 'pae'] as const).map((family) => ({ ...p, family }))),
  ...profiles
    .filter((p) => p.mode === 'compatibility' || p.mode === 'long64')
    .flatMap((p) => (['ia32e', 'fixed'] as const).map((family) => ({ ...p, family }))),
];
const low = (value: bigint, bits: number) => value & ((1n << BigInt(bits)) - 1n);
const prefix = (profile: Profile, width: number) => (width * 8 === profile.bits ? '' : '66');
const scalar = (profile: Profile) => {
  const before = input(profile);
  before.registers[4] =
    profile.bits === 64
      ? 0x9000n
      : 0x1122334400000000n | ((profile.stack ?? 32) === 16 ? 0x19000n : 0x9000n);
  before.registers[5] = profile.bits === 64 ? 0x123456789abcdef0n : 0x5566778800025678n;
  return before;
};

export function compoundModelScenarios(compiler: WebAssembly.Module): Scenario[] {
  const side = { createCpu, compiler };
  return [
    {
      name: 'compound ENTER raw banks and full state across every admitted physical mode and paging family',
      async run() {
        equal(modelProfiles.length, 27, 'authored non-linear mode/family coverage');
        for (const profile of modelProfiles)
          for (const width of profile.bits === 64 ? [2, 8] : [2, 4]) {
            const code = prefix(profile, width) + 'c8200000';
            await usingModel(side, code, profile, async (cpu) => {
              const before = scalar(profile);
              const stackBits = profile.bits === 64 ? 64 : (profile.stack ?? 32);
              const cursor = low(before.registers[4]! - BigInt(width), stackBits);
              const pushedBank = merge(before.registers[4]!, cursor, stackBits);
              const frame = low(pushedBank, width * 8);
              const wanted = cpu.readPhysicalMemory(0n, 0x50000);
              put(wanted, Number(cursor), before.registers[5]!, width);
              const numeric = preserved(cpu);
              const bank = cpu.readPagingState();
              cpu.setState(before);
              cpu.setTimeState({ tsc: 100n, tscAux: 7 });
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              exit(
                result,
                'budget',
                1n,
                1n,
                expected(before, PC + BigInt(code.length / 2), {
                  4: merge(before.registers[4]!, cursor - 0x20n, stackBits),
                  5: merge(before.registers[5]!, frame, width * 8),
                }),
              );
              equal(result.repeatIterations, 0n, 'ENTER has no repeat progress');
              equal(result.remainingRepeatBudget, 0n, 'ENTER leaves repeat budget');
              same(cpu.readTimeState(), { tsc: 101n, tscAux: 7 }, 'one model ENTER retirement');
              same(cpu.readContext(), execution(profile), 'complete model context');
              same(cpu.readPagingState(), bank, 'warm identity controls retain CR2 and PDPTE bank');
              memory(cpu, wanted, 'model ENTER full physical payload and guards');
              numeric();
            });
          }
      },
    },
    {
      name: 'compound PUSHA and POPA independently preserve raw upper banks across all legacy physical models',
      async run() {
        for (const profile of modelProfiles.filter((p) => p.mode !== 'long64'))
          for (const width of [2, 4])
            for (const pop of [false, true]) {
              const code = prefix(profile, width) + (pop ? '61' : '60');
              await usingModel(side, code, profile, async (cpu) => {
                const before = scalar(profile);
                const stackBits = profile.stack ?? 32;
                const sp = low(before.registers[4]!, stackBits);
                const wanted = cpu.readPhysicalMemory(0n, 0x50000);
                const changes: Record<number, bigint> = {};
                if (pop) {
                  const values = [
                    0x11112222n,
                    0x33334444n,
                    0x55556666n,
                    0xdeadbeefn,
                    0x77778888n,
                    0x9999aaaan,
                    0xbbbbccccn,
                    0xddddeeeen,
                  ];
                  for (let slot = 0; slot < 8; slot++)
                    put(wanted, Number(sp) + slot * width, values[slot]!, width);
                  cpu.writePhysicalMemory(sp, wanted.slice(Number(sp), Number(sp) + 8 * width));
                  for (const [index, register] of [7, 6, 5, 3, 2, 1, 0].entries())
                    changes[register] = merge(
                      before.registers[register]!,
                      values[index < 3 ? index : index + 1]!,
                      width * 8,
                    );
                } else {
                  for (let register = 0; register < 8; register++)
                    put(
                      wanted,
                      Number(low(sp - BigInt((register + 1) * width), stackBits)),
                      before.registers[register]!,
                      width,
                    );
                }
                changes[4] = merge(
                  before.registers[4]!,
                  sp + BigInt((pop ? 8 : -8) * width),
                  stackBits,
                );
                const numeric = preserved(cpu);
                const bank = cpu.readPagingState();
                cpu.setState(before);
                cpu.setTimeState({ tsc: 100n, tscAux: 7 });
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                exit(
                  result,
                  'budget',
                  1n,
                  1n,
                  expected(before, PC + BigInt(code.length / 2), changes),
                );
                equal(result.repeatIterations, 0n, 'whole-register stack has no repeat progress');
                equal(
                  result.remainingRepeatBudget,
                  0n,
                  'whole-register stack leaves repeat budget',
                );
                same(
                  cpu.readTimeState(),
                  { tsc: 101n, tscAux: 7 },
                  'one whole-register retirement',
                );
                same(cpu.readContext(), execution(profile), 'complete physical stack context');
                same(cpu.readPagingState(), bank, 'warm physical stack controls');
                memory(cpu, wanted, 'whole-register full physical footprint');
                numeric();
              });
            }
      },
    },
    {
      name: 'compound ENTER crosses 4KiB and large-leaf boundaries with exact ordered payload or retained prefix',
      async run() {
        for (const family of ['non-pae', 'pae', 'ia32e', 'fixed'] as const)
          for (const mode of ['inside', 'boundary', 'denied'] as const) {
            const width = family === 'non-pae' || family === 'pae' ? 4 : 8;
            const boundary = family === 'non-pae' ? 0x400000 : 0x200000;
            const nesting = mode === 'inside' ? 0 : 1;
            const code = mode === 'inside' ? 'c8100000' : 'c8000001';
            const f = fixture(side, family, code);
            f.paging.cr0 |= 0x10000n;
            f.paging.cr3 = 0x10000n;
            const first = mode === 'denied' ? 0xe1n : 0xe3n;
            if (family === 'non-pae') {
              f.paging.cr4 |= 0x10n;
              put(f.bytes, 0x10000, first, 4);
              put(f.bytes, 0x10004, 0xe3n, 4);
            } else if (family === 'pae') {
              f.paging.pdpte = [0x11001n, 0n, 0n, 0n];
              put(f.bytes, 0x10000, 0x11001n);
              put(f.bytes, 0x11000, first);
              put(f.bytes, 0x11008, 0xe3n);
            } else {
              put(f.bytes, 0x10000, 0x11027n);
              put(f.bytes, 0x11000, 0x12027n);
              put(f.bytes, 0x12000, first);
              put(f.bytes, 0x12008, 0xe3n);
            }
            f.bytes.set(hex(code), Number(PC));
            f.options.memory!.mappings.push({
              base: BigInt(boundary - width),
              backing: 'ram',
              offset: 0x20000,
              length: width,
              permissions: { read: true, write: true, execute: false },
            });
            await using(side, f, async (cpu) => {
              const before = input({
                mode: width === 8 ? 'long64' : 'protected',
                bits: width === 8 ? 64 : 32,
              });
              before.registers[4] = BigInt(mode === 'inside' ? 0x5002 : boundary + width);
              before.registers[5] = 0x7788n;
              const numeric = preserved(cpu);
              const completeContext = cpu.readContext();
              cpu.setState(before);
              cpu.setTimeState({ tsc: 100n, tscAux: 7 });
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              const denied = mode === 'denied';
              const frame = mode === 'inside' ? 0x5002 - width : boundary;
              const final = frame - (nesting ? width : 0x10);
              exit(
                result,
                denied ? 'page-fault' : 'budget',
                1n,
                denied ? 0n : 1n,
                denied ? before : expected(before, PC + 4n, { 4: BigInt(final), 5: BigInt(frame) }),
              );
              same(
                cpu.readTimeState(),
                { tsc: denied ? 100n : 101n, tscAux: 7 },
                'large leaf one completion or fault',
              );
              same(cpu.readContext(), completeContext, 'large leaf complete context');
              same(
                result.pageFault,
                denied
                  ? {
                      vector: 14,
                      instructionPc: PC,
                      address: BigInt(boundary - width),
                      access: 'write',
                      errorCode: 3,
                    }
                  : undefined,
                'large boundary exact second-push fault',
              );
              const wanted = f.bytes.slice();
              put(wanted, mode === 'inside' ? frame : 0, 0x7788n, width);
              if (mode === 'boundary') put(wanted, 0x20000, BigInt(boundary), width);
              memory(cpu, wanted, 'large leaf complete payload and retained prefix');
              same(
                cpu.readPhysicalMemory(BigInt(boundary - width), width),
                wanted.slice(0x20000, 0x20000 + width),
                'large-edge physical alias bytes',
              );
              equal(result.repeatIterations, 0n, 'large leaf no REP progress');
              equal(result.remainingRepeatBudget, 0n, 'large leaf no REP allowance');
              numeric();
            });
          }
      },
    },
  ];
}
