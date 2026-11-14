import { createCpu } from '../../../host/index.js';
import { exit, initial } from '../../support/fixture.js';
import { fixture, families, memory, put, same, using } from '../supervisor-access/fixture.js';
import { expected, merge, PC, equal, type Scenario } from './compound-fixture.js';

const permissions = { read: true, write: true, execute: true };

export function compoundAliasScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'compound ordered PUSHA payload retargets later stack slots through the live PTE',
      async run() {
        for (const family of families) {
          const side = { createCpu, compiler };
          const f = fixture(side, family, '60', { bits: 32 });
          const offset = 8 * f.width;
          f.leaf(0x8000, BigInt(f.pt) | 0x23n);
          await using(side, f, async (cpu) => {
            const before = initial(
              PC,
              { 0: 0x1122334400012063n, 4: BigInt(0x8000 + offset + 4) },
              2n,
            );
            cpu.setState(before);
            cpu.setTimeState({ tsc: 100n, tscAux: 7 });
            const result = await cpu.run({ budget: 1n });
            exit(
              result,
              'budget',
              1n,
              1n,
              expected(before, PC + 1n, { 4: BigInt(0x8000 + offset - 28) }),
            );
            const wanted = f.bytes.slice();
            put(wanted, f.pt + offset, 0x12063n, 4);
            for (let ordinal = 1; ordinal < 8; ordinal++)
              put(wanted, 0x12000 + offset - 4 * ordinal, before.registers[ordinal]!, 4);
            memory(cpu, wanted, 'first captured slot changes the next live translation');
            same(cpu.readTimeState(), { tsc: 101n, tscAux: 7 }, 'eight stores retire once');
          });
        }
      },
    },
    {
      name: 'compound post-begin A and D encoding aliases finish captured ENTER and fresh fault retry decodes new allocation',
      async run() {
        for (const family of families)
          for (const denyProbe of [false, true]) {
            const side = { createCpu, compiler };
            const f = fixture(side, family, 'c8030000');
            const width = family === 'non-pae' || family === 'pae' ? 4 : 8;
            const pte = f.pt + 8 * f.width;
            const frame = 0x9000 - width,
              endpoint = frame - 3;
            f.leaf(0x8000, 0x12003n);
            // The allocation byte is the low byte of the stack PTE, initially03.
            // Its A/D publications change the admitted source to23, then63.
            const maps = [
              { base: 0n, backing: 'ram', offset: 0, length: 0x8001, permissions },
              { base: 0x8001n, backing: 'ram', offset: pte, length: 1, permissions },
              {
                base: 0x8002n,
                backing: 'ram',
                offset: 0x8002,
                length: f.bytes.length - 0x8002,
                permissions,
              },
            ];
            if (denyProbe) {
              const physical = 0x12000 + endpoint - 0x8000;
              maps[2] = { ...maps[2]!, length: physical - 0x8002 };
              maps.push({
                base: BigInt(physical + 1),
                backing: 'ram',
                offset: physical + 1,
                length: f.bytes.length - physical - 1,
                permissions,
              });
            }
            f.options.memory!.mappings = maps;
            await using(side, f, async (cpu) => {
              const before = initial(PC, { 4: 0x9000n, 5: 0x7788n }, 2n);
              cpu.setState(before);
              cpu.setTimeState({ tsc: 100n, tscAux: 7 });
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              exit(
                result,
                denyProbe ? 'physical-memory-fault' : 'budget',
                1n,
                denyProbe ? 0n : 1n,
                denyProbe
                  ? before
                  : expected(before, PC + 4n, { 4: BigInt(endpoint), 5: BigInt(frame) }),
              );
              equal(result.resources.pagingRestarts, 0, 'begun source is not replayed');
              same(
                cpu.readTimeState(),
                { tsc: denyProbe ? 100n : 101n, tscAux: 7 },
                'captured attempt alone owns completion',
              );
              equal(
                cpu.readPhysicalMemory(0x8001n, 1)[0],
                0x63,
                'both A and D reached source alias',
              );
              if (denyProbe)
                same(
                  result.physicalMemoryFault,
                  {
                    instructionPc: PC,
                    address: BigInt(endpoint),
                    access: 'write',
                    physicalAddress: BigInt(0x12000 + endpoint - 0x8000),
                    width: 1,
                    failingPhysicalAddress: BigInt(0x12000 + endpoint - 0x8000),
                    physicalAccess: 'write',
                    cause: 'unmapped',
                    phase: 'final-access',
                    segment: 'ss',
                  },
                  'captured allocation owns late refusal',
                );
              const repaired = [
                maps[0]!,
                maps[1]!,
                {
                  base: 0x8002n,
                  backing: 'ram',
                  offset: 0x8002,
                  length: f.bytes.length - 0x8002,
                  permissions,
                },
              ];
              if (denyProbe) cpu.setMappings(repaired);
              const wanted = f.bytes.slice();
              put(wanted, pte, 0x12063n, f.width);
              wanted[0x8001] = 0x63;
              put(wanted, 0x12000 + frame - 0x8000, 0x7788n, width);
              memory(cpu, wanted, 'completed payload and real metadata residue only');
              // A separate attempt uses allocation63, including after a failed first attempt.
              cpu.setState(before);
              const retried = await cpu.run({ budget: 1n });
              exit(
                retried,
                'budget',
                1n,
                1n,
                expected(before, PC + 4n, { 4: BigInt(frame - 0x63), 5: BigInt(frame) }),
              );
              equal(retried.resources.compilations, 1, 'changed source owner is replaced');
              memory(cpu, wanted, 'fresh retry uses existing residue without hidden continuation');
            });
          }
      },
    },
    {
      name: 'compound POPA freezes a candidate before a later A alias changes its original source',
      async run() {
        for (const family of families)
          for (const width of [2, 4]) {
            const side = { createCpu, compiler };
            const f = fixture(side, family, (width === 2 ? '66' : '') + '61', { bits: 32 });
            const start = width === 2 ? 0x4ffa : 0x4ff4;
            const source = 0x9000 + start - 0x4000;
            const pte = f.pt + 5 * f.width;
            f.leaf(0x5000, 0x1b003n);
            const values = [
              0x11111103n,
              0x22222222n,
              0x33333333n,
              0x44444444n,
              0x55555555n,
              0x66666666n,
              0x77777777n,
            ];
            for (let i = 0; i < 3; i++) put(f.bytes, source + i * width, values[i]!, width);
            for (let i = 3; i < 7; i++) put(f.bytes, 0x1b000 + (i - 2) * width, values[i]!, width);
            f.options.memory!.mappings = [
              { base: 0n, backing: 'ram', offset: 0, length: pte, permissions },
              { base: BigInt(pte), backing: 'ram', offset: source, length: 1, permissions },
              {
                base: BigInt(pte + 1),
                backing: 'ram',
                offset: pte + 1,
                length: f.bytes.length - pte - 1,
                permissions,
              },
            ];
            await using(side, f, async (cpu) => {
              const before = initial(PC, { 4: 0x1122334400000000n + BigInt(start) }, 2n);
              cpu.setState(before);
              const registers: Record<number, bigint> = {
                4: before.registers[4]! + BigInt(8 * width),
              };
              for (const [i, bank] of [7, 6, 5, 3, 2, 1, 0].entries())
                registers[bank] = merge(before.registers[bank]!, values[i]!, width * 8);
              const result = await cpu.run({ budget: 1n });
              exit(
                result,
                'budget',
                1n,
                1n,
                expected(before, PC + BigInt(width === 2 ? 2 : 1), registers),
              );
              const wanted = f.bytes.slice();
              wanted[pte] = 0x23;
              wanted[source] = 0x23;
              memory(cpu, wanted, 'later A changes memory while the first read value stays frozen');
            });
          }
      },
    },
  ];
}
