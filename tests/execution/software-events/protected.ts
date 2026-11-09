import {
  using,
  snapshot,
  initial,
  outcome,
  fullState,
  same,
  image,
  encoded,
  gate,
  withGate,
  loadedCode,
  loadedData,
  CODE16,
  CODE32,
  DATA16,
  DATA32,
  FILL,
  STACK,
  guarded,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function protectedScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'software protected gate width controls same-CPL frames independently of caller code and stack widths',
      async run() {
        for (const width of [16, 32] as const)
          for (const code32 of [false, true])
            for (const stack32 of [false, true])
              for (const trap of [false, true]) {
                const execution = snapshot('protected', 0, code32, stack32);
                execution.segments.cs.selector = 0x18;
                const address = withGate(execution);
                await using(
                  compiler,
                  'cd4090',
                  execution,
                  async (cpu) => {
                    const numeric = preserveNumeric(cpu);
                    const sp = stack32 ? 0x1122334400007020n : 0x11223344abcd7020n;
                    const before = initial(0x1000n, { 4: sp }, 0x603n);
                    cpu.setState(before);
                    const entered = await cpu.run({ budget: 1n, repeatBudget: 7n });
                    outcome(entered, 'budget', 1n, 1n, 7n);
                    fullState(
                      entered,
                      before,
                      0x2000n,
                      sp - BigInt((3 * width) / 8),
                      trap ? 0x603n : 0x403n,
                    );
                    same(
                      cpu.readContext(),
                      {
                        ...execution,
                        segments: { ...execution.segments, cs: loadedCode(width) },
                      },
                      'same-CPL loaded code and retained raw SS',
                    );
                    const frame = image([0x1002n, 0x18n, 0x603n], width / 8);
                    const writes: [bigint, Uint8Array][] = [
                      [0x7020n - BigInt(frame.length), frame],
                    ];
                    guarded(cpu, STACK, FILL, writes);
                    const returned = await cpu.run({ budget: 1n, repeatBudget: 7n, stop: 0x1002n });
                    outcome(returned, 'budget', 1n, 1n, 7n);
                    fullState(returned, before, 0x1002n, sp, 0x603n);
                    same(
                      cpu.readContext(),
                      {
                        ...execution,
                        segments: { ...execution.segments, cs: loadedCode(code32 ? 32 : 16, 0x18) },
                      },
                      'returned code cache is reloaded rather than guessed from caller',
                    );
                    guarded(cpu, STACK, FILL, writes);
                    numeric();
                  },
                  {
                    data: [
                      { base: 0x4008n, bytes: width === 16 ? CODE16 : CODE32 },
                      { base: 0x4018n, bytes: code32 ? CODE32 : CODE16 },
                      { base: address, bytes: gate(width, 8, 0x2000n, 0, trap), write: false },
                      { base: 0x2000n, bytes: 'cf', execute: true },
                      { base: STACK, bytes: FILL },
                    ],
                  },
                );
              }
      },
    },
    {
      name: 'software inner protected entry consumes live16 or32-bit TSS fields and outer IRET restores popped raw SP',
      async run() {
        for (const width of [16, 32] as const)
          for (const task16 of [false, true])
            for (const oldStack32 of [false, true])
              for (const newStack32 of [false, true]) {
                const execution = snapshot('protected', 3, true, oldStack32);
                execution.segments.cs.selector = 0x1b;
                execution.segments.ss.selector = 0x23;
                execution.tr = {
                  selector: 0x28,
                  valid: true,
                  base: 0x5000n,
                  limit: 0x67,
                  attributes: task16 ? 0x83 : 0x8b,
                };
                const address = withGate(execution);
                const field = task16 ? 0x5002n : 0x5004n;
                const fields = encoded(image([0x7080n], task16 ? 2 : 4)) + '1000';
                await using(
                  compiler,
                  'cd4090',
                  execution,
                  async (cpu) => {
                    const numeric = preserveNumeric(cpu);
                    const sp = oldStack32 ? 0x1122334400007020n : 0x11223344abcd7020n;
                    const before = initial(0x1000n, { 4: sp }, 0x603n);
                    cpu.setState(before);
                    const entered = await cpu.run({ budget: 1n, repeatBudget: 17n });
                    outcome(entered, 'budget', 1n, 1n, 17n);
                    const final = 0x7080n - BigInt((5 * width) / 8);
                    fullState(entered, before, 0x2000n, final, 0x403n);
                    same(
                      cpu.readContext(),
                      {
                        ...execution,
                        cpl: 0,
                        segments: {
                          ...execution.segments,
                          cs: loadedCode(width),
                          ss: loadedData(newStack32 ? 32 : 16),
                        },
                      },
                      'complete inner loaded context',
                    );
                    const writes: [bigint, Uint8Array][] = [
                      [final, image([0x1002n, 0x1bn, 0x603n, sp, 0x23n], width / 8)],
                    ];
                    guarded(cpu, STACK, FILL, writes);
                    const returned = await cpu.run({
                      budget: 1n,
                      repeatBudget: 17n,
                      stop: 0x1002n,
                    });
                    outcome(returned, 'budget', 1n, 1n, 17n);
                    const poppedSp = sp & (width === 16 ? 0xffffn : 0xffffffffn);
                    fullState(returned, before, 0x1002n, poppedSp, 0x603n);
                    const returnedContext = {
                      ...execution,
                      segments: {
                        ...execution.segments,
                        cs: loadedCode(32, 0x1b, 3),
                        ss: loadedData(oldStack32 ? 32 : 16, 0x23, 3),
                      },
                    };
                    same(cpu.readContext(), returnedContext, 'outer IRET cache/CPL publication');
                    guarded(cpu, STACK, FILL, writes);
                    // TSS body is live; its unselected fields and descriptor need no mapping.
                    cpu.writeMemory(field, image([0x7040n], task16 ? 2 : 4));
                    cpu.setState({ ...returned.state, rip: 0x1000n });
                    const again = await cpu.run({ budget: 1n });
                    outcome(again, 'budget', 1n, 1n);
                    const newFinal = 0x7040n - BigInt((5 * width) / 8);
                    fullState(
                      again,
                      { ...returned.state, rip: 0x1000n },
                      0x2000n,
                      newFinal,
                      0x403n,
                    );
                    guarded(cpu, STACK, FILL, [
                      ...writes,
                      [newFinal, image([0x1002n, 0x1bn, 0x603n, poppedSp, 0x23n], width / 8)],
                    ]);
                    same(cpu.readContext().tr, execution.tr, 'body edits do not reload TR');
                    numeric();
                  },
                  {
                    data: [
                      {
                        base: 0x4008n,
                        bytes:
                          (width === 16 ? CODE16 : CODE32) +
                          (newStack32 ? DATA32 : DATA16) +
                          'ffff000000fbcf00' +
                          (oldStack32 ? 'ffff000000f3cf00' : 'ffff000000f30000'),
                      },
                      { base: address, bytes: gate(width), write: false },
                      { base: field, bytes: fields },
                      { base: 0x2000n, bytes: 'cf', execute: true },
                      { base: STACK, bytes: FILL },
                    ],
                  },
                );
              }
      },
    },
  ];
}
