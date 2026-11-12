import type { ExecutionContextSnapshot } from '../../../host/index.js';
import {
  CODE16,
  CODE32,
  CODE64,
  addressPrefix,
  bytes,
  changed,
  completion,
  hex,
  initial,
  loadedCode,
  operandPrefix,
  preserveNumeric,
  profiles,
  same,
  snapshot,
  state,
  using,
  type Scenario,
} from './fixture.js';

function codeWidth(execution: ExecutionContextSnapshot): 16 | 32 | 64 {
  return execution.mode === 'long64' ? 64 : execution.segments.cs.default32 ? 32 : 16;
}
function stackMask(execution: ExecutionContextSnapshot): bigint {
  return (
    (1n << BigInt(execution.mode === 'long64' ? 64 : execution.segments.ss.default32 ? 32 : 16)) -
    1n
  );
}

export function valueScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'far CALL and matching RETF preserve complete frame bytes and raw banks in all profiles forms and widths',
      async run() {
        for (const execution of profiles())
          for (const width of execution.mode === 'long64' ? [16, 32, 64] : [16, 32])
            for (const form of ['immediate', 'memory'] as const) {
              if (execution.mode === 'long64' && form === 'immediate') continue;
              const real = execution.mode === 'real' || execution.mode === 'virtual8086',
                selector = real ? 0x1000 : 16;
              const pointer = bytes(0x2000n, width / 8) + bytes(BigInt(selector), 2);
              const call =
                operandPrefix(execution, width) +
                (form === 'immediate' ? '9a' + pointer : addressPrefix(execution) + 'ff1b');
              const targetRet = operandPrefix(execution, width) + 'cb',
                targetCode = codeWidth(execution);
              const descriptor = targetCode === 64 ? CODE64 : targetCode === 32 ? CODE32 : CODE16;
              await using(
                compiler,
                call + '90',
                execution,
                async (cpu) => {
                  const oldSP = execution.mode === 'long64' ? 0x6020n : 0x1122334400006020n;
                  const before = initial(0x1000n, { 3: 0x5000n, 4: oldSP }, 0xcd7n),
                    numeric = preserveNumeric(cpu);
                  const next = 0x1000n + BigInt(call.length / 2),
                    mask = stackMask(execution),
                    w = BigInt(width / 8);
                  const p1 = (oldSP - w) & mask,
                    p2 = (p1 - w) & mask,
                    afterSP = (oldSP & ~mask) | p2;
                  cpu.setState(before);
                  cpu.setTimeState({ tsc: 100n, tscAux: 7 });
                  const first = await cpu.run({ budget: 1n, repeatBudget: 13n });
                  completion(first, 1n, 1n, 13n);
                  same(
                    cpu.readTimeState(),
                    { tsc: 101n, tscAux: 7 },
                    'ordinary far CALL ticks once across full mode matrix',
                  );
                  state(first.state, changed(before, 0x2000n, { 4: afterSP }));
                  const expected = hex('cc'.repeat(64));
                  expected.set(
                    hex(bytes(BigInt(execution.segments.cs.selector), width / 8)),
                    Number(p1 - 0x6000n),
                  );
                  expected.set(hex(bytes(next, width / 8)), Number(p2 - 0x6000n));
                  same(
                    cpu.readMemory(0x6000n, 64),
                    expected,
                    'both full-width slots and untouched neighbors',
                  );
                  const loaded = structuredClone(execution);
                  loaded.segments.cs = real
                    ? { ...loaded.segments.cs, selector, base: 0x10000n }
                    : loadedCode(targetCode, selector);
                  same(cpu.readContext(), loaded, 'callee code cache');
                  const returned = await cpu.run({ budget: 1n, repeatBudget: 13n });
                  completion(returned, 1n, 1n, 13n);
                  same(cpu.readTimeState(), { tsc: 102n, tscAux: 7 }, 'ordinary RETF ticks once');
                  state(returned.state, changed(before, next));
                  const caller = structuredClone(execution);
                  if (!real) caller.segments.cs = loadedCode(targetCode, 8);
                  same(cpu.readContext(), caller, 'explicit return reloads source code descriptor');
                  same(
                    cpu.readMemory(0x6000n, 64),
                    expected,
                    'return does not erase or rewrite frame',
                  );
                  cpu.setContext(cpu.readContext());
                  same(cpu.readContext(), caller, 'caller context roundtrip');
                  const resumed = await cpu.run({ budget: 1n, repeatBudget: 13n });
                  completion(resumed, 1n, 1n, 13n);
                  same(
                    cpu.readTimeState(),
                    { tsc: 103n, tscAux: 7 },
                    'context import adds no credit before successor NOP',
                  );
                  state(resumed.state, changed(before, next + 1n));
                  numeric();
                },
                {
                  data: [
                    {
                      base: real ? 0x12000n : 0x2000n,
                      bytes: targetRet,
                      read: false,
                      write: false,
                      execute: true,
                    },
                    { base: 0x6000n, bytes: 'cc'.repeat(64) },
                    ...(form === 'memory' ? [{ base: 0x5000n, bytes: pointer, write: false }] : []),
                    ...(real
                      ? []
                      : [{ base: 0x4008n, bytes: descriptor + descriptor, write: false }]),
                  ],
                },
              );
            }
      },
    },
    {
      name: 'far frame slots wrap pointer steps independently at sixteen and sixty four bit ends',
      async run() {
        for (const width of [16, 32, 64]) {
          const execution = width === 64 ? snapshot() : snapshot('protected', 0, true, false);
          const oldSP = width === 64 ? 8n : 0x1122334455660000n + BigInt(width === 16 ? 2 : 6);
          const mask = stackMask(execution),
            w = BigInt(width / 8),
            p1 = (oldSP - w) & mask,
            p2 = (p1 - w) & mask;
          const call = operandPrefix(execution, width) + addressPrefix(execution) + 'ff1b';
          const targetRet = operandPrefix(execution, width) + 'cb',
            descriptor = width === 64 ? CODE64 : CODE32;
          const pointer = bytes(0x2000n, width / 8) + '1000',
            next = 0x1000n + BigInt(call.length / 2);
          await using(
            compiler,
            call,
            execution,
            async (cpu) => {
              const before = initial(0x1000n, { 3: 0x5000n, 4: oldSP }, 0xcd7n),
                numeric = preserveNumeric(cpu);
              cpu.setState(before);
              const first = await cpu.run({ budget: 1n });
              completion(first);
              state(first.state, changed(before, 0x2000n, { 4: (oldSP & ~mask) | p2 }));
              same(
                cpu.readMemory(p1, width / 8),
                hex(bytes(8n, width / 8)),
                'wrapped selector slot',
              );
              same(
                cpu.readMemory(p2, width / 8),
                hex(bytes(next, width / 8)),
                'wrapped offset slot',
              );
              const returned = await cpu.run({ budget: 1n });
              completion(returned);
              state(returned.state, changed(before, next));
              numeric();
            },
            {
              data: [
                { base: 0x2000n, bytes: targetRet, read: false, write: false, execute: true },
                { base: 0x4008n, bytes: descriptor + descriptor, write: false },
                { base: 0x5000n, bytes: pointer, write: false },
                { base: p1, bytes: 'cc'.repeat(width / 8) },
                { base: p2, bytes: 'cc'.repeat(width / 8) },
              ],
            },
          );
        }
      },
    },
    {
      name: 'far long64 literal CALL defaults allocate32 bit slots rather than near64 bit slots',
      async run() {
        for (const [code, ret, sp, cs, ip, pointer] of [
          ['ff1b', 'cb', 0x6018n, '08000000', '02100000', '002000001000'],
          ['66ff1b', '66cb', 0x601cn, '0800', '0310', '00201000'],
          [
            '48ff1b',
            '48cb',
            0x6010n,
            '0800000000000000',
            '0310000000000000',
            '00200000000000001000',
          ],
        ] as const) {
          await using(
            compiler,
            code,
            snapshot(),
            async (cpu) => {
              const before = initial(0x1000n, { 3: 0x5000n, 4: 0x6020n }, 0xcd7n),
                numeric = preserveNumeric(cpu);
              cpu.setState(before);
              const called = await cpu.run({ budget: 1n });
              completion(called);
              state(called.state, changed(before, 0x2000n, { 4: sp }));
              same(
                cpu.readMemory(sp, (cs.length + ip.length) / 2),
                hex(ip + cs),
                'literal padded frame',
              );
              const returned = await cpu.run({ budget: 1n });
              completion(returned);
              state(returned.state, changed(before, code === 'ff1b' ? 0x1002n : 0x1003n));
              numeric();
            },
            {
              data: [
                { base: 0x2000n, bytes: ret, read: false, write: false, execute: true },
                { base: 0x4008n, bytes: CODE64 + CODE64, write: false },
                { base: 0x5000n, bytes: pointer, write: false },
                { base: 0x6000n, bytes: 'cc'.repeat(64) },
              ],
            },
          );
        }
      },
    },
  ];
}
