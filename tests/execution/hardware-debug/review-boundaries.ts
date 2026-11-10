import {
  using,
  snapshot,
  initial,
  loadedCode,
  loadedData,
  CODE32,
  CODE64,
  DATA32,
  image,
  encoded,
  equal,
  same,
  check,
  preserveNumeric,
  type Scenario,
} from '../exception-delivery/fixture.js';
import { reviewNumericScenarios } from './review-numeric.js';
import { reviewCaptureScenarios } from './review-capture.js';

export function reviewBoundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...reviewNumericScenarios(compiler),
    ...reviewCaptureScenarios(compiler),
    {
      name: 'hardware debug review virtual8086 IRET data trap captures destination VM flags and restores as a detached pending checkpoint',
      async run() {
        const context = snapshot('protected');
        context.segments.cs = loadedCode(32);
        context.segments.ss = loadedData(32);
        const frame = image([0x2000n, 0n, 0x20202n, 0x7000n, 0n, 0n, 0n, 0n, 0n], 4);
        await using(
          compiler,
          'cf',
          context,
          async (cpu) => {
            cpu.setDebugState({ addresses: [0x6020n, 0x4008n, 0n, 0n], dr6: 0n, dr7: 0x003f0405n });
            cpu.setState(initial(0x1000n, { 4: 0x6000n }, 0x202n));
            const before = cpu.readState();
            const numeric = preserveNumeric(cpu);
            const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(result.reason, 'event-budget', 'completed VM return selects before final budget');
            equal(result.retired, 1n, 'IRETD retires once');
            equal(result.state.rip, 0x2000n, 'VM logical continuation');
            equal(result.state.flags, 0x202n, 'VM stays context-derived');
            same(
              result.state.registers,
              before.registers.map((value, index) => (index === 4 ? 0x7000n : value)),
              'prepared outer SP',
            );
            equal(
              cpu.readContext().mode,
              'virtual8086',
              'destination mode published before debug image',
            );
            equal(cpu.readContext().cpl, 3, 'destination CPL');
            check(result.state.event.kind === 'pending', 'selected processor source');
            same(
              result.state.event.exception,
              {
                vector: 1,
                instructionPc: 0x1000n,
                returnPc: 0x2000n,
                savedFlags: 0x20202n,
                debug: {
                  class: 'trap',
                  cause: 'data-breakpoint',
                  breakpoints: 1,
                  singleStep: false,
                  instructionCompleted: true,
                },
              },
              'exact VM data trap source',
            );
            same(cpu.readMemory(0x6000n, frame.length), frame, 'all nine source slots unchanged');
            same(cpu.readMemory(0x6024n, 16), new Uint8Array(16).fill(0xa5), 'frame tail guard');
            cpu.setDebugState({ addresses: [0n, 0n, 0n, 0n], dr6: 0n, dr7: 0x400n });
            cpu.setState(result.state);
            same(
              cpu.readState(),
              result.state,
              'frozen VM source imports independently of removed slot',
            );
            numeric();
          },
          { data: [{ base: 0x6000n, bytes: encoded(frame) + 'a5'.repeat(16) }] },
        );
      },
    },
    {
      name: 'hardware debug review LFS samples its old FS operand while descriptor reads and accessed writes stay excluded',
      async run() {
        const context = snapshot();
        context.segments.fs.base = 0x10000n;
        await using(
          compiler,
          '64480fb403',
          context,
          async (cpu) => {
            cpu.setDebugState({
              addresses: [0x16008n, 0x4015n, 0x4010n, 0n],
              dr6: 0n,
              dr7: 0x03170415n,
            });
            cpu.setState(initial(0x1000n, { 3: 0x6000n }, 0x202n));
            const before = cpu.readState();
            const numeric = preserveNumeric(cpu);
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'debug-exception', 'committed explicit far-pointer load');
            equal(result.retired, 1n, 'LFS retired');
            equal(result.state.rip, 0x1005n, 'complete prefixed instruction');
            equal(result.debugException?.breakpoints, 1, 'old FS source only');
            same(
              result.state.registers,
              before.registers.map((value, index) => (index === 0 ? 0x1122334455667788n : value)),
              'only destination GPR',
            );
            equal(cpu.readContext().segments.fs.base, 0n, 'new FS cache committed before trap');
            equal(cpu.readContext().segments.fs.selector, 16, 'new visible selector');
            same(
              cpu.readMemory(0x16000n, 10),
              Uint8Array.of(0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11, 0x10, 0),
              'literal source pointer unchanged',
            );
            equal(cpu.readMemory(0x4015n, 1)[0], 0x93, 'excluded accessed update still commits');
            equal(cpu.readDebugState().dr6, 0xffff0ff1n, 'only explicit operand source selected');
            numeric();
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE64 + 'ffff00000092cf00' },
              { base: 0x16000n, bytes: '88776655443322111000' },
            ],
          },
        );
      },
    },
    {
      name: 'hardware debug review SGDT observes all ten explicit destination bytes and preserves guards',
      async run() {
        const context = snapshot();
        context.gdtr = { base: 0x4000n, limit: 0x7f };
        await using(
          compiler,
          '0f0103',
          context,
          async (cpu) => {
            cpu.setDebugState({ addresses: [0x6008n, 0x4000n, 0n, 0n], dr6: 0n, dr7: 0x00370405n });
            cpu.setState(initial(0x1000n, { 3: 0x6000n }, 0x202n));
            const before = cpu.readState();
            const numeric = preserveNumeric(cpu);
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'debug-exception', 'explicit pseudo-descriptor store');
            equal(result.retired, 1n, 'SGDT retired');
            equal(result.debugException?.breakpoints, 1, 'last destination field observed');
            same(result.state.registers, before.registers, 'all GPRs preserved');
            same(
              cpu.readMemory(0x6000n, 16),
              Uint8Array.of(0x7f, 0, 0, 0x40, 0, 0, 0, 0, 0, 0, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5),
              'ten-byte literal and six-byte guard',
            );
            numeric();
          },
          { data: [{ base: 0x6000n, bytes: 'a5'.repeat(16) }] },
        );
      },
    },
    {
      name: 'hardware debug review IRET observes the full old stack frame before publishing a long or compatibility destination',
      async run() {
        for (const compatibility of [false, true]) {
          const context = snapshot();
          context.segments.cs = loadedCode(64);
          context.segments.ss = loadedData(32, 24);
          await using(
            compiler,
            '48cf',
            context,
            async (cpu) => {
              cpu.setDebugState({
                addresses: [0x6020n, 0x4008n, 0n, 0n],
                dr6: 0n,
                dr7: 0x003b0405n,
              });
              cpu.setState({
                ...initial(0x1000n, { 4: 0x6000n }, 0x202n),
                interrupts: { irq: null, nmiPending: false, nmiBlocked: true },
              });
              const frame = image([0x2000n, compatibility ? 16n : 8n, 0x202n, 0x7000n, 24n], 8);
              const before = cpu.readState();
              const numeric = preserveNumeric(cpu);
              const result = await cpu.run({ budget: 1n });
              equal(
                result.reason,
                'debug-exception',
                'IRET trap before unmapped destination fetch',
              );
              equal(result.retired, 1n, 'IRET retired once');
              equal(result.state.rip, 0x2000n, 'actual destination PC');
              equal(result.state.flags, 0x202n, 'restored destination FLAGS');
              equal(
                result.debugException?.breakpoints,
                1,
                'fifth frame slot included, GDT excluded',
              );
              equal(
                result.debugException?.instructionCompleted,
                true,
                'completed context transfer',
              );
              same(
                result.state.registers,
                before.registers.map((value, index) => (index === 4 ? 0x7000n : value)),
                'only prepared SP published',
              );
              equal(
                cpu.readContext().mode,
                compatibility ? 'compatibility' : 'long64',
                'actual destination context',
              );
              equal(
                result.state.interrupts.nmiBlocked,
                false,
                'IRET early unblock survives completion',
              );
              same(cpu.readMemory(0x6000n, 40), frame, 'source frame untouched');
              numeric();
            },
            {
              data: [
                { base: 0x4008n, bytes: CODE64 + CODE32 + DATA32 },
                {
                  base: 0x6000n,
                  bytes: encoded(
                    image([0x2000n, compatibility ? 16n : 8n, 0x202n, 0x7000n, 24n], 8),
                  ),
                },
              ],
            },
          );
        }
      },
    },
    {
      name: 'hardware debug review far CALL and RETF observe control-stack operands under the old segment base',
      async run() {
        const context = snapshot('protected');
        context.segments.cs = loadedCode(32);
        context.segments.ss = loadedData(32);
        context.segments.ss.base = 0x10000n;
        await using(
          compiler,
          'ff1b',
          context,
          async (cpu) => {
            cpu.setDebugState({
              addresses: [0x6004n, 0x17ff8n, 0x4008n, 0n],
              dr6: 0n,
              dr7: 0x03970415n,
            });
            cpu.setState(initial(0x1000n, { 3: 0x6000n, 4: 0x8000n }, 0x202n));
            const before = cpu.readState();
            const called = await cpu.run({ budget: 1n });
            equal(called.reason, 'debug-exception', 'CALL trap before successor');
            equal(
              called.debugException?.breakpoints,
              3,
              'explicit pointer and both pushed slots, no metadata',
            );
            same(
              called.state.registers,
              before.registers.map((value, index) => (index === 4 ? 0x7ff8n : value)),
              'CALL changes only SP',
            );
            equal(called.state.rip, 0x2000n, 'far destination');
            same(cpu.readMemory(0x17ff8n, 8), image([0x1002n, 8n], 4), 'literal CALL frame');
            same(
              cpu.readMemory(0x17f00n, 248),
              new Uint8Array(248).fill(0xa5),
              'lower frame guard',
            );
            cpu.setDebugState({ addresses: [0x17ff8n, 0n, 0n, 0n], dr6: 0n, dr7: 0xb0401n });
            const returned = await cpu.run({ budget: 1n });
            equal(returned.reason, 'debug-exception', 'RETF stack-read trap');
            equal(returned.debugException?.breakpoints, 1, 'both source slots overlap comparator');
            equal(returned.state.rip, 0x1002n, 'return target');
            same(returned.state.registers, before.registers, 'source raw SP fully restored');
            same(
              cpu.readMemory(0x17ff8n, 8),
              image([0x1002n, 8n], 4),
              'return reads never rewrite the frame',
            );
          },
          {
            data: [
              { base: 0x4008n, bytes: CODE32 + DATA32 },
              { base: 0x6000n, bytes: '002000000800' },
              { base: 0x17f00n, bytes: 'a5'.repeat(256) },
              { base: 0x2000n, bytes: 'cb', execute: true },
            ],
          },
        );
      },
    },
    {
      name: 'hardware debug review outer RETF cleanup observes saved outer SP and SS but not skipped parameters',
      async run() {
        const context = snapshot('protected');
        context.segments.cs = loadedCode(32);
        context.segments.ss = loadedData(32);
        const frame = image([0x2000n, 11n, 0xa5a5a5a5n, 0xa5a5a5a5n, 0x7000n, 19n], 4);
        await using(
          compiler,
          'ca0800',
          context,
          async (cpu) => {
            cpu.setDebugState({
              addresses: [0x6008n, 0x6010n, 0x4008n, 0n],
              dr6: 0n,
              dr7: 0x03bb0415n,
            });
            cpu.setState(initial(0x1000n, { 4: 0x6000n }, 0x202n));
            const before = cpu.readState();
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'debug-exception', 'outer return trap');
            equal(
              result.debugException?.breakpoints,
              2,
              'outer saved slots only, cleanup holes excluded',
            );
            equal(result.state.rip, 0x2000n, 'outer destination PC');
            same(
              result.state.registers,
              before.registers.map((value, index) => (index === 4 ? 0x7008n : value)),
              'cleanup applied to restored pointer once',
            );
            equal(cpu.readContext().cpl, 3, 'outer privilege committed before source publication');
            same(cpu.readMemory(0x6000n, 24), frame, 'whole skipped frame retained');
          },
          {
            data: [
              { base: 0x4008n, bytes: 'ffff000000fbcf00ffff000000f3cf00' },
              { base: 0x6000n, bytes: encoded(frame) },
            ],
          },
        );
      },
    },
  ];
}
