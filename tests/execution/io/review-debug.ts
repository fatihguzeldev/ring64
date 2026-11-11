import { createCpu } from '../../../host/index.js';
import { LIMITS, check, equal, hex, initial, type Scenario } from '../../support/fixture.js';
import { snapshot, same } from '../far-control/fixture.js';

export function ioDebugReviewScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'scalar port activity is neither an operand memory hit nor a newly implemented IO breakpoint',
      async run() {
        for (const dr7 of [0x20401n, 0x30401n]) {
          let calls = 0;
          const cpu = await createCpu({
            compiler,
            limits: LIMITS,
            code: { base: 0x1000n, bytes: hex('ecee') },
            ram: { base: 0x4000n, bytes: new Uint8Array(1) },
            io: {
              read() {
                calls++;
                return 0xab;
              },
              write(port, width, value) {
                equal(port, 0x80, 'port');
                equal(width, 8, 'byte output');
                equal(value, 0xab, 'input then output');
                calls++;
              },
            },
          });
          try {
            cpu.setDebugState({ addresses: [0x80n, 0n, 0n, 0n], dr6: 0n, dr7 });
            cpu.setState(initial(0x1000n, { 2: 0x80n }));
            const result = await cpu.run({ budget: 2n });
            equal(result.reason, 'budget', 'no invented port/memory watchpoint producer');
            equal(result.retired, 2n, 'both transactions complete');
            equal(calls, 2, 'full callbacks');
            equal(cpu.readDebugState().dr6 & 15n, 0n, 'no port Bn');
            equal(cpu.readDebugState().dr7, dr7, 'configuration remains readable');
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'REP input completes one effect before an unfinished TF trap and RF suppresses the execute breakpoint',
      async run() {
        const values = [0x11, 0x22];
        let calls = 0;
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          code: { base: 0x1000n, bytes: hex('f36c') },
          ram: { base: 0x4000n, bytes: new Uint8Array(2).fill(0xa5) },
          io: {
            read() {
              return values[calls++]!;
            },
            write() {},
          },
        });
        try {
          cpu.setDebugState({ addresses: [0x1000n, 0n, 0n, 0n], dr6: 0n, dr7: 0x401n });
          cpu.setState(initial(0x1000n, { 1: 2n, 2: 0x80n, 7: 0x4000n }, 0x10102n));
          const first = await cpu.run({ budget: 1n, repeatBudget: 2n });
          equal(first.reason, 'debug-exception', 'TF after completed element');
          equal(first.debugException?.cause, 'single-step', 'RF suppresses execute Bn');
          equal(first.debugException?.instructionCompleted, false, 'unfinished REP trap');
          equal(first.debugException?.resumePc, 0x1000n, 'resume at remaining REP');
          equal(first.state.flags, 0x102n, 'begin RF cleared');
          equal(first.retired, 0n, 'instruction unfinished');
          equal(first.repeatIterations, 1n, 'completed work recorded');
          equal(calls, 1, 'one external input before trap');
          equal(first.state.registers[1], 1n, 'count decremented once');
          equal(first.state.registers[7], 0x4001n, 'index advances once');
          same(Array.from(cpu.readMemory(0x4000n, 2)), [0x11, 0xa5], 'only first payload');
          equal(cpu.readDebugState().dr6 & 15n, 0n, 'no execution hit');
          cpu.setDebugState({ ...cpu.readDebugState(), dr7: 0x400n });
          cpu.setState({ ...first.state, flags: 2n });
          const last = await cpu.run({ budget: 1n, repeatBudget: 1n });
          equal(last.retired, 1n, 'remainder completes');
          equal(calls, 2, 'prior input never repeats');
          same(Array.from(cpu.readMemory(0x4000n, 2)), [0x11, 0x22], 'remaining payload');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'OUTS output precedes its operand-data trap and resumption never repeats completed output',
      async run() {
        const values: number[] = [];
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          code: { base: 0x1000n, bytes: hex('f36f') },
          ram: { base: 0x4000n, bytes: hex('78563412efbeadde') },
          io: {
            read() {
              throw Error('no input');
            },
            write(_port, width, value) {
              equal(width, 32, 'dword source');
              values.push(value);
            },
          },
        });
        try {
          cpu.setDebugState({ addresses: [0x4000n, 0n, 0n, 0n], dr6: 0n, dr7: 0xf0401n });
          cpu.setState(initial(0x1000n, { 1: 2n, 2: 0x80n, 6: 0x4000n }));
          const first = await cpu.run({ budget: 1n, repeatBudget: 2n });
          equal(first.reason, 'debug-exception', 'read hit traps after output');
          equal(first.debugException?.instructionCompleted, false, 'partial REP');
          equal(first.debugException?.breakpoints, 1, 'actual source read only');
          same(values, [0x12345678], 'first output externally committed');
          equal(first.state.registers[6], 0x4004n, 'committed source index');
          equal(first.state.registers[1], 1n, 'remaining count');
          equal(first.repeatIterations, 1n, 'completed output work');
          equal(first.retired, 0n, 'REP unfinished');
          cpu.setDebugState({ ...cpu.readDebugState(), dr7: 0x400n });
          const last = await cpu.run({ budget: 1n, repeatBudget: 1n });
          equal(last.retired, 1n, 'complete remaining output');
          same(values, [0x12345678, 0xdeadbeef], 'no first output replay');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'I/O diagnostic clearing preserves durable SS-deferred causes and merges the committed INS write',
      async run() {
        const context = snapshot('protected');
        context.gdtr = { base: 0x6000n, limit: 0x17 };
        const ram = new Uint8Array(0x3000).fill(0xa5);
        ram.set(hex('1000'));
        ram.set(hex('ffff00000093cf00'), 0x2010);
        let calls = 0;
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          context,
          code: { base: 0x1000n, bytes: hex('8e106c') },
          ram: { base: 0x4000n, bytes: ram },
          io: {
            read() {
              calls++;
              return 0xaa;
            },
            write() {},
          },
        });
        try {
          cpu.setDebugState({ addresses: [0x4000n, 0x5000n, 0n, 0n], dr6: 0n, dr7: 0x170405n });
          cpu.setState(initial(0x1000n, { 0: 0x4000n, 2: 0x80n, 7: 0x5000n }));
          const producer = await cpu.run({ budget: 1n });
          equal(producer.reason, 'budget', 'MOV SS defers its read hit');
          equal(producer.retired, 1n, 'SS producer completed');
          equal(producer.state.interruptibility.ss, true, 'SS history retained');
          check(producer.state.debugContinuation, 'durable continuation');
          equal(producer.state.debugContinuation.breakpoints, 1, 'source read captured');
          equal(calls, 0, 'no speculative input');
          const successor = await cpu.run({ budget: 1n, repeatBudget: 0n });
          equal(
            successor.reason,
            'debug-exception',
            'bare input successor selects deferred/current trap',
          );
          equal(successor.retired, 1n, 'input instruction completed');
          equal(successor.debugException?.instructionCompleted, true, 'completed successor');
          equal(successor.debugException?.breakpoints, 3, 'old read + committed destination write');
          equal(successor.debugException?.deferredOriginPc, 0x1000n, 'original source retained');
          equal(successor.state.rip, 0x1003n, 'bare input successor PC');
          equal(calls, 1, 'one input');
          equal(successor.repeatIterations, 0n, 'bare work uncharged');
          equal(cpu.readMemory(0x5000n, 1)[0], 0xaa, 'input committed before trap');
          equal(
            successor.state.debugContinuation,
            undefined,
            'selected durable cause consumed once',
          );
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
