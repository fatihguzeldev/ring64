import { createCpu } from '../../../host/index.js';
import {
  AC,
  DATA,
  PC,
  SMAP,
  families,
  fixture,
  memory,
  preserved,
  put,
  same,
  state,
  using,
  type Scenario,
} from './fixture.js';

export function supervisorOrderingScenarios(compiler: WebAssembly.Module): Scenario[] {
  const side = { createCpu, compiler };
  return [
    {
      name: 'supervisor denied access retains reached walk A bits while refusing D payload and retirement',
      async run() {
        for (const family of families)
          for (const write of [false, true]) {
            const f = fixture(side, family, write ? '8903' : '8b03');
            f.paging.cr4 |= SMAP;
            put(f.bytes, f.upper, BigInt(f.pt) | 7n, f.width);
            f.leaf(Number(PC), 0x8003n);
            f.leaf(Number(DATA), 0xa007n);
            await using(side, f, async (cpu) => {
              const before = state();
              cpu.setState(before);
              const numeric = preserved(cpu),
                result = await cpu.run({ budget: 1n });
              same(result.reason, 'page-fault', 'reached SMAP denial');
              same(result.retired, 0n, 'denied access no tick');
              same(result.state, before, 'denied access scalar');
              same(
                result.pageFault,
                {
                  vector: 14,
                  address: DATA,
                  access: write ? 'write' : 'read',
                  errorCode: write ? 3 : 1,
                  instructionPc: PC,
                },
                'reached SMAP fault',
              );
              const expected = f.bytes.slice();
              put(expected, f.upper, BigInt(f.pt) | 0x27n, f.width);
              put(expected, f.pt + f.width, 0x8023n, f.width);
              put(expected, f.pt + 6 * f.width, 0xa027n, f.width);
              memory(cpu, expected, 'only literal reached A effects');
              numeric();
            });
          }
      },
    },
    {
      name: 'supervisor physical A and D update refusals keep typed provenance and original CR2',
      async run() {
        for (const family of families)
          for (const dirty of [false, true]) {
            const f = fixture(side, family, dirty ? '8903' : '8b03');
            f.paging.cr4 |= SMAP;
            f.leaf(Number(DATA), dirty ? 0xa027n : 0xa007n);
            const slot = f.pt + 6 * f.width,
              end = slot + f.width;
            f.options.memory!.mappings = [
              {
                base: 0n,
                backing: 'ram',
                offset: 0,
                length: slot,
                permissions: { read: true, write: true, execute: true },
              },
              {
                base: BigInt(slot),
                backing: 'ram',
                offset: slot,
                length: f.width,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: BigInt(end),
                backing: 'ram',
                offset: end,
                length: f.bytes.length - end,
                permissions: { read: true, write: true, execute: true },
              },
            ];
            await using(side, f, async (cpu) => {
              const before = state(2n | (dirty ? AC : 0n));
              cpu.setState(before);
              const numeric = preserved(cpu),
                result = await cpu.run({ budget: 1n });
              same(
                result.reason,
                'physical-memory-fault',
                'physical walk update selected before later permission or payload',
              );
              same(result.retired, 0n, 'private update no retirement');
              same(result.state, before, 'private update scalar');
              same(
                result.physicalMemoryFault,
                {
                  instructionPc: PC,
                  address: DATA,
                  access: dirty ? 'write' : 'read',
                  physicalAddress: BigInt(slot),
                  width: f.width,
                  failingPhysicalAddress: BigInt(slot),
                  physicalAccess: 'write',
                  cause: 'permission',
                  phase: dirty ? 'dirty-write' : 'accessed-write',
                  segment: 'ds',
                },
                'literal A D physical provenance',
              );
              same(result.pageFault, undefined, 'private refusal is not guest PF');
              same(cpu.readPagingState(), f.paging, 'private update does not set CR2');
              memory(cpu, f.bytes, 'physical update denial commits no bytes');
              numeric();
            });
          }
      },
    },
    {
      name: 'supervisor missing lower entry wins over user upper permissions and private final backing remains enforced under AC',
      async run() {
        for (const family of families)
          for (const final of [false, true]) {
            const f = fixture(side, family, '8b03');
            f.paging.cr4 |= SMAP;
            f.leaf(Number(DATA), final ? 0xa067n : 0xa066n);
            if (final)
              f.options.memory!.mappings = [
                {
                  base: 0n,
                  backing: 'ram',
                  offset: 0,
                  length: 0xa000,
                  permissions: { read: true, write: true, execute: true },
                },
                {
                  base: 0xa000n,
                  backing: 'ram',
                  offset: 0xa000,
                  length: 4,
                  permissions: { read: false, write: true, execute: true },
                },
                {
                  base: 0xa004n,
                  backing: 'ram',
                  offset: 0xa004,
                  length: f.bytes.length - 0xa004,
                  permissions: { read: true, write: true, execute: true },
                },
              ];
            await using(side, f, async (cpu) => {
              const before = state(2n | (final ? AC : 0n));
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              same(
                result.reason,
                final ? 'physical-memory-fault' : 'page-fault',
                'lower or final failure wins',
              );
              same(result.state, before, 'lower failure scalar');
              same(result.retired, 0n, 'lower failure no retire');
              if (final)
                same(
                  result.physicalMemoryFault,
                  {
                    instructionPc: PC,
                    address: DATA,
                    access: 'read',
                    physicalAddress: 0xa000n,
                    width: 4,
                    failingPhysicalAddress: 0xa000n,
                    physicalAccess: 'read',
                    cause: 'permission',
                    phase: 'final-access',
                    segment: 'ds',
                  },
                  'AC cannot bypass physical backing',
                );
              else
                same(
                  result.pageFault,
                  { vector: 14, address: DATA, access: 'read', errorCode: 0, instructionPc: PC },
                  'missing lower entry before SMAP',
                );
              // Physical administration uses the same backing permissions: restore read access
              // only after recording the refusal packet, so inspection can cover every RAM byte.
              if (final)
                cpu.setMappings([
                  {
                    base: 0n,
                    backing: 'ram',
                    offset: 0,
                    length: f.bytes.length,
                    permissions: { read: true, write: true, execute: true },
                  },
                ]);
              memory(cpu, f.bytes, 'lower/final failure no payload');
            });
          }
      },
    },
  ];
}
