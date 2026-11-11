import { captureNumericFault } from '../../host/numeric-controls.js';
import { longSnapshot } from '../support/context.js';
import {
  BANK,
  PC,
  usingPaged,
  equal,
  check,
  initial,
  little,
  hex,
  type Scenario,
} from './paging/fixture.js';
import { same } from './far-control/fixture.js';

export function numericControlScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'numeric live admission covers all32 control images and direct/helper forms before RF operands and compile quota',
      async run() {
        for (const [code, family] of [
          ['d9e8', 'x87'],
          ['9b', 'wait'],
          ['0fefc0', 'mmx'],
          ['660fefc0', 'simd'],
          ['f30fd6c1', 'bridge'],
          ['0fae00', 'fx-image'],
        ] as const) {
          await usingPaged(compiler, { code }, async (cpu) => {
            const payload = cpu.readX87State(),
              xmm = cpu.readXmmState();
            for (let bits = 0; bits < 32; bits++) {
              const mp = !!(bits & 1),
                em = !!(bits & 2),
                ts = !!(bits & 4),
                osfxsr = !!(bits & 8),
                osxmmexcpt = !!(bits & 16);
              cpu.setPagingState({
                ...BANK,
                cr0: 0x80000031n | (BigInt(bits & 7) << 1n),
                cr4: 0x28n | (BigInt(bits >> 3) << 9n),
              });
              cpu.setX87State(payload);
              cpu.setXmmState(xmm);
              const before = initial(PC, { 0: 0x800000000000n }, 0x10002n);
              cpu.setState(before);
              const denied =
                family === 'x87' || family === 'fx-image'
                  ? em || ts
                    ? 7
                    : 0
                  : family === 'wait'
                    ? mp && ts
                      ? 7
                      : 0
                    : em || (family !== 'mmx' && !osfxsr)
                      ? 6
                      : ts
                        ? 7
                        : 0;
              const result = await cpu.run({ budget: 1n });
              if (!denied) {
                if (family === 'fx-image')
                  equal(result.reason, 'data-fault', 'enabled FX reaches bad operand');
                else equal(result.retired, 1n, 'enabled form completes');
                continue;
              }
              equal(
                result.reason,
                denied === 7 ? 'device-not-available' : 'invalid-encoding',
                'typed admission reason',
              );
              equal(result.retired, 0n, 'disabled form does not retire');
              equal(result.resources.compilations, 0, 'cold/reused denied form needs no compile');
              equal(result.state.flags, 0x10002n, 'pre-begin RF retained');
              same(result.state.registers, before.registers, 'no destination');
              same(cpu.readX87State(), payload, 'no x87 update');
              same(cpu.readXmmState(), xmm, 'no XMM update');
              const source = result.deviceNotAvailable ?? result.numericControlFault;
              check(source, 'complete diagnostic');
              same(source.controls, { mp, em, ts, osfxsr, osxmmexcpt }, 'captured facts');
              equal(source.family, family, 'decoded family');
              same(captureNumericFault(source), source, 'public source intrinsically valid');
            }
          });
        }
      },
    },
    {
      name: 'numeric CLTS completes once with final budget and retained source owners survive eligibility ABA',
      async run() {
        await usingPaged(compiler, { code: '0f06d9e890' }, async (cpu) => {
          cpu.setPagingState({ ...BANK, cr0: 0x8000003bn });
          cpu.setState(initial(PC));
          const first = await cpu.run({ budget: 1n });
          equal(first.retired, 1n, 'CLTS final budget');
          equal(first.state.rip, PC + 2n, 'completed next PC');
          equal(cpu.readPagingState().cr0, 0x80000033n, 'only TS cleared');
          const next = await cpu.run({ budget: 1n });
          equal(next.retired, 1n, 'retry numeric');
          const owners = cpu.inspectTranslations().map((a) => a.owner);
          for (let iteration = 0; iteration < 101; iteration++) {
            cpu.setPagingState({ ...BANK, cr0: 0x8000003bn });
            cpu.setState(initial(PC + 2n));
            const fault = await cpu.run({ budget: 1n });
            equal(fault.reason, 'device-not-available', 'live retained guard');
            cpu.setPagingState(BANK);
            cpu.setState(initial(PC + 2n));
            const resumed = await cpu.run({ budget: 1n });
            equal(resumed.resources.compilations, 0, 'enabled return reuses owner');
            equal(resumed.retired, 1n, 'one actual numeric execution');
          }
          same(
            cpu.inspectTranslations().map((a) => a.owner),
            owners,
            'numeric edits retain code',
          );
        });
      },
    },
    {
      name: 'numeric OSXMMEXCPT0 publishes MXCSR before typed numeric UD and suppresses destination',
      async run() {
        await usingPaged(compiler, { code: 'f20f5ec1' }, async (cpu) => {
          cpu.setPagingState({ ...BANK, cr4: 0x228n });
          cpu.setMxcsr(0x1d80);
          const xmm = cpu.readXmmState();
          xmm[0] = 0x3ff0000000000000n;
          xmm[1] = 0n;
          cpu.setXmmState(xmm);
          cpu.setState(initial(PC, {}, 0x10002n));
          const result = await cpu.run({ budget: 1n });
          equal(result.reason, 'invalid-encoding', 'new numeric UD');
          equal(result.state.flags, 2n, 'post-begin RF cleared');
          equal(cpu.readMxcsr(), 0x1d84, 'divide-zero published');
          same(cpu.readXmmState(), xmm, 'unmasked destination suppressed');
          check(result.numericControlFault?.phase === 'numeric', 'numeric provenance');
          equal(result.numericControlFault.raised, 4, 'ZE');
          equal(result.numericControlFault.unmasked, 4, 'unmasked ZE');
          equal(result.simdException, undefined, 'not XM');
        });
      },
    },
    {
      name: 'numeric NM frozen source survives TS repair state roundtrip and guest CLTS IRET retry',
      async run() {
        const context = longSnapshot();
        context.gdtr = { base: 0x402000n, limit: 0x17 };
        context.idtr = { base: 0x403000n, limit: 0xfff };
        const gdt = new Uint8Array(0x1000);
        gdt.set(little([0x00af9b000000ffffn, 0x00cf93000000ffffn]), 8);
        const idt = new Uint8Array(0x1000);
        idt.set(hex('00100800008e40000000000000000000'), 7 * 16);
        await usingPaged(
          compiler,
          {
            code: 'd9e8',
            context,
            bank: { ...BANK, cr0: 0x8000003bn },
            words: [
              [0x4008n, 0xa007n],
              [0x4010n, 0xb007n],
              [0x4018n, 0xc007n],
              [0x4020n, 0xd007n],
            ],
            spans: [
              { physical: 0xa000n, bytes: hex('0f0648cf'), execute: true },
              { physical: 0xb000n, bytes: gdt },
              { physical: 0xc000n, bytes: idt },
              { physical: 0xd000n, bytes: new Uint8Array(0x1000) },
            ],
          },
          async (cpu) => {
            cpu.setState(initial(PC, { 4: 0x405000n }));
            const held = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(held.reason, 'event-budget', 'freeze NM');
            check(held.state.event.kind === 'pending', 'pending source');
            const event = held.state.event.exception;
            equal(event.vector, 7, 'vector7');
            check(event.deviceNotAvailable?.controls.ts, 'captured TS');
            cpu.setPagingState(BANK);
            cpu.setState(held.state);
            same(cpu.readState().event, held.state.event, 'historical TS1 valid under TS0');
            const result = await cpu.run({
              budget: 4n,
              eventDelivery: { budget: 1n },
              stop: PC + 2n,
            });
            equal(result.reason, 'stop', 'complete guest retry');
            equal(result.retired, 3n, 'CLTS IRET FLD1');
            equal(result.state.registers[4], 0x405000n, 'stack restored');
            equal(cpu.readX87State().tagWord, 0x3fff, 'one push');
          },
        );
      },
    },
  ];
}
