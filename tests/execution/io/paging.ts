import { equal, initial, type Scenario } from '../../support/fixture.js';
import { usingPaged, little, word, PC } from '../paging/fixture.js';
import { snapshot } from '../far-control/fixture.js';

export function pagedIoScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'paged INS consumes a faulting destination read and resumes without replay after PTE repair',
      async run() {
        const values = [0x11, 0x22, 0x33, 0x44];
        let calls = 0;
        await usingPaged(
          compiler,
          {
            code: 'f36c',
            words: [
              [0x3000n, 0x4007n],
              [0x4020n, 0xa007n],
              [0x4028n, 0xb006n],
            ],
            spans: [
              { physical: 0xa000n, bytes: new Uint8Array(0x1000) },
              { physical: 0xb000n, bytes: new Uint8Array(0x1000) },
            ],
            io: {
              read() {
                return values[calls++]!;
              },
              write() {},
            },
          },
          async (cpu) => {
            cpu.setState(initial(PC, { 1: 3n, 2: 0x80n, 7: 0x4ffen }));
            const fault = await cpu.run({ budget: 1n, repeatBudget: 3n });
            equal(fault.reason, 'page-fault', 'late write #PF');
            equal(fault.pageFault?.errorCode, 2, 'supervisor nonpresent write');
            equal(fault.pageFault?.address, 0x5000n, 'destination #PF');
            equal(cpu.readPagingState().cr2, 0x5000n, 'CR2 publication');
            equal(calls, 3, 'third input consumed before destination walk');
            equal(fault.repeatIterations, 2n, 'only two committed');
            equal(fault.state.registers[7], 0x5000n, 'failed index preserved');
            equal(fault.state.registers[1], 1n, 'failed count preserved');
            equal(
              Array.from(cpu.readPhysicalMemory(0xaffen, 2)).join(','),
              '17,34',
              'first two physical writes',
            );
            equal(word(cpu, 0x4020n) & 0x60n, 0x60n, 'committed leaf A/D');
            equal(word(cpu, 0x4028n), 0xb006n, 'nonpresent leaf unchanged');
            cpu.writePhysicalMemory(0x4028n, little([0xb007n]));
            const last = await cpu.run({ budget: 1n, repeatBudget: 1n });
            equal(last.reason, 'budget', 'repaired write');
            equal(calls, 4, 'fresh input on failed attempt retry');
            equal(last.state.rip, PC + 2n, 'REP completes');
            equal(last.repeatIterations, 1n, 'repaired element only');
            equal(
              cpu.readPhysicalMemory(0xb000n, 1)[0],
              0x44,
              'consumed third input was not latched',
            );
          },
        );
      },
    },
    {
      name: 'CPL3 port permission traffic uses supervisor TSS paging provenance',
      async run() {
        for (const present of [false, true]) {
          const context = snapshot('long64', 3);
          context.tr = {
            selector: 0x28,
            valid: true,
            base: 0x5000n,
            limit: 0x100,
            attributes: 0x8b,
          };
          const tss = new Uint8Array(0x100);
          tss[0x66] = 0x80;
          let calls = 0;
          await usingPaged(
            compiler,
            {
              code: 'ec',
              context,
              words: [
                [0x3000n, 0x4007n],
                [0x4028n, present ? 0xc003n : 0n],
              ],
              spans: [{ physical: 0xc000n, bytes: tss }],
              io: {
                read() {
                  calls++;
                  return 0x7b;
                },
                write() {},
              },
            },
            async (cpu) => {
              cpu.setState(initial(PC, { 2: 0x80n }));
              const result = await cpu.run({ budget: 1n });
              if (present) {
                equal(result.reason, 'budget', 'supervisor-only TSS mapping allowed');
                equal(calls, 1, 'one admitted callback');
                equal(result.state.registers[0]! & 255n, 0x7bn, 'input value');
              } else {
                equal(result.reason, 'page-fault', 'implicit TSS fault');
                equal(calls, 0, 'TSS failure precedes input');
                equal(result.pageFault?.errorCode, 0, 'implicit supervisor read, not user');
                equal(result.pageFault?.address, 0x5066n, 'map-base field fault');
                equal(result.pageFault?.systemPhase, 'tss-read', 'TSS source phase');
                equal(result.pageFault?.table, 'tss', 'TSS source table');
              }
            },
          );
        }
      },
    },
  ];
}
