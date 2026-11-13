import { createCpu, type ExecutionContextSnapshot } from '../../../host/index.js';
import {
  AC,
  AUX,
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

export function supervisorNoWorkScenarios(compiler: WebAssembly.Module): Scenario[] {
  const side = { createCpu, compiler };
  return [
    {
      name: 'supervisor zero REP at CPL3 skips SMAP denied implicit TSS metadata despite AC1',
      async run() {
        for (const family of families)
          for (const code of ['f36c', 'f36e'])
            for (const count of [0n, 1n]) {
              const calls: unknown[] = [],
                f = fixture(side, family, code, {
                  cpl: 3,
                  io: {
                    read(port, width) {
                      calls.push(['read', port, width]);
                      return 0x11;
                    },
                    write(port, width, value) {
                      calls.push(['write', port, width, value]);
                    },
                  },
                });
              f.paging.cr4 |= SMAP;
              f.leaf(0xb000, 0xf067n);
              const context = f.options.context as ExecutionContextSnapshot;
              context.tr = {
                selector: 0x28,
                valid: true,
                base: 0xb000n,
                limit: 0xff,
                attributes: 0x8b,
              };
              // A valid, entirely permissive bitmap would admit I/O after its metadata read.
              put(f.bytes, 0xf066, 0x80n, 2);
              put(f.bytes, 0xf090, 0n, 2);
              await using(side, f, async (cpu) => {
                const before = state(2n | AC);
                before.registers[1] = count;
                before.registers[2] = 0x80n;
                cpu.setState(before);
                cpu.setTimeState({ tsc: 100n, tscAux: AUX });
                const numeric = preserved(cpu),
                  result = await cpu.run({ budget: 1n, repeatBudget: count });
                same(
                  result.reason,
                  count === 0n ? 'budget' : 'page-fault',
                  'count gate precedes implicit TSS',
                );
                same(
                  result.retired,
                  count === 0n ? 1n : 0n,
                  'zero REP retires without element work',
                );
                same(result.repeatIterations, 0n, 'no completed I/O element');
                same(
                  result.state,
                  { ...before, rip: count === 0n ? PC + 2n : PC },
                  'TSS no-work complete scalar',
                );
                same(
                  result.pageFault,
                  count === 0n
                    ? undefined
                    : {
                        vector: 14,
                        address: 0xb066n,
                        access: 'read',
                        errorCode: 1,
                        table: 'tss',
                        systemPhase: 'tss-read',
                        selector: 0x28,
                        instructionPc: PC,
                      },
                  'positive-count control has exact implicit supervisor PF1',
                );
                same(calls, [], 'TSS denial or zero count precedes every provider callback');
                same(cpu.readContext(), context, 'no-work TSS context');
                same(
                  cpu.readPagingState(),
                  { ...f.paging, cr2: count === 0n ? 0xdeadn : 0xb066n },
                  'no-work exact CR2',
                );
                same(
                  cpu.readTimeState(),
                  { tsc: count === 0n ? 101n : 100n, tscAux: AUX },
                  'zero REP only successful tick',
                );
                memory(cpu, f.bytes, 'no-work operands metadata A D and payload unchanged');
                numeric();
              });
            }
      },
    },
  ];
}
