import { createCpu, type ExecutionContextSnapshot } from '../../../host/index.js';
import {
  AC,
  DATA,
  PC,
  SMAP,
  families,
  fixture,
  hex,
  memory,
  preserved,
  put,
  same,
  state,
  using,
  type Scenario,
} from './fixture.js';

export function supervisorMetadataScenarios(compiler: WebAssembly.Module): Scenario[] {
  const side = { createCpu, compiler };
  return [
    {
      name: 'supervisor LGDT pointer is explicit while its newly installed user GDT is implicit regardless of AC',
      async run() {
        for (const family of families)
          for (const ac of [false, true])
            for (const pointerUser of [false, true]) {
              const f = fixture(side, family, '0f01138ed8');
              f.paging.cr4 |= SMAP;
              f.leaf(Number(DATA), 0xa063n | (pointerUser ? 4n : 0n));
              f.leaf(0x7000, 0xb067n);
              put(f.bytes, 0xa000, 0x3fn, 2);
              put(f.bytes, 0xa002, 0x7000n, f.bits === 64 ? 8 : 4);
              put(f.bytes, 0xb008, 0x00cff3000000ffffn);
              const context = f.options.context as ExecutionContextSnapshot;
              context.gdtr = { base: 0n, limit: 0 };
              await using(side, f, async (cpu) => {
                const before = state(2n | (ac ? AC : 0n));
                before.registers[0] = 0x112233440000000bn;
                cpu.setState(before);
                const numeric = preserved(cpu),
                  admitted = !pointerUser || ac,
                  result = await cpu.run({ budget: 2n });
                same(result.reason, 'page-fault', 'pointer or later metadata denial');
                same(
                  result.retired,
                  admitted ? 1n : 0n,
                  'LGDT alone retires before descriptor refusal',
                );
                same(
                  result.state,
                  { ...before, rip: admitted ? PC + 3n : PC },
                  'LGDT no premature operand output',
                );
                same(
                  result.pageFault,
                  admitted
                    ? {
                        vector: 14,
                        address: 0x7008n,
                        access: 'read',
                        errorCode: 1,
                        table: 'gdt',
                        systemPhase: 'descriptor-read',
                        selector: 0xb,
                        instructionPc: PC + 3n,
                      }
                    : {
                        vector: 14,
                        address: DATA,
                        access: 'read',
                        errorCode: 1,
                        instructionPc: PC,
                      },
                  'explicit pointer versus implicit lookup provenance',
                );
                same(
                  cpu.readContext(),
                  { ...context, gdtr: admitted ? { base: 0x7000n, limit: 0x3f } : context.gdtr },
                  'new GDTR publishes independently of later lookup',
                );
                numeric();
                memory(cpu, f.bytes, 'LGDT no table payload writes');
              });
            }
      },
    },
    {
      name: 'supervisor SGDT pointer record uses explicit CPL and AC rather than metadata access rules',
      async run() {
        for (const family of families)
          for (const cpl of [0, 3])
            for (const ac of [false, true]) {
              const f = fixture(side, family, '0f0103', { cpl });
              f.paging.cr4 |= SMAP;
              f.leaf(Number(DATA), 0xa067n);
              await using(side, f, async (cpu) => {
                const before = state(2n | (ac ? AC : 0n));
                cpu.setState(before);
                const numeric = preserved(cpu);
                const admitted = cpl === 3 || ac,
                  result = await cpu.run({ budget: 1n });
                same(
                  result.reason,
                  admitted ? 'budget' : 'page-fault',
                  'SGDT explicit data privilege',
                );
                same(result.retired, admitted ? 1n : 0n, 'SGDT retirement');
                same(result.state, { ...before, rip: admitted ? PC + 3n : PC }, 'SGDT scalar');
                same(
                  result.pageFault,
                  admitted
                    ? undefined
                    : {
                        vector: 14,
                        address: DATA,
                        access: 'write',
                        errorCode: 3,
                        instructionPc: PC,
                      },
                  'SGDT explicit PF',
                );
                const expected = f.bytes.slice();
                if (admitted) {
                  put(expected, 0xa000, 0x3fn, 2);
                  put(expected, 0xa002, 0x7000n, f.bits === 64 ? 8 : 4);
                }
                memory(cpu, expected, 'SGDT exact width and neighboring payload');
                numeric();
              });
            }
      },
    },
    {
      name: 'supervisor accessed descriptor writes remain implicit under AC and preserve WP policies when SMAP is inactive',
      async run() {
        for (const ac of [false, true])
          for (const wp of [false, true])
            for (const smap of [false, true]) {
              const f = fixture(side, 'non-pae', '8ed8');
              f.paging.cr4 |= smap ? SMAP : 0n;
              f.paging.cr0 |= wp ? 0x10000n : 0n;
              f.leaf(0x7000, 0xb065n);
              put(f.bytes, 0xb008, 0x00cff2000000ffffn);
              await using(side, f, async (cpu) => {
                const before = state(2n | (ac ? AC : 0n));
                before.registers[0] = 0xbn;
                cpu.setState(before);
                const numeric = preserved(cpu);
                const admitted = !smap && !wp,
                  result = await cpu.run({ budget: 1n });
                same(
                  result.reason,
                  admitted ? 'budget' : 'page-fault',
                  'implicit descriptor read/write rule',
                );
                same(result.retired, admitted ? 1n : 0n, 'descriptor access write retirement');
                same(
                  result.state,
                  { ...before, rip: admitted ? PC + 2n : PC },
                  'descriptor scalar',
                );
                if (!admitted)
                  same(
                    result.pageFault,
                    {
                      vector: 14,
                      address: smap ? 0x7008n : 0x700dn,
                      access: smap ? 'read' : 'write',
                      errorCode: smap ? 1 : 3,
                      table: 'gdt',
                      systemPhase: smap ? 'descriptor-read' : 'descriptor-accessed-write',
                      selector: 0xb,
                      instructionPc: PC,
                    },
                    'descriptor implicit write/read priority',
                  );
                const expected = f.bytes.slice();
                if (admitted) expected[0xb00d] = 0xf3;
                memory(cpu, expected, 'accessed-byte atomic publication');
                numeric();
              });
            }
      },
    },
    {
      name: 'supervisor prospective destination frame privilege is independent of user origin and frame is explicit',
      async run() {
        for (const sourceCpl of [0, 3])
          for (const frameUser of [false, true])
            for (const ac of [false, true]) {
              const f = fixture(side, 'non-pae', 'cd20', { cpl: sourceCpl });
              f.paging.cr4 |= SMAP;
              const context = f.options.context as ExecutionContextSnapshot;
              if (sourceCpl === 3)
                for (const [name, segment] of Object.entries(context.segments))
                  segment.selector = name === 'cs' ? 0x1b : 0x23;
              context.tr = {
                selector: 0x28,
                valid: true,
                base: 0xb000n,
                limit: 0x67,
                attributes: 0x8b,
              };
              put(f.bytes, 0xf004, 0x9ff0n, 4);
              put(f.bytes, 0xf008, 0x10n, 2);
              f.bytes.set(hex('0040080000ee0000'), 0xc000 + 0x20 * 8);
              f.leaf(0x9000, 0xd063n | (frameUser ? 4n : 0n));
              await using(side, f, async (cpu) => {
                const before = state(0x202n | (ac ? AC : 0n));
                cpu.setState(before);
                const numeric = preserved(cpu);
                const admitted = !frameUser || ac,
                  result = await cpu.run({ budget: 1n, stop: 0x4000n });
                same(
                  result.reason,
                  admitted ? 'budget' : 'page-fault',
                  'prospective frame admission',
                );
                same(result.retired, admitted ? 1n : 0n, 'software INT retirement');
                const expectedRam = f.bytes.slice();
                if (admitted) {
                  const expected = structuredClone(before);
                  expected.rip = 0x4000n;
                  expected.flags = 2n | (ac ? AC : 0n);
                  expected.registers[4] = sourceCpl === 3 ? 0x9fdcn : 0x9fe4n;
                  same(result.state, expected, 'successful entry AC and destination stack');
                  same(cpu.readContext().cpl, 0, 'destination CPL');
                  const values =
                    sourceCpl === 3
                      ? [PC + 2n, 0x1bn, before.flags, 0x9ff0n, 0x23n]
                      : [PC + 2n, 8n, before.flags];
                  for (const [i, value] of values.entries())
                    put(expectedRam, Number(expected.registers[4]) + 0x4000 + i * 4, value, 4);
                } else {
                  same(result.state, before, 'failed prospective entry scalar rollback');
                  same(cpu.readContext(), context, 'failed prospective entry caches rollback');
                  same(
                    result.pageFault?.errorCode,
                    3,
                    'destination supervisor requester even from user source',
                  );
                  same(result.pageFault?.access, 'write', 'frame is an explicit write');
                  same(result.pageFault?.instructionPc, PC, 'frame failure source PC');
                }
                memory(cpu, expectedRam, 'prospective frame RAM atomicity');
                numeric();
              });
            }
      },
    },
  ];
}
