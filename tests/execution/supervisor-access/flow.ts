import { createCpu } from '../../../host/index.js';
import {
  AC,
  AUX,
  SMEP,
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

export function supervisorFlowScenarios(compiler: WebAssembly.Module): Scenario[] {
  const side = { createCpu, compiler };
  return [
    {
      name: 'supervisor completed JMP defers SMEP target fetch at budget and stop boundaries without replay',
      async run() {
        for (const cpl of [0, 3])
          for (const ac of [false, true])
            for (const gate of ['none', 'budget', 'stop'] as const) {
              const f = fixture(side, 'non-pae', '', { cpl });
              f.paging.cr4 |= SMEP;
              // Literal protected32 packet: e9 fb2f0000 at1000 reaches user4000.
              put(f.bytes, 0x1000, 0x2007n, 4);
              put(f.bytes, 0x2004, cpl === 3 ? 0x3007n : 0x3003n, 4);
              put(f.bytes, 0x2010, 0x5007n, 4);
              f.bytes.set(hex('e9fb2f0000'), 0x3000);
              f.bytes[0x5000] = 0x90;
              await using(side, f, async (cpu) => {
                const before = state(2n | (ac ? AC : 0n));
                cpu.setState(before);
                cpu.setTimeState({ tsc: 100n, tscAux: AUX });
                const numeric = preserved(cpu),
                  context = cpu.readContext(),
                  branchRam = f.bytes.slice();
                put(branchRam, 0x1000, 0x2027n, 4);
                put(branchRam, 0x2004, cpl === 3 ? 0x3027n : 0x3023n, 4);
                let retired = 0n;
                if (gate !== 'none') {
                  const first = await cpu.run({
                    budget: gate === 'budget' ? 1n : 2n,
                    ...(gate === 'stop' ? { stop: 0x4000n } : {}),
                  });
                  same(first.reason, gate, 'target fetch is deferred by admitted work gate');
                  same(first.retired, 1n, 'completed JMP retires once before gate');
                  same(first.state, { ...before, rip: 0x4000n }, 'branch-only full scalar');
                  same(first.pageFault, undefined, 'gate does not select future SMEP fault');
                  same(cpu.readPagingState(), f.paging, 'deferred target keeps old CR2');
                  same(cpu.readTimeState(), { tsc: 101n, tscAux: AUX }, 'only JMP ticks');
                  memory(cpu, branchRam, 'deferred target leaves its PTE A clear');
                  retired += first.retired;
                }
                const result = await cpu.run({ budget: gate === 'none' ? 2n : 1n });
                retired += result.retired;
                const allowed = cpl === 3,
                  expected = { ...before, rip: allowed ? 0x4001n : 0x4000n },
                  expectedRam = branchRam.slice();
                put(expectedRam, 0x2010, 0x5027n, 4);
                same(
                  result.reason,
                  allowed ? 'budget' : 'page-fault',
                  'reached target SMEP verdict',
                );
                same(retired, allowed ? 2n : 1n, 'JMP never replays on target resume');
                same(result.state, expected, 'target full scalar and preserved AC');
                same(
                  result.pageFault,
                  allowed
                    ? undefined
                    : {
                        vector: 14,
                        address: 0x4000n,
                        access: 'execute',
                        errorCode: 17,
                        instructionPc: 0x4000n,
                      },
                  'target exact supervisor PF11',
                );
                same(
                  cpu.readPagingState(),
                  { ...f.paging, cr2: allowed ? 0xdeadn : 0x4000n },
                  'target controls and CR2',
                );
                same(
                  cpu.readTimeState(),
                  { tsc: allowed ? 102n : 101n, tscAux: AUX },
                  'denied target contributes no tick',
                );
                if (!allowed) {
                  const retry = await cpu.run({ budget: 1n });
                  same(retry.reason, 'page-fault', 'unchanged target retry remains denied');
                  same(retry.retired, 0n, 'repeated denial never replays predecessor');
                  same(retry.state, expected, 'repeated denial preserves full scalar');
                  same(retry.pageFault, result.pageFault, 'retry exact original target source');
                  same(cpu.readTimeState(), { tsc: 101n, tscAux: AUX }, 'retry has no hidden tick');
                }
                same(cpu.readContext(), context, 'target refusal preserves execution context');
                memory(cpu, expectedRam, 'reached fetch permits A but no payload or D');
                numeric();
              });
            }
      },
    },
  ];
}
