import type { ExecutionContextSnapshot } from '../../../host/index.js';
import {
  CODE32,
  CODE64,
  bytes,
  changed,
  completion,
  hex,
  initial,
  loadedCode,
  loadedData,
  operandPrefix,
  preserveNumeric,
  profiles,
  same,
  snapshot,
  state,
  using,
  type Scenario,
} from './fixture.js';

const CPLS: readonly [number, number][] = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
];
function codeDescriptor(width: 16 | 32 | 64, cpl: number): string {
  return (
    'ffff000000' +
    ['9b', 'bb', 'db', 'fb'][cpl] +
    (width === 64 ? 'af' : width === 32 ? 'cf' : '00') +
    '00'
  );
}
function stackDescriptor(width: 16 | 32, cpl: number): string {
  return 'ffff007000' + ['93', 'b3', 'd3', 'f3'][cpl] + (width === 32 ? 'cf' : '00') + '00';
}

export function returnScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'far CA ffff cleanup is unsigned for same CPL arithmetic and outer skipped geometry',
      async run() {
        for (const outer of [false, true]) {
          const execution = snapshot(),
            head = outer ? '002000001b000000' : '0020000010000000';
          await using(
            compiler,
            'caffff',
            execution,
            async (cpu) => {
              const before = initial(0x1000n, { 4: 0x6020n }, 0xcd7n),
                numeric = preserveNumeric(cpu);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              completion(result);
              state(result.state, changed(before, 0x2000n, { 4: outer ? 0x14fffn : 0x16027n }));
              const expected = structuredClone(execution);
              expected.segments.cs = loadedCode(64, outer ? 27 : 16, outer ? 3 : 0);
              if (outer) {
                expected.cpl = 3;
                expected.segments.ss = loadedData(32, 35, 3, 0x7000n);
                for (const name of ['es', 'ds', 'fs', 'gs'] as const) {
                  expected.segments[name].selector = 0;
                  expected.segments[name].usable = false;
                }
                same(
                  cpu.readMemory(0x16027n, 8),
                  hex('0050000023000000'),
                  'outer restored slots beyond unmapped unsigned gap',
                );
              }
              same(cpu.readContext(), expected, 'unsigned cleanup transition');
              numeric();
            },
            {
              data: [
                {
                  base: outer ? 0x4018n : 0x4010n,
                  bytes: outer ? codeDescriptor(64, 3) + stackDescriptor(32, 3) : CODE64,
                  write: false,
                },
                { base: 0x6020n, bytes: head, write: false },
                ...(outer ? [{ base: 0x16027n, bytes: '0050000023000000', write: false }] : []),
              ],
            },
          );
        }
      },
    },
    {
      name: 'far outer RETF covers source and target modes all privilege increases and narrow restored stack cleanup',
      async run() {
        for (const original of profiles().filter(
          (p) => p.mode !== 'real' && p.mode !== 'virtual8086',
        ))
          for (const width of original.mode === 'long64' ? [16, 32, 64] : [16, 32])
            for (const [oldCpl, newCpl] of CPLS)
              for (const targetWidth of original.mode === 'protected'
                ? ([16, 32] as const)
                : ([16, 32, 64] as const))
                for (const stackWidth of [16, 32] as const) {
                  const execution = snapshot(
                    original.mode,
                    oldCpl,
                    original.segments.cs.default32,
                    original.segments.ss.default32,
                  );
                  const targetMode: ExecutionContextSnapshot['mode'] =
                    execution.mode === 'protected'
                      ? 'protected'
                      : targetWidth === 64
                        ? 'long64'
                        : 'compatibility';
                  const code = operandPrefix(execution, width) + 'ca0300',
                    w = width / 8;
                  const cs = 24 | newCpl,
                    ss = 32 | newCpl;
                  const padding = (1n << BigInt(width)) - 1n;
                  const head = bytes(0x2000n, w) + bytes((padding & ~0xffffn) | BigInt(cs), w);
                  const restored =
                    width === 16 ? 0xfffen : width === 32 ? 0x89abfffen : 0x1234567889abfffen;
                  const tail = bytes(restored, w) + bytes((padding & ~0xffffn) | BigInt(ss), w);
                  const label = `${execution.mode}/${original.segments.cs.default32}/${original.segments.ss.default32} W${width} CPL${oldCpl}->${newCpl} code${targetWidth} SS${stackWidth}`;
                  try {
                    await using(
                      compiler,
                      code,
                      execution,
                      async (cpu) => {
                        const before = initial(
                            0x1000n,
                            { 4: execution.mode === 'long64' ? 0x6020n : 0x1122334400006020n },
                            0xcd7n,
                          ),
                          numeric = preserveNumeric(cpu);
                        cpu.setState(before);
                        const result = await cpu.run({ budget: 1n, repeatBudget: 13n });
                        completion(result, 1n, 1n, 13n);
                        const size = targetMode === 'long64' ? 64 : stackWidth,
                          mask = (1n << BigInt(size)) - 1n;
                        const nextSP = (restored & ~mask) | ((restored + 3n) & mask);
                        state(result.state, changed(before, 0x2000n, { 4: nextSP }));
                        const expected = structuredClone(execution);
                        expected.mode = targetMode;
                        expected.cpl = newCpl;
                        expected.segments.cs = loadedCode(targetWidth, cs, newCpl);
                        expected.segments.ss = loadedData(stackWidth, ss, newCpl, 0x7000n);
                        for (const name of ['es', 'ds', 'fs', 'gs'] as const) {
                          expected.segments[name].selector = 0;
                          expected.segments[name].usable = false;
                        }
                        same(
                          cpu.readContext(),
                          expected,
                          'outer transition and cached data cleanup',
                        );
                        cpu.setContext(cpu.readContext());
                        same(cpu.readContext(), expected, 'complete produced snapshot roundtrip');
                        same(
                          cpu.readMemory(0x6020n, head.length / 2),
                          hex(head),
                          'return IP/CS slots unchanged',
                        );
                        same(
                          cpu.readMemory(0x6020n + BigInt(2 * w + 3), tail.length / 2),
                          hex(tail),
                          'saved SP/SS slots unchanged',
                        );
                        numeric();
                      },
                      {
                        data: [
                          {
                            base: 0x4018n,
                            bytes:
                              codeDescriptor(targetWidth, newCpl) +
                              stackDescriptor(stackWidth, newCpl),
                            write: false,
                          },
                          { base: 0x6020n, bytes: head, write: false },
                          { base: 0x6020n + BigInt(2 * w + 3), bytes: tail, write: false },
                        ],
                      },
                    );
                  } catch (error) {
                    throw new Error(label, { cause: error });
                  }
                }
      },
    },
    {
      name: 'far same CPL RETCA uses old stack width across submode handoff without reading cleanup bytes',
      async run() {
        const cases = [
          {
            execution: snapshot(),
            width: 64,
            oldSP: 0x1ffedn,
            targetWidth: 32 as const,
            expectedSP: 0x20000n,
          },
          {
            execution: snapshot('compatibility', 0, true, false),
            width: 32,
            oldSP: 0x112233440000fff5n,
            targetWidth: 64 as const,
            expectedSP: 0x1122334400000000n,
          },
          {
            execution: snapshot('compatibility', 0, false, true),
            width: 16,
            oldSP: 0x11223344fffffff9n,
            targetWidth: 64 as const,
            expectedSP: 0x1122334400000000n,
          },
        ];
        cases[0]!.execution.segments.ss.default32 = false;
        for (const { execution, width, oldSP, targetWidth, expectedSP } of cases) {
          const code = operandPrefix(execution, width) + 'ca0300',
            w = width / 8;
          const oldMask =
            (1n <<
              BigInt(
                execution.mode === 'long64' ? 64 : execution.segments.ss.default32 ? 32 : 16,
              )) -
            1n;
          const base = oldSP & oldMask,
            frame = bytes(0x2000n, w) + bytes(16n, w);
          await using(
            compiler,
            code,
            execution,
            async (cpu) => {
              const before = initial(0x1000n, { 4: oldSP }, 0xcd7n),
                numeric = preserveNumeric(cpu);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              completion(result);
              state(result.state, changed(before, 0x2000n, { 4: expectedSP }));
              const expected = structuredClone(execution);
              expected.mode = targetWidth === 64 ? 'long64' : 'compatibility';
              expected.segments.cs = loadedCode(targetWidth, 16);
              same(
                cpu.readContext(),
                expected,
                'same CPL handoff leaves SS and data caches intact',
              );
              same(
                cpu.readMemory(base, frame.length / 2),
                hex(frame),
                'only two frame slots were read',
              );
              numeric();
            },
            {
              data: [
                { base: 0x4010n, bytes: targetWidth === 64 ? CODE64 : CODE32, write: false },
                { base, bytes: frame, write: false },
              ],
            },
          );
        }
      },
    },
    {
      name: 'far real and virtual8086 RETF ignore selector RPL and preserve unreal CS facts with only two slots',
      async run() {
        for (const execution of profiles().filter(
          (p) => p.mode === 'real' || p.mode === 'virtual8086',
        ))
          for (const width of [16, 32])
            for (const selector of [3, 0x31])
              for (const offset of execution.mode === 'real' && width === 32
                ? [0x2000n, 0x12345678n]
                : [0x2000n]) {
                const code = operandPrefix(execution, width) + 'cb',
                  frame = bytes(offset, width / 8) + bytes(BigInt(selector), width / 8);
                await using(
                  compiler,
                  code,
                  execution,
                  async (cpu) => {
                    const before = initial(0x1000n, { 4: 0x1122334400006020n }, 0xcd7n),
                      numeric = preserveNumeric(cpu);
                    cpu.setState(before);
                    const result = await cpu.run({ budget: 1n });
                    completion(result);
                    state(
                      result.state,
                      changed(before, offset, { 4: before.registers[4]! + BigInt(width / 4) }),
                    );
                    const expected = structuredClone(execution);
                    expected.segments.cs.selector = selector;
                    expected.segments.cs.base = BigInt(selector) << 4n;
                    same(
                      cpu.readContext(),
                      expected,
                      'plain real selector and retained attributes',
                    );
                    cpu.setContext(cpu.readContext());
                    same(cpu.readContext(), expected, 'real/V86 snapshot remains valid');
                    numeric();
                  },
                  { data: [{ base: 0x6020n, bytes: frame, write: false }] },
                );
              }
      },
    },
    {
      name: 'far null outer SS preserves hidden cache but marks unusable for complete checkpoint roundtrip',
      async run() {
        for (const newCpl of [1, 2])
          for (const width of [16, 32, 64]) {
            const execution = snapshot();
            execution.segments.ss = {
              ...execution.segments.ss,
              selector: 16,
              base: 0x1234567800007000n,
              limit: 0x12345678,
              default32: false,
              type: 'read-only',
              usable: true,
              available: true,
            };
            const code = operandPrefix(execution, width) + 'cb',
              w = width / 8,
              selector = 24 | newCpl;
            const restored =
              width === 16 ? 0x5000n : width === 32 ? 0x12345000n : 0x123456789abc5000n;
            const frame =
              bytes(0x2000n, w) +
              bytes(BigInt(selector), w) +
              bytes(restored, w) +
              bytes(BigInt(newCpl), w);
            await using(
              compiler,
              code,
              execution,
              async (cpu) => {
                const before = initial(0x1000n, { 4: 0x6020n }, 0xcd7n),
                  numeric = preserveNumeric(cpu);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                completion(result);
                state(result.state, changed(before, 0x2000n, { 4: restored }));
                const expected = structuredClone(execution);
                expected.cpl = newCpl;
                expected.segments.cs = loadedCode(64, selector, newCpl);
                expected.segments.ss.selector = newCpl;
                expected.segments.ss.usable = false;
                for (const name of ['es', 'ds', 'fs', 'gs'] as const) {
                  expected.segments[name].selector = 0;
                  expected.segments[name].usable = false;
                }
                same(
                  cpu.readContext(),
                  expected,
                  'null SS skips descriptor and preserves raw cache',
                );
                cpu.setContext(cpu.readContext());
                same(cpu.readContext(), expected, 'null returned SS roundtrip');
                numeric();
              },
              {
                data: [
                  { base: 0x4018n, bytes: codeDescriptor(64, newCpl), write: false },
                  { base: 0x6020n, bytes: frame, write: false },
                ],
              },
            );
          }
      },
    },
    {
      name: 'far outer cleanup uses old loaded facts including null selectors raw data flags and preserved FS GS bases',
      async run() {
        const execution = snapshot();
        execution.segments.es.selector = 0;
        execution.segments.es.usable = true;
        execution.segments.ds = {
          ...execution.segments.ds,
          selector: 0,
          usable: false,
          type: 'readable-code',
        };
        execution.segments.fs = {
          ...execution.segments.fs,
          selector: 16,
          type: 'readable-code',
          conforming: true,
          base: 0xffff800000004000n,
        };
        execution.segments.gs = {
          ...execution.segments.gs,
          type: 'expand-down-read-only',
          conforming: true,
          base: 0xffff800000005000n,
          limit: 0x1234,
        };
        const frame = '00200000000000001b0000000000000000500000000000002300000000000000';
        await using(
          compiler,
          '48cb',
          execution,
          async (cpu) => {
            const before = initial(0x1000n, { 3: 0x20n, 4: 0x6020n }, 0xcd7n),
              numeric = preserveNumeric(cpu);
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            completion(result);
            state(result.state, changed(before, 0x2000n, { 4: 0x5000n }));
            const expected = structuredClone(execution);
            expected.cpl = 3;
            expected.segments.cs = loadedCode(64, 27, 3);
            expected.segments.ss = loadedData(32, 35, 3, 0x7000n);
            for (const name of ['es', 'ds', 'gs'] as const) {
              expected.segments[name].selector = 0;
              expected.segments[name].usable = false;
            }
            same(
              cpu.readContext(),
              expected,
              'data ignores raw conforming while readable conforming code survives',
            );
            cpu.setContext(cpu.readContext());
            same(cpu.readContext(), expected, 'preserved canonical bases checkpoint');
            const access = await cpu.run({ budget: 1n });
            completion(access);
            state(
              access.state,
              changed(before, 0x2003n, { 0: (before.registers[0]! & ~255n) | 0x7fn, 4: 0x5000n }),
            );
            numeric();
          },
          {
            data: [
              {
                base: 0x4018n,
                bytes: codeDescriptor(64, 3) + stackDescriptor(32, 3),
                write: false,
              },
              { base: 0x6020n, bytes: frame, write: false },
              { base: 0x2000n, bytes: '658a03', read: false, write: false, execute: true },
              { base: 0xffff800000005020n, bytes: '7f', write: false },
            ],
          },
        );
      },
    },
  ];
}
