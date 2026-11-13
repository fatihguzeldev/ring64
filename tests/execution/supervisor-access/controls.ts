import { createCpu } from '../../../host/index.js';
import {
  AC,
  AUX,
  DATA,
  PC,
  SMEP,
  SMAP,
  check,
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

export function supervisorControlScenarios(compiler: WebAssembly.Module): Scenario[] {
  const side = { createCpu, compiler };
  return [
    {
      name: 'supervisor legacy PAE SMEP toggles capture quartet while SMAP and same-value writes retain it',
      async run() {
        for (const initial of [0n, SMEP, SMAP, SMEP | SMAP])
          for (const change of [0n, SMEP, SMAP, SMEP | SMAP]) {
            const f = fixture(side, 'pae', '0f22e0');
            f.paging.cr4 |= initial;
            put(f.bytes, 0x1008, 0x5001n);
            await using(side, f, async (cpu) => {
              const next = f.paging.cr4 ^ change,
                before = state(2n | AC);
              before.registers[0] = next;
              cpu.setState(before);
              cpu.setTimeState({ tsc: 100n, tscAux: AUX });
              const numeric = preserved(cpu);
              const result = await cpu.run({ budget: 1n });
              same(result.reason, 'budget', 'valid CR4 writer');
              same(result.retired, 1n, 'CR4 writer retires once');
              same(result.state, { ...before, rip: PC + 3n }, 'CR4 does not modify AC or GPR');
              same(
                cpu.readPagingState(),
                { ...f.paging, cr4: next, pdpte: [0x2001n, change & SMEP ? 0x5001n : 0n, 0n, 0n] },
                'literal quartet reload predicate',
              );
              same(cpu.readTimeState(), { tsc: 101n, tscAux: AUX }, 'CR4 one tick');
              memory(cpu, f.bytes, 'PDPTE capture is physical read only');
              numeric();
            });
          }
      },
    },
    {
      name: 'supervisor legacy PAE late physical quartet refusal precedes reserved validation and publishes nothing',
      async run() {
        for (const change of [SMEP, SMAP, 0n]) {
          const f = fixture(side, 'pae', '0f22e0');
          put(f.bytes, 0x1000, 0x2003n); // Reserved slot0 remains readable; slot3 below is absent.
          f.options.memory!.mappings = [
            {
              base: 0n,
              backing: 'ram',
              offset: 0,
              length: 0x1018,
              permissions: { read: true, write: true, execute: true },
            },
            {
              base: 0x1020n,
              backing: 'ram',
              offset: 0x1020,
              length: f.bytes.length - 0x1020,
              permissions: { read: true, write: true, execute: true },
            },
          ];
          await using(side, f, async (cpu) => {
            const before = state(2n | AC);
            before.registers[0] = f.paging.cr4 | change;
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            same(
              result.reason,
              change === SMEP ? 'physical-memory-fault' : 'budget',
              'SMEP-only quartet transaction',
            );
            same(result.retired, change === SMEP ? 0n : 1n, 'failed writer own retirement');
            same(
              result.state,
              { ...before, rip: change === SMEP ? PC : PC + 3n },
              'failed control scalar',
            );
            same(
              cpu.readPagingState(),
              change === SMEP ? f.paging : { ...f.paging, cr4: f.paging.cr4 | change },
              'atomic control publication',
            );
            if (change === SMEP) {
              same(
                result.physicalMemoryFault,
                {
                  instructionPc: PC,
                  phase: 'pdpte-load',
                  control: 'cr4',
                  slot: 3,
                  physicalAddress: 0x1018n,
                  width: 8,
                  failingPhysicalAddress: 0x1018n,
                  physicalAccess: 'read',
                  cause: 'unmapped',
                },
                'exact private quartet provenance',
              );
              const permissions = { read: true, write: true, execute: true };
              cpu.setMappings([
                { base: 0n, backing: 'ram', offset: 0, length: f.bytes.length, permissions },
              ]);
              const invalid = await cpu.run({ budget: 1n });
              same(invalid.reason, 'protection-fault', 'reserved present quartet GP');
              same(
                invalid.protectionFault,
                { vector: 13, errorCode: 0, phase: 'target', instructionPc: PC },
                'reserved quartet exact GP0',
              );
              same(cpu.readPagingState(), f.paging, 'reserved quartet no partial controls');
              same(invalid.retired, 0n, 'reserved writer no retirement');
            }
          });
        }
      },
    },
    {
      name: 'supervisor fetch nonpresent and reserved faults retain SMEP-dependent ID and prior lower-level priority',
      async run() {
        for (const family of families)
          for (const smep of [false, true])
            for (const ac of [false, true])
              for (const nxe of family === 'non-pae' ? [false] : [false, true])
                for (const reserved of family === 'non-pae' ? [false] : [false, true]) {
                  const f = fixture(side, family, '90');
                  f.paging.cr4 |= smep ? SMEP : 0n;
                  f.paging.efer |= nxe ? 0x800n : 0n;
                  if (reserved) put(f.bytes, f.upper, 0x20e7n, f.width);
                  else f.leaf(Number(DATA), 0xa066n);
                  await using(side, f, async (cpu) => {
                    const before = state(2n | (ac ? AC : 0n), DATA);
                    cpu.setState(before);
                    const numeric = preserved(cpu);
                    const result = await cpu.run({ budget: 1n });
                    same(result.reason, 'page-fault', 'source frontier PF');
                    same(result.retired, 0n, 'source frontier no retirement');
                    same(result.state, before, 'source frontier no begin');
                    same(
                      result.pageFault,
                      {
                        vector: 14,
                        address: DATA,
                        access: 'execute',
                        errorCode: (reserved ? 9 : 0) | (smep || nxe ? 16 : 0),
                        instructionPc: DATA,
                      },
                      'source frontier exact PFEC',
                    );
                    numeric();
                    memory(cpu, f.bytes, 'source frontier no payload');
                  });
                }
      },
    },
    {
      name: 'supervisor live host AC and controls cannot be hidden by retained executable owners',
      async run() {
        for (const family of families) {
          const f = fixture(side, family, '908b0390');
          f.leaf(Number(DATA), 0xa067n);
          await using(side, f, async (cpu) => {
            cpu.setState(state());
            const warm = await cpu.run({ budget: 2n });
            same(warm.retired, 2n, 'warm unprotected owner');
            check(cpu.inspectTranslations().length > 0, 'retained owner exists');
            const bank = cpu.readPagingState();
            cpu.setPagingState({ ...bank, cr4: bank.cr4 | SMAP });
            for (const ac of [false, true, false, true]) {
              const before = state(2n | (ac ? AC : 0n), PC + 1n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              same(result.reason, ac ? 'budget' : 'page-fault', 'host AC changes live data policy');
              same(result.retired, ac ? 1n : 0n, 'host AC retirement');
              if (!ac) same(result.state, before, 'host AC denial scalar');
            }
            // Keep a source owner and then change only code-page rights. A/D and payload already exist.
            cpu.setPagingState(bank);
            cpu.setState(state());
            await cpu.run({ budget: 1n });
            const leaf = new Uint8Array(f.width);
            put(leaf, 0, 0x8067n, f.width);
            cpu.writePhysicalMemory(BigInt(f.pt + f.width), leaf);
            cpu.setPagingState({ ...bank, cr4: bank.cr4 | SMEP });
            cpu.setState(state(2n | AC));
            const blocked = await cpu.run({ budget: 1n });
            same(blocked.reason, 'page-fault', 'warm source owner rechecks SMEP');
            same(
              blocked.pageFault,
              { vector: 14, address: PC, access: 'execute', errorCode: 17, instructionPc: PC },
              'warm source full PF',
            );
            same(blocked.retired, 0n, 'warm source cannot retire');
          });
        }
      },
    },
  ];
}
