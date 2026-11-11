import { createCpu, type IoProvider } from '../../../host/index.js';
import { LIMITS, equal, hex, initial, memory, type Scenario } from '../../support/fixture.js';
import { profiles } from '../far-control/fixture.js';

export function stringIoScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'bare and REP port strings obey every imported profile, width and direction',
      async run() {
        for (const context of profiles())
          for (const width of [8, 16, 32] as const)
            for (const input of [false, true])
              for (const repeated of [false, true])
                for (const descending of [false, true]) {
                  const size = width / 8;
                  const default32 = context.mode === 'long64' || context.segments.cs.default32;
                  const prefix = width !== 8 && (width === 32) !== default32 ? '66' : '';
                  const code = `${prefix}${repeated ? 'f3' : ''}${input ? (width === 8 ? '6c' : '6d') : width === 8 ? '6e' : '6f'}`;
                  const ram = new Uint8Array(0x3000);
                  ram[0x2066] = 0x80;
                  const value = width === 8 ? 0x7b : width === 16 ? 0xbeef : 0x89abcdef;
                  const little = Array.from({ length: size }, (_, i) => (value >>> (8 * i)) & 255);
                  for (let p = 0; p < 16; p++) ram.set(little, p * size);
                  context.tr = {
                    selector: 0x28,
                    valid: true,
                    base: 0x6000n,
                    limit: 0x100,
                    attributes: 0x8b,
                  };
                  let calls = 0;
                  const io: IoProvider = {
                    read(port, bits) {
                      equal(port, 0x80, 'DX low16');
                      equal(bits, width, 'input width');
                      calls++;
                      return value;
                    },
                    write(port, bits, actual) {
                      equal(port, 0x80, 'DX low16');
                      equal(bits, width, 'output width');
                      equal(actual, value, 'full-width source');
                      calls++;
                    },
                  };
                  const cpu = await createCpu({
                    compiler,
                    limits: LIMITS,
                    context,
                    io,
                    code: { base: 0x1000n, bytes: hex(code) },
                    ram: { base: 0x4000n, bytes: ram },
                  });
                  try {
                    const count = repeated ? 2 : 1;
                    const start = descending ? 8 : 0;
                    const before = initial(
                      0x1000n,
                      {
                        1: repeated ? 2n : 0n,
                        2: 0xffff000000000080n,
                        6: 0x4000n + BigInt(start),
                        7: 0x5000n + BigInt(start),
                      },
                      descending ? 0x402n : 2n,
                    );
                    cpu.setState(before);
                    const result = await cpu.run({ budget: 1n, repeatBudget: repeated ? 2n : 0n });
                    equal(
                      result.reason,
                      'budget',
                      `${context.mode}/${width}/${input}/${repeated}/${descending}`,
                    );
                    equal(result.retired, 1n, 'one string retirement');
                    equal(
                      result.repeatIterations,
                      repeated ? 2n : 0n,
                      'bare strings do not charge repeats',
                    );
                    equal(calls, count, 'one callback per successful element');
                    equal(result.state.flags, before.flags, 'ordinary flags preserved');
                    equal(result.state.registers[1], 0n, 'selected count');
                    const index = input ? 7 : 6;
                    equal(
                      result.state.registers[index],
                      before.registers[index]! + BigInt(count * size * (descending ? -1 : 1)),
                      'selected index progression',
                    );
                    equal(
                      result.state.registers[input ? 6 : 7],
                      before.registers[input ? 6 : 7],
                      'other index untouched',
                    );
                    equal(
                      result.state.registers[0],
                      before.registers[0],
                      'strings preserve accumulator',
                    );
                    if (input)
                      for (let n = 0; n < count; n++)
                        memory(
                          cpu,
                          before.registers[7]! + BigInt(n * size * (descending ? -1 : 1)),
                          little.map((x) => x.toString(16).padStart(2, '0')).join(''),
                        );
                  } finally {
                    cpu.dispose();
                  }
                }
      },
    },
    {
      name: 'faulting INS consumes input without committing failed progress and repair reads fresh input',
      async run() {
        const values = [0x11, 0x22, 0x33, 0x44];
        let consumed = 0;
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          code: { base: 0x1000n, bytes: hex('f36c') },
          ram: { base: 0x4ffen, bytes: new Uint8Array(2) },
          memoryLimits: { maxBackingBytes: 1024, maxBackings: 3, maxMappings: 3 },
          io: {
            read() {
              return values[consumed++]!;
            },
            write() {},
          },
        });
        try {
          cpu.setState(initial(0x1000n, { 1: 3n, 2: 0x80n, 7: 0x4ffen }));
          const first = await cpu.run({ budget: 1n, repeatBudget: 3n });
          equal(first.reason, 'data-fault', 'late destination refusal');
          equal(consumed, 3, 'third input consumed');
          equal(first.state.registers[7], 0x5000n, 'failed index unchanged');
          equal(first.state.registers[1], 1n, 'failed count unchanged');
          equal(first.retired, 0n, 'partial REP not retired');
          equal(first.repeatIterations, 2n, 'only completed elements charged');
          equal(first.remainingRepeatBudget, 1n, 'failed input has no repeat charge');
          equal(first.fault?.address, 0x5000n, 'exact failed destination');
          memory(cpu, 0x4ffen, '1122');
          cpu.addBacking({ id: 'repair', bytes: new Uint8Array(1) });
          cpu.setMappings([
            {
              base: 0x1000n,
              backing: 'code',
              offset: 0,
              length: 2,
              permissions: { read: true, write: false, execute: true },
            },
            {
              base: 0x4ffen,
              backing: 'ram',
              offset: 0,
              length: 2,
              permissions: { read: true, write: true, execute: false },
            },
            {
              base: 0x5000n,
              backing: 'repair',
              offset: 0,
              length: 1,
              permissions: { read: true, write: true, execute: false },
            },
          ]);
          const last = await cpu.run({ budget: 1n, repeatBudget: 1n });
          equal(last.reason, 'budget', 'repaired completion');
          equal(consumed, 4, 'repair consumes fresh fourth input');
          equal(last.state.rip, 0x1002n, 'completed REP');
          equal(last.state.registers[1], 0n, 'remaining count completed');
          equal(last.repeatIterations, 1n, 'only repaired element charged');
          memory(cpu, 0x5000n, '44');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'zero-count and exhausted-repeat I/O frontiers have no permission or provider effects',
      async run() {
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          code: { base: 0x1000n, bytes: hex('67f36c') },
          ram: { base: 0x4000n, bytes: new Uint8Array(1) },
        });
        try {
          cpu.setState(initial(0x1000n, { 1: 0x1122334400000000n, 7: 0x800000000000n }, 0x10002n));
          const zero = await cpu.run({ budget: 1n, repeatBudget: 0n });
          equal(zero.reason, 'budget', 'zero count completes without provider');
          equal(zero.state.registers[1], 0x1122334400000000n, 'zero count preserves raw bank');
          equal(zero.state.registers[7], 0x800000000000n, 'zero count avoids geometry');
          equal(zero.state.flags, 2n, 'zero completion clears RF');
          cpu.setState(initial(0x1000n, { 1: 1n, 7: 0x800000000000n }, 0x10002n));
          const stalled = await cpu.run({ budget: 1n, repeatBudget: 0n });
          equal(stalled.reason, 'repeat-budget', 'positive zero-allowance yield');
          equal(stalled.state.flags, 0x10002n, 'no-work preserves RF');
          equal(stalled.retired, 0n, 'no work');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
