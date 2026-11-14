import { createCpu } from '../../../host/index.js';
import { exit, initial } from '../../support/fixture.js';
import {
  fixture,
  families,
  using,
  memory as physicalMemory,
} from '../supervisor-access/fixture.js';
import {
  PC,
  RAM_BASE,
  RAM_SIZE,
  compoundProfiles,
  input,
  expected,
  linear,
  memory,
  completed,
  put,
  same,
  bytes,
  hex,
  preserved,
  type Scenario,
} from './compound-fixture.js';

export function compoundOrderingScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'compound ENTER fixed-point frame alias reads each preceding pushed payload before continuing',
      async run() {
        const profile = compoundProfiles.find((p) => p.name === 'protected/32/32')!;
        const ram = new Uint8Array(RAM_SIZE).fill(0xa5);
        put(ram, 0xffc, 0x11111111n, 4);
        put(ram, 0xff8, 0x22222222n, 4);
        await linear(
          compiler,
          'c8000003',
          profile,
          async (cpu) => {
            const before = input(profile, { 4: 0x5000n, 5: 0x5000n });
            cpu.setState(before);
            cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
            completed(cpu, await cpu.run({ budget: 1n, repeatBudget: 0n }), before, PC + 4n, {
              4: 0x4ff0n,
              5: 0x4ffcn,
            });
            const wanted = ram.slice();
            for (const [at, value] of [
              [0xffc, 0x5000n],
              [0xff8, 0x5000n],
              [0xff4, 0x5000n],
              [0xff0, 0x4ffcn],
            ] as const)
              put(wanted, at, value, 4);
            memory(cpu, RAM_BASE, wanted, 'progressive source bytes and full guards');
          },
          { ram },
        );
      },
    },
    {
      name: 'compound cross-page slot tail and dirty-update refusals retain the previous slot but no current payload fragment',
      async run() {
        for (const family of families)
          for (const failure of ['none', 'private-tail', 'dirty-update'] as const) {
            const side = { createCpu, compiler },
              f = fixture(side, family, 'c8000001');
            const width = family === 'non-pae' || family === 'pae' ? 4 : 8;
            const address = BigInt(0x5001 - width);
            f.leaf(0x4000, failure === 'dirty-update' ? 0x9023n : 0x9003n);
            f.leaf(0x5000, 0x15003n);
            if (failure !== 'none') {
              const at = failure === 'private-tail' ? 0x15000 : f.pt + 4 * f.width;
              const length = failure === 'private-tail' ? 1 : f.width;
              f.options.memory!.mappings = [
                {
                  base: 0n,
                  backing: 'ram',
                  offset: 0,
                  length: at,
                  permissions: { read: true, write: true, execute: true },
                },
                {
                  base: BigInt(at),
                  backing: 'ram',
                  offset: at,
                  length,
                  permissions: { read: true, write: false, execute: true },
                },
                {
                  base: BigInt(at + length),
                  backing: 'ram',
                  offset: at + length,
                  length: f.bytes.length - at - length,
                  permissions: { read: true, write: true, execute: true },
                },
              ];
            }
            await using(side, f, async (cpu) => {
              const before = initial(PC, { 4: BigInt(0x5001 + width), 5: 0x8000n }, 2n);
              cpu.setState(before);
              cpu.setTimeState({ tsc: 100n, tscAux: 0x89abcdef });
              const numeric = preserved(cpu),
                result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              exit(
                result,
                failure === 'none' ? 'budget' : 'physical-memory-fault',
                1n,
                failure === 'none' ? 1n : 0n,
                failure === 'none' ? expected(before, PC + 4n, { 4: address, 5: 0x5001n }) : before,
              );
              same(
                cpu.readTimeState(),
                { tsc: failure === 'none' ? 101n : 100n, tscAux: 0x89abcdef },
                'split slot retirement ledger',
              );
              if (failure !== 'none') {
                const dirty = failure === 'dirty-update',
                  physical = dirty ? BigInt(f.pt + 4 * f.width) : 0x15000n;
                same(
                  result.physicalMemoryFault,
                  {
                    instructionPc: PC,
                    address: dirty ? address : 0x5000n,
                    access: 'write',
                    physicalAddress: physical,
                    width: dirty ? f.width : 1,
                    failingPhysicalAddress: physical,
                    physicalAccess: 'write',
                    cause: 'permission',
                    phase: dirty ? 'dirty-write' : 'final-access',
                    segment: 'ss',
                  },
                  'late refusal preserves actual fragment or D provenance',
                );
              }
              const wanted = f.bytes.slice();
              put(wanted, 0x15001, 0x8000n, width);
              put(wanted, f.pt + 4 * f.width, failure === 'none' ? 0x9063n : 0x9023n, f.width);
              put(wanted, f.pt + 5 * f.width, 0x15063n, f.width);
              if (failure === 'none') {
                const payload = hex(bytes(0x5001n, width));
                wanted.set(payload.subarray(0, width - 1), 0xa001 - width);
                wanted[0x15000] = payload[width - 1]!;
              }
              physicalMemory(
                cpu,
                wanted,
                'full physical image proves refusing slot has no partial payload',
              );
              numeric();
            });
          }
      },
    },
  ];
}
