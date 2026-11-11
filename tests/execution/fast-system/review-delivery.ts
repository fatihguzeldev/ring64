import type { FastSystemState } from '../../../host/index.js';
import { longSnapshot } from '../../support/context.js';
import { gate } from '../software-events/fixture.js';
import { preserveNumeric } from '../far-control/fixture.js';
import {
  BANK,
  PC,
  equal,
  hex,
  initial,
  little,
  same,
  usingPaged,
  type PagedSetup,
  type Scenario,
} from '../paging/fixture.js';

const HANDLER = 0x401000n;
const TARGET = 0x407000n;
const USER_SP = 0x405ff0n;
const FAST: FastSystemState = {
  star: 0x0020000800000000n,
  lstar: HANDLER,
  fmask: 0n,
  sysenterCs: 8n,
  sysenterEip: HANDLER,
  sysenterEsp: 0x405000n,
  kernelGsBase: 0x12340000n,
};

function setup(
  code: string,
  handler: string,
  vector: number,
  ist: number,
  cs: number,
  ss: number,
  wide: boolean,
): PagedSetup {
  const context = longSnapshot(0x1234n, 0x5678n);
  context.gdtr = { base: 0x402000n, limit: 0x3f };
  context.idtr = { base: 0x403000n, limit: 0xfff };
  context.tr = { selector: 0x38, valid: true, base: 0x406000n, limit: 0x67, attributes: 0x8b };
  const gdt = new Uint8Array(0x1000);
  gdt.set(little([0x00af9b000000ffffn, 0x00cf93000000ffffn]), 8);
  gdt.set(little([wide ? 0x00affb000000ffffn : 0x00cffb000000ffffn]), cs & ~3);
  gdt.set(little([0x00cff3000000ffffn]), ss & ~3);
  const idt = new Uint8Array(0x1000);
  idt.set(hex(gate(64, 8, HANDLER, 0, false, ist)), vector * 16);
  const tss = new Uint8Array(0x1000);
  tss.set(little([0x405000n]), 4);
  tss.set(little([0x409000n]), 36);
  return {
    code,
    context,
    bank: { ...BANK, cr2: 0xdeadn, efer: 0xd01n },
    words: [
      [0x4008n, 0xa003n],
      [0x4010n, 0xb003n],
      [0x4018n, 0xc003n],
      [0x4020n, 0xd003n],
      [0x4028n, 0xe007n],
      [0x4030n, 0xf003n],
      [0x4038n, vector === 14 ? 0x10003n : 0x10007n],
      [0x4040n, 0x11003n],
    ],
    spans: [
      { physical: 0xa000n, bytes: hex(handler), execute: true },
      { physical: 0xb000n, bytes: gdt },
      { physical: 0xc000n, bytes: idt },
      { physical: 0xd000n, bytes: new Uint8Array(0x1000).fill(0xa5) },
      { physical: 0xe000n, bytes: new Uint8Array(0x1000).fill(0x5a) },
      { physical: 0xf000n, bytes: tss },
      { physical: 0x10000n, bytes: hex('90'), execute: true },
      { physical: 0x11000n, bytes: new Uint8Array(0x1000).fill(0xa5) },
    ],
  };
}

export function fastSystemReviewDeliveryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'fast delivery review all returned user target PFs build literal TSS RSP0 or IST error frames after committing the transfer',
      async run() {
        for (const [code, cs, ss, wide, sysexit] of [
          ['0f07', 0x23, 0x2b, false, false],
          ['480f07', 0x33, 0x2b, true, false],
          ['0f35', 0x1b, 0x23, false, true],
          ['480f35', 0x2b, 0x33, true, true],
        ] as const)
          for (const ist of [0, 1]) {
            await usingPaged(
              compiler,
              setup(code, '4883c40848cf', 14, ist, cs, ss, wide),
              async (cpu) => {
                cpu.setFastSystemState(FAST);
                cpu.setState(
                  initial(
                    PC,
                    { 1: sysexit ? USER_SP : TARGET, 2: TARGET, 4: USER_SP, 11: 0x202n },
                    0x202n,
                  ),
                );
                const before = cpu.readState();
                const numeric = preserveNumeric(cpu);
                const debug = cpu.readDebugState();
                const result = await cpu.run({
                  budget: 2n,
                  stop: HANDLER,
                  eventDelivery: { budget: 1n },
                });
                equal(result.reason, 'stop', 'actual PF handler admitted');
                equal(result.retired, 1n, 'return committed once before target fault');
                equal(result.remaining, 1n, 'unfetched user NOP did not retire');
                equal(result.deliveryAttempts, 1n, 'one actual processor PF admission');
                equal(result.remainingDeliveryBudget, 0n, 'entry quota consumed once');
                equal(result.repeatIterations, 0n, 'no repeat work');
                equal(result.remainingRepeatBudget, 2n, 'repeat allowance preserved');
                const stack = ist ? 0x11000n : 0xd000n;
                const frame = little([21n, TARGET, BigInt(cs), 0x10202n, USER_SP, BigInt(ss)]);
                const expected = new Uint8Array(0x1000).fill(0xa5);
                expected.set(frame, 0xfd0);
                same(
                  cpu.readPhysicalMemory(stack, 0x1000),
                  expected,
                  'full literal user error frame and stack guards',
                );
                same(
                  cpu.readPhysicalMemory(ist ? 0xd000n : 0x11000n, 0x1000),
                  new Uint8Array(0x1000).fill(0xa5),
                  'unselected TSS stack untouched',
                );
                same(
                  cpu.readPhysicalMemory(0xe000n, 0x1000),
                  new Uint8Array(0x1000).fill(0x5a),
                  'user stack untouched',
                );
                equal(result.state.rip, HANDLER, 'handler has not executed');
                equal(
                  result.state.registers[4],
                  ist ? 0x408fd0n : 0x404fd0n,
                  'selected TSS pointer',
                );
                same(
                  result.state.registers,
                  before.registers.map((value, index) =>
                    index === 4 ? (ist ? 0x408fd0n : 0x404fd0n) : value,
                  ),
                  'only return and entry stack effects',
                );
                equal(cpu.readContext().cpl, 0, 'PF handler CPL');
                equal(cpu.readContext().segments.cs.selector, 8, 'PF handler CS');
                equal(cpu.readPagingState().cr2, TARGET, 'PF CR2 is committed destination');
                same(result.state.event, { kind: 'ready' }, 'source consumed by actual entry');
                cpu.writePhysicalMemory(0x4038n, little([0x10007n]));
                const resumed = await cpu.run({ budget: 3n, eventDelivery: { budget: 0n } });
                equal(resumed.reason, 'budget', 'repaired target executes');
                equal(resumed.retired, 3n, 'error-slot removal IRET and NOP only');
                equal(resumed.state.rip, TARGET + 1n, 'no replay of completed fast return');
                equal(resumed.state.registers[4], USER_SP, 'IRET restores user stack');
                equal(cpu.readContext().cpl, 3, 'returned user CPL');
                equal(
                  cpu.readContext().segments.cs.selector,
                  cs,
                  'original synthetic user CS restored',
                );
                equal(
                  cpu.readContext().mode,
                  wide ? 'long64' : 'compatibility',
                  'return submode retained',
                );
                same(cpu.readDebugState(), debug, 'debug bank preserved');
                same(cpu.readFastSystemState(), FAST, 'fast bank preserved');
                numeric();
              },
            );
          }
      },
    },
    {
      name: 'fast delivery review SYSRET source GP uses IST with an already user-valued RSP and guest IRET repair retries exactly once',
      async run() {
        await usingPaged(
          compiler,
          setup('480f07', '48b900704000000000004883c40848cf', 13, 1, 0x33, 0x2b, true),
          async (cpu) => {
            cpu.setFastSystemState(FAST);
            cpu.setState(initial(PC, { 1: 0x800000000000n, 4: USER_SP, 11: 0x202n }, 0x202n));
            const before = cpu.readState();
            const numeric = preserveNumeric(cpu);
            const debug = cpu.readDebugState();
            const first = await cpu.run({
              budget: 5n,
              stop: HANDLER,
              eventDelivery: { budget: 1n },
            });
            equal(first.reason, 'stop', 'GP handler entered on IST');
            equal(first.retired, 0n, 'source SYSRET fault did not retire');
            equal(first.remaining, 5n, 'fault consumed no instruction allowance');
            equal(first.deliveryAttempts, 1n, 'one actual GP admission');
            equal(first.remainingDeliveryBudget, 0n, 'entry quota consumed');
            const expected = new Uint8Array(0x1000).fill(0xa5);
            expected.set(little([0n, PC, 8n, 0x10202n, USER_SP, 16n]), 0xfd0);
            same(
              cpu.readPhysicalMemory(0x11000n, 0x1000),
              expected,
              'source CPL0 CS8 SS16 zero-error frame on guarded IST',
            );
            same(
              cpu.readPhysicalMemory(0xe000n, 0x1000),
              new Uint8Array(0x1000).fill(0x5a),
              'user-valued RSP was never used for entry storage',
            );
            same(
              cpu.readPhysicalMemory(0xd000n, 0x1000),
              new Uint8Array(0x1000).fill(0xa5),
              'RSP0 was not substituted for IST',
            );
            same(
              first.state.registers,
              before.registers.map((value, index) => (index === 4 ? 0x408fd0n : value)),
              'fault retains all return operands',
            );
            equal(cpu.readContext().cpl, 0, 'source fault remains kernel CPL');
            equal(cpu.readContext().segments.cs.selector, 8, 'kernel handler CS');
            equal(cpu.readPagingState().cr2, 0xdeadn, 'noncanonical RCX is GP without CR2');
            const repaired = await cpu.run({ budget: 4n, eventDelivery: { budget: 0n } });
            equal(repaired.reason, 'budget', 'guest repair reaches returned boundary');
            equal(repaired.retired, 4n, 'MOV RCX ADD RSP IRET and retried SYSRET once');
            equal(repaired.deliveryAttempts, 0n, 'no second exception');
            equal(repaired.state.rip, TARGET, 'destination has not fetched');
            equal(
              repaired.state.registers[4],
              USER_SP,
              'full original RSP survives IRET and SYSRET',
            );
            equal(repaired.state.registers[1], TARGET, 'guest repair retained');
            equal(repaired.state.flags, 0x202n, 'SYSRET applies repaired return flags');
            equal(cpu.readContext().cpl, 3, 'successful retry commits user CPL');
            equal(cpu.readContext().segments.cs.selector, 0x33, 'user CS');
            equal(cpu.readContext().segments.ss.selector, 0x2b, 'user SS');
            same(
              cpu.readPhysicalMemory(0xe000n, 0x1000),
              new Uint8Array(0x1000).fill(0x5a),
              'repair never writes user stack',
            );
            same(cpu.readDebugState(), debug, 'debug preserved');
            same(cpu.readFastSystemState(), FAST, 'bank preserved');
            numeric();
          },
        );
      },
    },
  ];
}
