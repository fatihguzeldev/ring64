import { createCpu, type ExecutionContextSnapshot } from '../../../host/index.js';
import { exit, initial } from '../../support/fixture.js';
import {
  fixture,
  families,
  using,
  memory,
  put,
  same,
  preserved,
  AC,
  SMAP,
} from '../supervisor-access/fixture.js';
import { equal, merge, expected, PC, type Scenario } from './compound-fixture.js';

const side = (compiler: WebAssembly.Module) => ({ createCpu, compiler });

export function compoundPagingScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'compound ENTER endpoint is one write-only byte with A but no D payload pending write data DB or gap access',
      async run() {
        for (const family of families)
          for (const denial of ['none', 'page-write', 'private', 'write-only'] as const) {
            const s = side(compiler),
              width = family === 'non-pae' || family === 'pae' ? 4 : 8;
            const allocation = width === 4 ? 'fd2f' : 'f92f';
            const f = fixture(s, family, 'c8' + allocation + '00');
            f.paging.cr0 |= 0x10000n;
            f.leaf(0x3000, denial === 'page-write' ? 0x13005n : 0x13007n);
            f.leaf(0x4000, 0n);
            f.leaf(0x5000, 0n);
            f.leaf(0x6000, 0xa023n);
            if (denial === 'private' || denial === 'write-only') {
              f.options.memory!.mappings = [
                {
                  base: 0n,
                  backing: 'ram',
                  offset: 0,
                  length: 0x13fff,
                  permissions: { read: true, write: true, execute: true },
                },
                ...(denial === 'write-only'
                  ? [
                      {
                        base: 0x13fffn,
                        backing: 'ram',
                        offset: 0x13fff,
                        length: 1,
                        permissions: { read: false, write: true, execute: false },
                      },
                    ]
                  : []),
                {
                  base: 0x14000n,
                  backing: 'ram',
                  offset: 0x14000,
                  length: f.bytes.length - 0x14000,
                  permissions: { read: true, write: true, execute: true },
                },
              ];
            }
            await using(s, f, async (cpu) => {
              const before = initial(PC, { 4: 0x7000n, 5: 0x8000n }, 2n);
              cpu.setState(before);
              cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
              cpu.setDebugState({ addresses: [0x3fffn, 0n, 0n, 0n], dr6: 0n, dr7: 0x10401n });
              const debug = cpu.readDebugState(),
                numeric = preserved(cpu);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              const admitted = denial === 'none' || denial === 'write-only';
              exit(
                result,
                admitted
                  ? 'budget'
                  : denial === 'page-write'
                    ? 'page-fault'
                    : 'physical-memory-fault',
                1n,
                admitted ? 1n : 0n,
                admitted
                  ? expected(before, PC + 4n, { 4: 0x3fffn, 5: 0x7000n - BigInt(width) })
                  : before,
              );
              equal(result.repeatIterations, 0n, 'probe consumes no REP work');
              same(
                cpu.readTimeState(),
                { tsc: admitted ? 101n : 100n, tscAux: 0x89abcdef },
                'probe retirement ledger',
              );
              same(cpu.readDebugState(), debug, 'probe has no data breakpoint footprint');
              equal(result.debugException, undefined, 'no endpoint data trap');
              if (denial === 'page-write')
                same(
                  result.pageFault,
                  {
                    vector: 14,
                    instructionPc: PC,
                    address: 0x3fffn,
                    access: 'write',
                    errorCode: 3,
                  },
                  'endpoint exact write PF',
                );
              if (denial === 'private')
                same(
                  result.physicalMemoryFault,
                  {
                    instructionPc: PC,
                    address: 0x3fffn,
                    access: 'write',
                    physicalAddress: 0x13fffn,
                    width: 1,
                    failingPhysicalAddress: 0x13fffn,
                    physicalAccess: 'write',
                    cause: 'unmapped',
                    phase: 'final-access',
                    segment: 'ss',
                  },
                  'endpoint exact private byte refusal',
                );
              const wanted = f.bytes.slice();
              put(wanted, 0xaffc - (width - 4), 0x8000n, width);
              put(
                wanted,
                f.pt + 3 * f.width,
                denial === 'page-write' ? 0x13025n : 0x13027n,
                f.width,
              );
              put(wanted, f.pt + 6 * f.width, 0xa063n, f.width);
              // Restore physical inspection rights after capturing write-only/hole outcomes.
              if (denial === 'private' || denial === 'write-only')
                cpu.setMappings([
                  {
                    base: 0n,
                    backing: 'ram',
                    offset: 0,
                    length: f.bytes.length,
                    permissions: { read: true, write: true, execute: true },
                  },
                ]);
              memory(cpu, wanted, 'one-byte probe retains exact payload and A/D image');
              numeric();
            });
          }
      },
    },
    {
      name: 'compound POPA actual SS-limit prefix differs from page and private rollback after the same three loads',
      async run() {
        for (const family of families)
          for (const width of [2, 4])
            for (const failure of ['ss-limit', 'pf', 'private'] as const) {
              const s = side(compiler),
                code = (width === 2 ? '66' : '') + '61';
              const f = fixture(s, family, code, { bits: 32 });
              const execution = f.options.context as ExecutionContextSnapshot;
              execution.segments.ss.limit = failure === 'ss-limit' ? 0xffff : 0x1ffff;
              const start = width === 2 ? 0xfffa : 0xfff4;
              const address = width === 2 ? 0x10002n : 0x10004n;
              if (failure === 'pf') f.leaf(0x10000, 0n);
              if (failure === 'private') {
                const physical = Number(address) + 0x10000;
                f.options.memory!.mappings = [
                  {
                    base: 0n,
                    backing: 'ram',
                    offset: 0,
                    length: physical,
                    permissions: { read: true, write: true, execute: true },
                  },
                  {
                    base: BigInt(physical + width),
                    backing: 'ram',
                    offset: physical + width,
                    length: f.bytes.length - physical - width,
                    permissions: { read: true, write: true, execute: true },
                  },
                ];
              }
              for (let index = 0; index < 3; index++)
                put(
                  f.bytes,
                  0x10000 + start + index * width,
                  [0x10101010n, 0x20202020n, 0x30303030n][index]!,
                  width,
                );
              await using(s, f, async (cpu) => {
                const before = initial(
                  PC,
                  { 4: 0x1122334400000000n + BigInt(start), 5: 0x5566778800006000n },
                  0xcd7n,
                );
                cpu.setState(before);
                cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
                const wanted =
                  failure === 'ss-limit'
                    ? expected(before, PC, {
                        7: merge(before.registers[7]!, 0x10101010n, width * 8),
                        6: merge(before.registers[6]!, 0x20202020n, width * 8),
                        5: merge(before.registers[5]!, 0x30303030n, width * 8),
                      })
                    : before;
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                exit(
                  result,
                  failure === 'ss-limit'
                    ? 'segment-fault'
                    : failure === 'pf'
                      ? 'page-fault'
                      : 'physical-memory-fault',
                  1n,
                  0n,
                  wanted,
                );
                same(
                  cpu.readTimeState(),
                  { tsc: 100n, tscAux: 0x89abcdef },
                  'failed POPA no virtual tick',
                );
                if (failure === 'ss-limit')
                  same(
                    result.segmentFault,
                    {
                      instructionPc: PC,
                      segment: 'ss',
                      offset: address,
                      width,
                      access: 'read',
                      cause: 'limit',
                      failingOffset: address,
                    },
                    'actual fourth read limit tuple',
                  );
                else if (failure === 'pf')
                  same(
                    result.pageFault,
                    { vector: 14, instructionPc: PC, address, access: 'read', errorCode: 0 },
                    'actual fourth read PF tuple',
                  );
                else {
                  same(
                    result.physicalMemoryFault,
                    {
                      instructionPc: PC,
                      address,
                      access: 'read',
                      physicalAddress: address + 0x10000n,
                      width,
                      failingPhysicalAddress: address + 0x10000n,
                      physicalAccess: 'read',
                      cause: 'unmapped',
                      phase: 'final-access',
                      segment: 'ss',
                    },
                    'actual fourth read private tuple',
                  );
                  cpu.setMappings([
                    {
                      base: 0n,
                      backing: 'ram',
                      offset: 0,
                      length: f.bytes.length,
                      permissions: { read: true, write: true, execute: true },
                    },
                  ]);
                }
                memory(cpu, f.bytes, 'failed POPA preserves all physical payloads');
              });
            }
      },
    },
    {
      name: 'compound SS operands use ordinary CPL and live AC under SMAP in every paged family',
      async run() {
        for (const family of families)
          for (const cpl of [0, 1, 2, 3])
            for (const user of [false, true])
              for (const ac of [false, true])
                for (const operation of ['enter', 'pusha', 'popa'] as const) {
                  const s = side(compiler),
                    code = operation === 'enter' ? 'c8000000' : operation === 'pusha' ? '60' : '61';
                  const f = fixture(s, family, code, { cpl, bits: 32 });
                  f.paging.cr4 |= SMAP;
                  f.leaf(0x4000, user ? 0x9067n : 0x9063n);
                  const sp = operation === 'popa' ? 0x4fc0n : 0x5000n;
                  for (let ordinal = 0; ordinal < 8; ordinal++)
                    put(f.bytes, 0x9fc0 + ordinal * 4, 0x12340000n + BigInt(ordinal), 4);
                  await using(s, f, async (cpu) => {
                    const before = initial(PC, { 4: sp, 5: 0x6000n }, 2n | (ac ? AC : 0n));
                    cpu.setState(before);
                    cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
                    const admitted = cpl === 3 ? user : !user || ac;
                    const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                    const registers: Record<number, bigint> = {};
                    const wanted = f.bytes.slice();
                    if (admitted) {
                      if (operation === 'enter') {
                        registers[4] = 0x4ffcn;
                        registers[5] = 0x4ffcn;
                        put(wanted, 0x9ffc, before.registers[5]!, 4);
                      } else if (operation === 'pusha') {
                        registers[4] = 0x4fe0n;
                        for (let bank = 0; bank < 8; bank++)
                          put(wanted, 0xa000 - (bank + 1) * 4, before.registers[bank]!, 4);
                      } else {
                        registers[4] = 0x4fe0n;
                        for (const [bank, ordinal] of [
                          [7, 0],
                          [6, 1],
                          [5, 2],
                          [3, 4],
                          [2, 5],
                          [1, 6],
                          [0, 7],
                        ])
                          registers[bank!] = merge(
                            before.registers[bank!]!,
                            0x12340000n + BigInt(ordinal!),
                            32,
                          );
                      }
                    }
                    exit(
                      result,
                      admitted ? 'budget' : 'page-fault',
                      1n,
                      admitted ? 1n : 0n,
                      admitted ? expected(before, PC + BigInt(code.length / 2), registers) : before,
                    );
                    same(
                      cpu.readTimeState(),
                      { tsc: admitted ? 101n : 100n, tscAux: 0x89abcdef },
                      'SMAP exact retirement',
                    );
                    if (!admitted)
                      same(
                        result.pageFault,
                        {
                          vector: 14,
                          instructionPc: PC,
                          address: operation === 'popa' ? sp : 0x4ffcn,
                          access: operation === 'popa' ? 'read' : 'write',
                          errorCode: (operation === 'popa' ? 1 : 3) | (cpl === 3 ? 4 : 0),
                        },
                        'ordinary stack PFEC and first address',
                      );
                    memory(cpu, wanted, 'SMAP full physical payload');
                  });
                }
      },
    },
    {
      name: 'compound helpers observe STAC in the same generated run before user-stack admission',
      async run() {
        for (const family of families) {
          const s = side(compiler),
            f = fixture(s, family, '0f01cbc8000000', { bits: 32 });
          f.paging.cr4 |= SMAP;
          f.leaf(0x4000, 0x9067n);
          await using(s, f, async (cpu) => {
            const before = initial(PC, { 4: 0x5000n, 5: 0x6000n }, 2n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 2n, repeatBudget: 0n });
            exit(result, 'budget', 2n, 2n, {
              ...expected(before, PC + 7n, { 4: 0x4ffcn, 5: 0x4ffcn }),
              flags: 2n | AC,
            });
            const wanted = f.bytes.slice();
            put(wanted, 0x9ffc, 0x6000n, 4);
            memory(cpu, wanted, 'same-run AC authorizes actual stack payload');
          });
        }
      },
    },
  ];
}
