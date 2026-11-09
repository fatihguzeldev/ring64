import {
  using,
  snapshot,
  initial,
  outcome,
  fullState,
  same,
  equal,
  image,
  encoded,
  gate,
  withGate,
  loadedCode,
  loadedData,
  CODE16,
  CODE32,
  DATA32,
  FILL,
  STACK,
  guarded,
  TSS,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function vmScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'software virtual8086 events save all nine slots and preserve raw facts while nulling data selectors',
      async run() {
        for (const width of [16, 32] as const)
          for (const [code, vector] of [
            ['cd40', 0x40],
            ['cc', 3],
            ['f1', 1],
            ['ce', 4],
          ] as const) {
            const execution = snapshot('virtual8086');
            for (const [index, name] of ['cs', 'ss', 'es', 'ds', 'fs', 'gs'].entries()) {
              const key = name as 'cs' | 'ss' | 'es' | 'ds' | 'fs' | 'gs';
              execution.segments[key].selector = (index + 1) * 0x1000;
              execution.segments[key].base = BigInt(index + 1) << 16n;
            }
            execution.tr = { ...TSS };
            const address = withGate(execution, vector);
            await using(
              compiler,
              code,
              execution,
              async (cpu) => {
                const numeric = preserveNumeric(cpu);
                const flags = 0x703n | (code === 'cd40' ? 0x3000n : code === 'ce' ? 0x800n : 0n);
                const before = initial(0x1000n, { 4: 0x11223344abcd7020n }, flags);
                cpu.setState(before);
                const entered = await cpu.run({ budget: 1n, repeatBudget: 23n });
                outcome(entered, 'budget', 1n, 1n, 23n);
                const final = 0x7080n - BigInt((9 * width) / 8);
                fullState(entered, before, 0x2000n, final, flags & ~0x300n);
                const segments = {
                  ...execution.segments,
                  cs: loadedCode(width),
                  ss: loadedData(32),
                };
                for (const name of ['es', 'ds', 'fs', 'gs'] as const)
                  segments[name] = { ...segments[name], selector: 0, usable: false };
                same(
                  cpu.readContext(),
                  { ...execution, mode: 'protected', cpl: 0, segments },
                  'implicit nulling retains raw hidden facts',
                );
                const next = 0x1000n + BigInt(code.length / 2);
                const writes: [bigint, Uint8Array][] = [
                  [
                    final,
                    image(
                      [
                        next,
                        0x1000n,
                        flags | 0x20000n,
                        before.registers[4]!,
                        0x2000n,
                        0x3000n,
                        0x4000n,
                        0x5000n,
                        0x6000n,
                      ],
                      width / 8,
                    ),
                  ],
                ];
                guarded(cpu, STACK, FILL, writes);
                if (width === 32) {
                  const returned = await cpu.run({ budget: 1n, repeatBudget: 23n, stop: next });
                  outcome(returned, 'budget', 1n, 1n, 23n);
                  fullState(returned, before, next, 0xabcd7020n, flags);
                  same(
                    cpu.readContext(),
                    execution,
                    'IRETD restores complete fixed V86 caches and context-owned VM',
                  );
                  guarded(cpu, STACK, FILL, writes);
                }
                numeric();
              },
              {
                codeBase: 0x11000n,
                data: [
                  { base: 0x4008n, bytes: (width === 16 ? CODE16 : CODE32) + DATA32 },
                  { base: address, bytes: gate(width, 8, 0x2000n), write: false },
                  { base: 0x5004n, bytes: encoded(image([0x7080n], 4)) + '1000', write: false },
                  { base: 0x2000n, bytes: 'cf', execute: true },
                  { base: STACK, bytes: FILL },
                ],
              },
            );
          }
      },
    },
    {
      name: 'software IRETD to virtual8086 restores RF and every fixed cache without protected descriptors',
      async run() {
        const execution = snapshot('protected');
        const values = [
          0x1234n,
          0x1000n,
          0x3f7fd7n,
          0xabcd7020n,
          0x2000n,
          0x3000n,
          0x4000n,
          0x5000n,
          0x6000n,
        ];
        await using(
          compiler,
          'cf',
          execution,
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            const before = initial(0x1000n, { 4: 0x7000n }, 2n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n, stop: 0x1234n });
            outcome(result, 'budget', 1n, 1n);
            fullState(result, before, 0x1234n, 0xabcd7020n, 0x3d7fd7n);
            const expected = snapshot('virtual8086');
            expected.gdtr = execution.gdtr;
            expected.idtr = execution.idtr;
            expected.ldtr = execution.ldtr;
            expected.tr = execution.tr;
            for (const [index, name] of ['cs', 'ss', 'es', 'ds', 'fs', 'gs'].entries()) {
              const key = name as 'cs' | 'ss' | 'es' | 'ds' | 'fs' | 'gs';
              expected.segments[key].selector = (index + 1) * 0x1000;
              expected.segments[key].base = BigInt(index + 1) << 16n;
            }
            same(cpu.readContext(), expected, 'all V86 caches are fixed and VM has one authority');
            const saved = cpu.readContext();
            cpu.setContext(saved);
            same(cpu.readContext(), expected, 'produced context roundtrips');
            same(
              cpu.readMemory(0x7000n, 36),
              image(values, 4),
              'return does not rewrite source frame',
            );
            equal(result.debugException, undefined, 'new TF does not step return');
            numeric();
          },
          { data: [{ base: 0x7000n, bytes: encoded(image(values, 4)), write: false }] },
        );
      },
    },
  ];
}
