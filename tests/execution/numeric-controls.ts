import { Core } from '../../host/core.js';
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
      name: 'numeric compatibility16 and32 preserve live guards and CLTS completion across direct and helper forms',
      async run() {
        for (const default32 of [false, true]) {
          const context = longSnapshot();
          context.mode = 'compatibility';
          context.segments.cs.long = false;
          context.segments.cs.default32 = default32;
          await usingPaged(
            compiler,
            {
              code: '0f06d9e8660fefc0',
              context,
              bank: { ...BANK, cr0: 0x8000003bn },
              words: [
                [0x3000n, 0x4007n],
                [0x4008n, 0x9007n],
              ],
            },
            async (cpu) => {
              cpu.setState(initial(0x1000n, {}, 0x10002n));
              const completed = await cpu.run({ budget: 3n });
              equal(completed.reason, 'budget', 'CLTS/x87/XMM complete');
              equal(completed.retired, 3n, 'three completed instructions');
              equal(completed.state.rip, 0x1008n, 'literal instruction lengths');
              equal(completed.state.flags, 2n, 'ordinary RF begin');
              equal(cpu.readPagingState().cr0, 0x80000033n, 'TS only cleared');
              equal(cpu.readX87State().tagWord, 0x3fff, 'one x87 push');
              equal(cpu.readXmmState()[0], 0n, 'direct XMM operation');
              cpu.setPagingState({ ...BANK, cr0: 0x8000003bn, cr4: 0x428n });
              cpu.setState(initial(0x1004n, {}, 0x10002n));
              const disabled = await cpu.run({ budget: 1n });
              equal(disabled.reason, 'invalid-encoding', 'OSFXSR #UD precedes TS #NM');
              equal(disabled.numericControlFault?.phase, 'admission', 'pre-execution record');
              equal(disabled.numericControlFault?.cause, 'osfxsr', 'typed disable cause');
              equal(disabled.state.flags, 0x10002n, 'pre-begin RF retained');
            },
          );
        }
      },
    },
    {
      name: 'numeric reached probe beats exhausted compile quota but untaken disabled forms stay unexecuted',
      async run() {
        await usingPaged(
          compiler,
          {
            code: 'ffe0',
            bank: { ...BANK, cr0: 0x8000003bn },
            limits: { maxInstructions: 1, maxTranslationsPerRun: 1 },
          },
          async (cpu) => {
            cpu.writePhysicalMemory(0x9100n, hex('d9e8'));
            cpu.setState(initial(PC, { 0: PC + 0x100n }));
            const result = await cpu.run({ budget: 2n });
            equal(result.reason, 'device-not-available', 'reached cold fault');
            equal(result.retired, 1n, 'only JMP');
            equal(result.remaining, 1n, 'numeric consumes none');
            equal(result.resources.compilations, 1, 'no second compile');
            equal(result.resources.nativeEntries, 1, 'only JMP enters');
          },
        );
        await usingPaged(
          compiler,
          { code: 'eb02d9e890', bank: { ...BANK, cr0: 0x8000003bn } },
          async (cpu) => {
            const before = cpu.readX87State();
            cpu.setState(initial(PC));
            const result = await cpu.run({ budget: 2n });
            equal(result.reason, 'budget', 'skipped disabled form');
            equal(result.state.rip, PC + 5n, 'JMP and NOP');
            same(cpu.readX87State(), before, 'future form no effect');
          },
        );
      },
    },
    {
      name: 'numeric pending async artifacts are cancelled by control ABA while installed live guards remain reusable',
      async run() {
        const create = Core.create,
          compile = WebAssembly.compile;
        let core: Core | undefined;
        Core.create = async (...args) => {
          core = await create(...args);
          return core;
        };
        try {
          await usingPaged(
            compiler,
            { code: '90d9e8', limits: { maxInstructions: 1 } },
            async (cpu) => {
              cpu.setState(initial(PC));
              await cpu.run({ budget: 1n });
              const installed = cpu.inspectTranslations()[0]!.owner;
              let crossed = false;
              WebAssembly.compile = async (bytes) => {
                if (!crossed) {
                  crossed = true;
                  check(core, 'actual Core');
                  core.setPagingState({ ...BANK, cr0: 0x8000003bn });
                  core.setPagingState(BANK);
                  equal(core.valid(installed), true, 'published owner retained');
                }
                return compile(bytes);
              };
              cpu.setState(initial(PC + 1n));
              const result = await cpu.run({ budget: 1n });
              equal(crossed, true, 'crossed real browser compile');
              equal(result.resources.compilations, 2, 'cancelled then fresh');
              equal(result.resources.nativeEntries, 1, 'no stale native entry');
              equal(result.retired, 1n, 'one numeric execution');
            },
          );
        } finally {
          Core.create = create;
          WebAssembly.compile = compile;
        }
      },
    },
    {
      name: 'numeric admission precedes data DR and bad operands while execute DB keeps its priority',
      async run() {
        await usingPaged(
          compiler,
          { code: 'd907', bank: { ...BANK, cr0: 0x8000003bn } },
          async (cpu) => {
            cpu.setDebugState({ addresses: [0x500000n, 0n, 0n, 0n], dr6: 0n, dr7: 0x30401n });
            cpu.setState(initial(PC, { 7: 0x500000n }, 0x10002n));
            const fault = await cpu.run({ budget: 1n });
            equal(fault.reason, 'device-not-available', 'NM before data access');
            equal(cpu.readDebugState().dr6 & 15n, 0n, 'no operand hit');
            equal(fault.state.flags, 0x10002n, 'RF retained');
            cpu.setDebugState({ addresses: [PC, 0n, 0n, 0n], dr6: 0n, dr7: 0x401n });
            cpu.setState(initial(PC, { 7: 0x500000n }));
            const debug = await cpu.run({ budget: 1n });
            equal(debug.reason, 'debug-exception', 'execute DB precedes admission');
            equal(debug.deviceNotAvailable, undefined, 'exclusive diagnostic');
          },
        );
      },
    },
    {
      name: 'numeric FX under OSFXSR0 still saves XMM MXCSR and CVTPI2PD memory alone bypasses pending MF',
      async run() {
        await usingPaged(
          compiler,
          {
            code: '0fae00',
            bank: { ...BANK, cr4: 0x28n },
            words: [[0x4008n, 0xa007n]],
            spans: [{ physical: 0xa000n, bytes: new Uint8Array(512).fill(0xa5) }],
          },
          async (cpu) => {
            const xmm = cpu.readXmmState();
            xmm[0] = 0x112233445566778899aabbccddeeff00n;
            cpu.setXmmState(xmm);
            cpu.setMxcsr(0x1f01);
            cpu.setState(initial(PC, { 0: PC + 0x1000n }));
            const result = await cpu.run({ budget: 1n });
            equal(result.retired, 1n, 'FX admitted despite OSFXSR0');
            const bytes = cpu.readPhysicalMemory(0xa000n, 512);
            same(
              bytes.slice(160, 176),
              little([0x99aabbccddeeff00n, 0x1122334455667788n]),
              'XMM image',
            );
            equal(new DataView(bytes.buffer).getUint32(24, true), 0x1f01, 'MXCSR image');
          },
        );
        await usingPaged(
          compiler,
          {
            code: '660f2a07',
            words: [[0x4008n, 0xa007n]],
            spans: [{ physical: 0xa000n, bytes: little([0x200000001n]) }],
          },
          async (cpu) => {
            const before = cpu.readX87State();
            before.controlWord = 0x37e;
            before.statusWord = 0x8081;
            cpu.setX87State(before);
            cpu.setState(initial(PC, { 7: PC + 0x1000n }));
            const result = await cpu.run({ budget: 1n });
            equal(result.retired, 1n, 'memory PI2PD skips MF');
            equal(cpu.readXmmState()[0], 0x40000000000000003ff0000000000000n, 'two exact doubles');
            same(cpu.readX87State(), before, 'no alias transition');
          },
        );
      },
    },
    {
      name: 'numeric pending NM is benign on entry GP and subsequent decoder UD cannot inherit numeric metadata',
      async run() {
        await usingPaged(
          compiler,
          { code: 'd9e80f20c8', bank: { ...BANK, cr0: 0x8000003bn } },
          async (cpu) => {
            cpu.setState(initial(PC));
            const failure = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
            equal(failure.reason, 'event-budget', 'one failed NM entry attempt');
            check(failure.state.event.kind === 'pending', 'secondary pending');
            equal(failure.state.event.exception.vector, 13, 'benign NM yields GP rather than DF');
            equal(
              failure.state.event.exception.deviceNotAvailable,
              undefined,
              'old source dropped',
            );
            cpu.setState(initial(PC + 2n));
            const invalid = await cpu.run({ budget: 1n });
            equal(invalid.reason, 'invalid-encoding', 'ordinary decoder UD');
            equal(invalid.numericControlFault, undefined, 'no stale numeric cause');
            equal(invalid.deviceNotAvailable, undefined, 'no stale NM cause');
          },
        );
      },
    },
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
