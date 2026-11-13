import { createCpu } from '../../../host/index.js';
import {
  AC,
  AUX,
  DATA,
  PC,
  SMAP,
  families,
  fixture,
  hex,
  preserved,
  same,
  state,
  using,
  type Scenario,
} from './fixture.js';

export function supervisorFlagScenarios(compiler: WebAssembly.Module): Scenario[] {
  const side = { createCpu, compiler };
  return [
    {
      name: 'supervisor STAC CLAC runtime privilege UD has no error slot and clears RF after one begin',
      async run() {
        for (const family of families)
          for (const cpl of [1, 2, 3])
            for (const code of ['0f01ca', '0f01cb']) {
              const f = fixture(side, family, code, { cpl });
              await using(side, f, async (cpu) => {
                const before = state(0x10202n | AC);
                cpu.setState(before);
                cpu.setTimeState({ tsc: 100n, tscAux: AUX });
                const numeric = preserved(cpu);
                const first = await cpu.run({ budget: 1n });
                same(first.reason, 'invalid-encoding', 'runtime CPL UD report');
                same(first.retired, 0n, 'runtime CPL UD retires nothing');
                same(first.state.flags, 0x202n | AC, 'runtime begin consumes RF once');
                same(first.state.registers, before.registers, 'runtime no destination');
                same(first.state.rip, PC, 'runtime source PC');
                same(first.resources.compilations, 1, 'runtime UD after actual translation');
                cpu.setState(before);
                const delivered = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
                same(delivered.reason, 'event-budget', 'staged runtime UD');
                same(delivered.retired, 0n, 'staged UD has no retirement');
                same(delivered.state.flags, 0x202n | AC, 'delivered runtime RF consumed');
                same(
                  delivered.state.event,
                  {
                    kind: 'pending',
                    exception: {
                      vector: 6,
                      instructionPc: PC,
                      returnPc: PC,
                      savedFlags: 0x10202n | AC,
                    },
                  },
                  'runtime UD source has no errorCode property',
                );
                same(delivered.resources.compilations, 0, 'warm runtime UD reuses owner');
                same(cpu.readTimeState(), { tsc: 100n, tscAux: AUX }, 'UD time unchanged');
                numeric();
              });
            }
      },
    },
    {
      name: 'supervisor STAC CLAC NP prefixes retain decoded report and delivered RF boundaries',
      async run() {
        for (const opcode of ['0f01ca', '0f01cb'])
          for (const prefix of ['66', 'f2', 'f3', 'f0', '6666', 'f2f3']) {
            const f = fixture(side, 'non-pae', prefix + opcode);
            await using(side, f, async (cpu) => {
              const before = state(0x10202n | AC);
              cpu.setState(before);
              cpu.setTimeState({ tsc: 100n, tscAux: AUX });
              const report = await cpu.run({ budget: 1n });
              same(report.reason, 'invalid-encoding', 'recognized NP prefix UD');
              same(report.state, before, 'decoded report before begin retains RF');
              same(report.resources.compilations, 0, 'decoded fault precedes compile');
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              same(result.reason, 'event-budget', 'decoded UD staging');
              same(result.state.flags, 0x202n | AC, 'selected decoded delivery consumes RF');
              same(
                result.state.event,
                {
                  kind: 'pending',
                  exception: {
                    vector: 6,
                    instructionPc: PC,
                    returnPc: PC,
                    savedFlags: 0x10202n | AC,
                  },
                },
                'decoded UD no error slot',
              );
              same(cpu.readTimeState(), { tsc: 100n, tscAux: AUX }, 'decoded fault no time');
            });
          }
      },
    },
    {
      name: 'supervisor exact fifteen-byte length prefix and neighboring opcode frontiers remain separate',
      async run() {
        for (const [code, reason, flags, vector] of [
          ['67'.repeat(12) + '0f01ca', 'budget', 0x202n, 0],
          ['67'.repeat(13) + '0f01', 'invalid-encoding', 0x10202n | AC, 13],
          ['66'.repeat(12) + '0f01ca', 'invalid-encoding', 0x10202n | AC, 6],
          ['66'.repeat(13) + '0f01', 'invalid-encoding', 0x10202n | AC, 13],
          ['f0f30f01ca', 'unsupported', 0x10202n | AC, 0],
          ['f3f00f01cb', 'unsupported', 0x10202n | AC, 0],
          ['0f01c8', 'unsupported', 0x10202n | AC, 0],
          ['0f01c9', 'unsupported', 0x10202n | AC, 0],
          ['0f01cc', 'unsupported', 0x10202n | AC, 0],
          ['0f01cd', 'unsupported', 0x10202n | AC, 0],
        ] as const) {
          const f = fixture(side, 'non-pae', code);
          await using(side, f, async (cpu) => {
            cpu.setState(state(0x10202n | AC));
            const result = await cpu.run({ budget: 1n });
            same(result.reason, reason, `literal prefix ${code}`);
            same(result.state.flags, flags, 'prefix RF and AC');
            same(result.retired, reason === 'budget' ? 1n : 0n, 'prefix retirement');
            if (vector === 13) {
              const delivered = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              same(delivered.reason, 'event-budget', 'length source stages');
              same(
                delivered.state.event,
                {
                  kind: 'pending',
                  exception: {
                    vector: 13,
                    instructionPc: PC,
                    returnPc: PC,
                    savedFlags: 0x10202n | AC,
                    errorCode: 0,
                  },
                },
                'length GP source has error0',
              );
            }
          });
        }
      },
    },
    {
      name: 'supervisor forbidden prefix still fetches the required ModRM after execute breakpoint and no-work gates',
      async run() {
        for (const code of ['0f01', 'f30f01']) {
          const f = fixture(side, 'non-pae', code);
          const missing = 0x8000 + code.length / 2,
            after = missing + 1;
          f.options.memory!.mappings = [
            {
              base: 0n,
              backing: 'ram',
              offset: 0,
              length: missing,
              permissions: { read: true, write: true, execute: true },
            },
            {
              base: BigInt(after),
              backing: 'ram',
              offset: after,
              length: f.bytes.length - after,
              permissions: { read: true, write: true, execute: true },
            },
          ];
          await using(side, f, async (cpu) => {
            const before = state(0x202n | AC);
            cpu.setState(before);
            cpu.setTimeState({ tsc: 100n, tscAux: AUX });
            same((await cpu.run({ budget: 0n })).state, before, 'budget0 skips source acquisition');
            cpu.setDebugState({ addresses: [PC, 0n, 0n, 0n], dr6: 0n, dr7: 0x401n });
            const breakpoint = await cpu.run({ budget: 1n });
            same(breakpoint.reason, 'debug-exception', 'execute breakpoint before missing ModRM');
            same(breakpoint.retired, 0n, 'breakpoint no retirement');
            cpu.setState({ ...before, flags: 0x10202n | AC });
            const result = await cpu.run({ budget: 1n });
            same(
              result.reason,
              'physical-memory-fault',
              'RF-suppressed execute stop still needs ModRM',
            );
            same(result.state.flags, 0x10202n | AC, 'missing required source remains pre-begin');
            same(
              result.physicalMemoryFault,
              {
                instructionPc: PC,
                address: PC + BigInt(code.length / 2),
                access: 'execute',
                physicalAddress: BigInt(missing),
                width: 1,
                failingPhysicalAddress: BigInt(missing),
                physicalAccess: 'execute',
                cause: 'unmapped',
                phase: 'final-access',
                segment: 'cs',
              },
              'literal required-byte physical provenance',
            );
            same(cpu.readTimeState(), { tsc: 100n, tscAux: AUX }, 'no source-refusal tick');
          });
        }
      },
    },
    {
      name: 'supervisor runtime CPL guard does not jump ahead of cold artifact refusal',
      async run() {
        for (const code of ['0f01ca', '0f01cb']) {
          const f = fixture(side, 'non-pae', code, { cpl: 3 });
          f.options.limits = { ...f.options.limits!, maxArtifactBytes: 1 };
          await using(side, f, async (cpu) => {
            const before = state(0x10202n | AC);
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            same(result.reason, 'resource-limit', 'cold compile refuses before reached CPL');
            same(result.state, before, 'no begin or AC publication');
            same(result.retired, 0n, 'no cold retirement');
          });
        }
      },
    },
    {
      name: 'supervisor POPFD reads with old AC then publishes restored AC before a cached load',
      async run() {
        for (const stackUser of [false, true])
          for (const oldAc of [false, true])
            for (const savedAc of [false, true]) {
              const f = fixture(side, 'non-pae', '9d8b03');
              f.paging.cr4 |= SMAP;
              f.leaf(0x9000, 0xd063n | (stackUser ? 4n : 0n));
              f.leaf(Number(DATA), 0xa067n);
              f.bytes.set(hex(savedAc ? '02000400' : '02000000'), 0xdff0);
              await using(side, f, async (cpu) => {
                const before = state(2n | (oldAc ? AC : 0n));
                cpu.setState(before);
                cpu.setTimeState({ tsc: 100n, tscAux: AUX });
                const stackAllowed = !stackUser || oldAc;
                const result = await cpu.run({ budget: 2n });
                const expected = structuredClone(before);
                if (stackAllowed) {
                  expected.flags = 2n | (savedAc ? AC : 0n);
                  expected.registers[4] = 0x9ff4n;
                  expected.rip = PC + (savedAc ? 3n : 1n);
                  if (savedAc) expected.registers[0] = 0x1122334478563412n;
                }
                same(
                  result.reason,
                  stackAllowed && savedAc ? 'budget' : 'page-fault',
                  'POPF old and new AC verdict',
                );
                same(
                  result.retired,
                  !stackAllowed ? 0n : savedAc ? 2n : 1n,
                  'POPF old and new AC retirement',
                );
                same(result.state, expected, 'POPF old/new full scalar packet');
                same(
                  result.pageFault?.address,
                  !stackAllowed ? 0x9ff0n : savedAc ? undefined : DATA,
                  'exact failing old stack or new data',
                );
                same(
                  cpu.readTimeState(),
                  { tsc: 100n + (!stackAllowed ? 0n : savedAc ? 2n : 1n), tscAux: AUX },
                  'authored POPF time',
                );
              });
            }
      },
    },
    {
      name: 'supervisor REX CLAC is one long instruction and INC plus CLAC outside long mode',
      async run() {
        for (const family of ['non-pae', 'ia32e'] as const) {
          const f = fixture(side, family, '400f01ca');
          await using(side, f, async (cpu) => {
            const before = state(2n | AC);
            before.registers[0] = 0x1122334400000007n;
            cpu.setState(before);
            const first = await cpu.run({ budget: 1n });
            same(first.state.rip, PC + (family === 'ia32e' ? 4n : 1n), 'REX versus INC length');
            same(first.state.flags, family === 'ia32e' ? 2n : 2n | AC, 'AC before legacy CLAC');
            same(
              first.state.registers[0],
              family === 'ia32e' ? before.registers[0] : 0x1122334400000008n,
              'legacy INC producer',
            );
            if (family === 'non-pae') {
              const next = await cpu.run({ budget: 1n });
              same(next.state.rip, PC + 4n, 'legacy CLAC reached next');
              same(next.state.flags, 2n, 'legacy CLAC clears AC');
            }
          });
        }
      },
    },
  ];
}
