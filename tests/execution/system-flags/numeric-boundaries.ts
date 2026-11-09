import {
  using,
  snapshot,
  initial,
  outcome,
  equal,
  same,
  preserveNumeric,
  type Scenario,
} from './fixture.js';
import { pending } from '../x87/fixture.js';

const FLAGS = 0x3d7ed7n;
const HISTORY = { sti: false, ss: true };

export function numericBoundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'system RF pending numeric checks precede data stack-segment and transition effects',
      async run() {
        const waiting = [
          '9b', // WAIT.
          'd903', // FLD m32.
          'db2b', // FLD m80.
          'db3b', // FSTP m80.
          'd92b', // FLDCW m16.
          'd9c0', // FLD ST0.
          '0f77', // EMMS.
          '0f6f03', // MOVQ MM0,m64.
          '0fe703', // MOVNTQ m64,MM0.
          '0ff7c1', // MASKMOVQ MM0,MM1.
          '0f2ac1', // CVTPI2PS XMM0,MM1.
          '660f2ac1', // CVTPI2PD XMM0,MM1.
          '0f2a03', // CVTPI2PS XMM0,m64.
          '0f2dc1', // CVTPS2PI MM0,XMM1.
          '660f2dc1', // CVTPD2PI MM0,XMM1.
          '0f2cc1', // CVTTPS2PI MM0,XMM1.
          '660f2cc1', // CVTTPD2PI MM0,XMM1.
          'd923', // FLDENV.
          'dd23', // FRSTOR.
        ];
        for (const stackSegment of [false, true]) {
          for (const code of waiting) {
            const execution = snapshot(stackSegment ? 'protected' : 'long64');
            if (stackSegment) execution.segments.ss.limit = 0;
            await using(compiler, (stackSegment ? '36' : '') + code, execution, async (cpu) => {
              const numeric = preserveNumeric(cpu);
              const raw = cpu.readX87State();
              const before = initial(0x1000n, { 3: 0x7000n, 7: 0x7000n }, FLAGS, HISTORY);
              cpu.setState(before);
              for (let retry = 0; retry < 2; retry++) {
                const result = await cpu.run({ budget: 3n, repeatBudget: 11n });
                outcome(result, 'x87-exception', 3n, 0n, 11n);
                pending(result, raw, 0x1000n);
                same(
                  result.state,
                  before,
                  'early pending failure preserves RF and complete scalar history',
                );
                same(cpu.readContext(), execution, 'pending failure preserves loaded context');
                equal(result.debugException, undefined, 'no completed-instruction trap');
                equal(result.protectionFault, undefined, 'no descriptor or privilege fault');
                numeric();
              }
            });
          }
        }
      },
    },
    {
      name: 'system RF no-wait numeric and ordinary memory faults begin despite pending x87 state',
      async run() {
        const ordinary = [
          'd93b', // FNSTCW.
          'dd3b', // FNSTSW m16.
          'd933', // FNSTENV.
          'dd33', // FNSAVE.
          '0fae03', // FXSAVE.
          '0fae0b', // FXRSTOR.
          '660f2a03', // CVTPI2PD m64: no MMX transition or pending check.
          '0fae13', // LDMXCSR.
          '0fae1b', // STMXCSR.
          '660ff7c1', // MASKMOVDQU, even when all mask sign bits are clear.
          '0fae3b', // CLFLUSH.
        ];
        for (const code of ordinary) {
          await using(compiler, code, snapshot(), async (cpu) => {
            const numeric = preserveNumeric(cpu);
            const before = initial(0x1000n, { 3: 0x7000n, 7: 0x7000n }, FLAGS, HISTORY);
            cpu.setState(before);
            const result = await cpu.run({ budget: 3n, repeatBudget: 11n });
            outcome(result, 'data-fault', 3n, 0n, 11n);
            same(result.state, { ...before, flags: 0x3c7ed7n }, 'ordinary failure clears only RF');
            equal(result.fault?.address, 0x7000n, 'addressed operand starts at unmapped byte');
            equal(result.fault?.cause, 'unmapped', 'ordinary admission failure');
            equal(
              result.x87Exception,
              undefined,
              'pending exception does not replace no-wait operation',
            );
            equal(result.debugException, undefined, 'no completed-instruction trap');
            numeric();
          });
        }
        await using(compiler, 'dfe0', snapshot(), async (cpu) => {
          const numeric = preserveNumeric(cpu);
          const before = initial(0x1000n, {}, FLAGS, HISTORY);
          cpu.setState(before);
          const result = await cpu.run({ budget: 1n, repeatBudget: 11n });
          outcome(result, 'budget', 1n, 1n, 11n);
          same(
            result.state,
            {
              ...before,
              registers: before.registers.map((v, i) => (i === 0 ? (v & ~0xffffn) | 0x8081n : v)),
              flags: 0x3c7ed7n,
              rip: 0x1002n,
              interruptibility: { sti: false, ss: false },
            },
            'FNSTSW AX completes with live upper RAX and consumes incoming history',
          );
          equal(result.x87Exception, undefined, 'no-wait status observation');
          numeric();
        });
      },
    },
    {
      name: 'system numeric comparisons replace only defined arithmetic flags from live controls',
      async run() {
        for (const x87 of [false, true]) {
          await using(compiler, x87 ? 'dbf1' : '0f2fc1', snapshot(), async (cpu) => {
            preserveNumeric(cpu);
            const raw = cpu.readX87State();
            raw.controlWord = 0x37f;
            raw.statusWord = 0;
            raw.tagWord = 0xfff0;
            raw.registers[0] = 0x3fff8000000000000000n;
            raw.registers[1] = 0x40008000000000000000n;
            cpu.setX87State(raw);
            const xmm = cpu.readXmmState();
            xmm[0] = (xmm[0]! & ~0xffffffffn) | 0x3f800000n;
            xmm[1] = (xmm[1]! & ~0xffffffffn) | 0x40000000n;
            cpu.setXmmState(xmm);
            const before = initial(0x1000n, {}, 0x3c7ed7n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n, repeatBudget: 11n });
            outcome(result, 'budget', 1n, 1n, 11n);
            same(
              result.state,
              { ...before, flags: 0x3c7603n, rip: x87 ? 0x1002n : 0x1003n },
              '1<2 sets CF and clears PF/ZF/OF/SF/AF while preserving control bits and DF',
            );
            same(
              cpu.readX87State(),
              x87 ? { ...raw, instructionPointer: 0x1000n } : raw,
              'comparison has only its selected x87 environment effect',
            );
            same(cpu.readXmmState(), xmm, 'comparison preserves raw operands');
            equal(cpu.readMxcsr(), 0xffc5, 'comparison preserves existing MXCSR conditions');
            equal(result.x87Exception, undefined, 'no pending x87 detector');
            equal(result.simdException, undefined, 'exact normal compare has no SIMD exception');
          });
        }
      },
    },
    {
      name: 'system RF clears before a new unmasked SIMD exception and leaves pending x87 intact',
      async run() {
        await using(compiler, 'f30f5ec1', snapshot(), async (cpu) => {
          preserveNumeric(cpu);
          const raw = cpu.readX87State();
          const xmm = cpu.readXmmState();
          xmm[0] = 0n;
          xmm[1] = 0n;
          cpu.setXmmState(xmm);
          cpu.setMxcsr(0x1f00); // Invalid unmasked; 0/0 raises IE before writing a quotient.
          const before = initial(0x1000n, {}, FLAGS, HISTORY);
          cpu.setState(before);
          const result = await cpu.run({ budget: 3n, repeatBudget: 11n });
          outcome(result, 'simd-exception', 3n, 0n, 11n);
          same(
            result.state,
            { ...before, flags: 0x3c7ed7n },
            'new numeric fault begins and preserves unrelated scalar state',
          );
          same(cpu.readX87State(), raw, 'separate x87 pending state survives');
          same(cpu.readXmmState(), xmm, 'unmasked SIMD result not published');
          equal(cpu.readMxcsr(), 0x1f01, 'invalid sticky published');
          equal(result.simdException?.vector, 19, 'new SIMD vector');
          equal(result.simdException?.raised, 1, 'invalid condition');
          equal(result.simdException?.unmasked, 1, 'invalid condition unmasked');
          equal(result.simdException?.mxcsrBefore, 0x1f00, 'pre-operation MXCSR');
          equal(result.simdException?.mxcsrAfter, 0x1f01, 'post-condition MXCSR');
          equal(result.x87Exception, undefined, 'SSE does not observe pending x87');
          equal(result.debugException, undefined, 'no trap without completion');
        });
      },
    },
  ];
}
