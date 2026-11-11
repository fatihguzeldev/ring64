import { Core } from '../../../host/core.js';
import type { FastSystemState } from '../../../host/index.js';
import { longSnapshot } from '../../support/context.js';
import {
  BANK,
  PC,
  check,
  equal,
  hex,
  initial,
  little,
  same,
  usingPaged,
  type Scenario,
} from '../paging/fixture.js';

const bank = (): FastSystemState => ({
  star: 0x0020000800000000n,
  lstar: 0x401000n,
  fmask: 0n,
  sysenterCs: 8n,
  sysenterEip: 0x401000n,
  sysenterEsp: 0x404000n,
  kernelGsBase: 0n,
});

export function fastSystemCurrentnessScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'fast system mutable entry and SCE are consumed by retained middle entries without stale constants',
      async run() {
        await usingPaged(
          compiler,
          { code: '900f05', context: longSnapshot(), bank: { ...BANK, efer: 0x501n } },
          async (cpu) => {
            cpu.setFastSystemState(bank());
            cpu.setState(initial(PC));
            const first = await cpu.run({ budget: 2n });
            equal(first.state.rip, 0x401000n, 'initial entry target');
            cpu.setFastSystemState({ ...bank(), lstar: 0x402000n });
            cpu.setState(initial(PC + 1n));
            const second = await cpu.run({ budget: 1n });
            equal(second.state.rip, 0x402000n, 'changed entry target');
            equal(second.resources.compilations, 0, 'middle entry reuses dynamically read target');
            cpu.setPagingState({ ...cpu.readPagingState(), efer: 0x500n });
            cpu.setState(initial(PC + 1n));
            const disabled = await cpu.run({ budget: 1n });
            equal(disabled.reason, 'invalid-encoding', 'live SCE legality');
            equal(disabled.retired, 0n, 'disabled entry does not retire');
            equal(disabled.resources.compilations, 0, 'SCE is not a translation change');
            cpu.setPagingState({ ...cpu.readPagingState(), efer: 0x501n });
            cpu.setState(initial(PC + 1n));
            const repaired = await cpu.run({ budget: 1n });
            equal(repaired.state.rip, 0x402000n, 'enabled entry uses latest bank');
            equal(repaired.resources.compilations, 0, 'repair keeps current middle entry');
          },
        );
      },
    },
    {
      name: 'fast system guest EFER write changes the immediately following entry and host repair resumes it once',
      async run() {
        await usingPaged(
          compiler,
          { code: 'b9800000c0b800050000ba000000000f300f05', bank: { ...BANK, efer: 0x501n } },
          async (cpu) => {
            cpu.setFastSystemState(bank());
            cpu.setState(initial(PC));
            const denied = await cpu.run({ budget: 5n });
            equal(denied.reason, 'invalid-encoding', 'guest disables next syscall');
            equal(denied.retired, 4n, 'three moves and WRMSR complete');
            equal(denied.state.rip, PC + 17n, 'uncompleted syscall boundary');
            equal(cpu.readPagingState().efer, 0x500n, 'guest write published');
            cpu.setPagingState({ ...cpu.readPagingState(), efer: 0x501n });
            const repaired = await cpu.run({ budget: 1n });
            equal(repaired.state.rip, 0x401000n, 'repaired next entry');
            equal(repaired.state.registers[1], PC + 19n, 'next IP saved exactly once');
          },
        );
      },
    },
    {
      name: 'fast system pending compiler honors changed loaded bases and dynamic banks while public mutation stays busy',
      async run() {
        for (const base of [false, true]) {
          const create = Core.create,
            compile = WebAssembly.compile;
          let observed: Core | undefined;
          Core.create = async (...args) => {
            observed = await create(...args);
            return observed;
          };
          try {
            await usingPaged(
              compiler,
              {
                code: base ? '65488b03' : '0f05',
                context: longSnapshot(0n, 0x402000n),
                bank: { ...BANK, efer: 0x501n },
                words: [
                  [0x4010n, 0xb007n],
                  [0x4018n, 0xc007n],
                ],
                spans: [
                  { physical: 0xb000n, bytes: little([0x1111n]) },
                  { physical: 0xc000n, bytes: little([0x2222n]) },
                ],
              },
              async (cpu) => {
                cpu.setFastSystemState(bank());
                cpu.setState(initial(PC, { 3: 0n }));
                let changed = false;
                WebAssembly.compile = async (bytes) => {
                  if (!changed) {
                    changed = true;
                    check(observed, 'captured real core');
                    let refused = false;
                    try {
                      cpu.setFastSystemState(bank());
                    } catch {
                      refused = true;
                    }
                    check(refused, 'public bank remains busy');
                    if (base) observed.setContext(longSnapshot(0n, 0x403000n));
                    else observed.setFastSystemState({ ...bank(), lstar: 0x402000n });
                  }
                  return compile(bytes);
                };
                try {
                  const result = await cpu.run({ budget: 1n });
                  equal(result.reason, 'budget', 'current consumer completes');
                  equal(result.retired, 1n, 'stale module never executes');
                  if (base) equal(result.state.registers[0], 0x2222n, 'new base owns load');
                  else equal(result.state.rip, 0x402000n, 'dynamic bank read after compile');
                  equal(
                    result.resources.compilations,
                    base ? 2 : 1,
                    'only actual compile assumptions invalidate',
                  );
                  equal(result.resources.nativeEntries, 1, 'one current native entry');
                } finally {
                  WebAssembly.compile = compile;
                }
              },
            );
          } finally {
            Core.create = create;
            WebAssembly.compile = compile;
          }
        }
      },
    },
    {
      name: 'fast system guest kernel changes CR3 then returns to user data under the new root preserving dirty numeric locals',
      async run() {
        const context = longSnapshot();
        context.cpl = 3;
        for (const [name, segment] of Object.entries(context.segments)) {
          segment.dpl = 3;
          segment.selector = name === 'cs' ? 0x33 : 0x2b;
        }
        const tables = new Uint8Array(0x4000);
        for (const [offset, value] of [
          [0, 0x6007n],
          [0x1000, 0x7007n],
          [0x2010, 0x8007n],
          [0x3000, 0x9007n],
          [0x3008, 0xa003n],
          [0x3010, 0xc007n],
        ] as const)
          tables.set(little([value]), offset);
        await usingPaged(
          compiler,
          {
            code: '660fefc00f05488b1df31f0000',
            context,
            bank: { ...BANK, efer: 0x501n },
            words: [
              [0x4008n, 0xa003n],
              [0x4010n, 0xb007n],
            ],
            spans: [
              { physical: 0x5000n, bytes: tables },
              { physical: 0xa000n, bytes: hex('48b800500000000000000f22d8480f07'), execute: true },
              { physical: 0xb000n, bytes: little([0x1111n]) },
              { physical: 0xc000n, bytes: little([0x2222n]) },
            ],
          },
          async (cpu) => {
            cpu.setFastSystemState(bank());
            cpu.setXmmState(Array.from({ length: 16 }, (_, i) => BigInt(i + 1)));
            cpu.setState(initial(PC, { 4: 0x405000n }));
            const x87 = cpu.readX87State(),
              mxcsr = cpu.readMxcsr();
            const result = await cpu.run({ budget: 6n });
            equal(result.reason, 'budget', 'whole guest path completes');
            equal(result.retired, 6n, 'PXOR entry root change return and load');
            equal(result.state.rip, PC + 13n, 'user load completed');
            equal(result.state.registers[3], 0x2222n, 'new root selects user data');
            equal(result.state.registers[4], 0x405000n, 'no implicit stack change');
            equal(cpu.readContext().cpl, 3, 'returned user privilege');
            equal(cpu.readPagingState().cr3, 0x5000n, 'guest root published');
            same(
              cpu.readXmmState(),
              Array.from({ length: 16 }, (_, i) => (i === 0 ? 0n : BigInt(i + 1))),
              'dirty XMM local survives helper dispatch',
            );
            same(cpu.readX87State(), x87, 'x87 preserved');
            equal(cpu.readMxcsr(), mxcsr, 'MXCSR preserved');
          },
        );
      },
    },
  ];
}
