import type { ExecutionContextSnapshot } from '../../../host/index.js';
import {
  CODE16,
  CODE32,
  CODE64,
  addressPrefix,
  bytes,
  changed,
  equal,
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

function destinationWrite(
  before: bigint,
  mode: ExecutionContextSnapshot['mode'],
  width: 16 | 32 | 64,
): bigint {
  if (mode === 'long64') return 0x12345678n;
  return width === 16 ? (before & ~0xffffn) | 0x5678n : (before & ~0xffffffffn) | 0x12345678n;
}

export function modeScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'far JMP immediate and memory pointers execute new loaded CS in every starting profile and width',
      async run() {
        for (const execution of profiles())
          for (const width of execution.mode === 'long64' ? [16, 32, 64] : [16, 32])
            for (const form of ['immediate', 'memory'] as const) {
              if (execution.mode === 'long64' && form === 'immediate') continue;
              const real = execution.mode === 'real' || execution.mode === 'virtual8086';
              const targetWidth: 16 | 32 | 64 =
                execution.mode === 'long64'
                  ? 64
                  : real
                    ? execution.segments.cs.default32
                      ? 32
                      : 16
                    : execution.segments.cs.default32
                      ? 16
                      : 32;
              const selector = real ? 0x1000 : 8,
                target = 0x2000n;
              const pointer = bytes(target, width / 8) + bytes(BigInt(selector), 2);
              const code =
                operandPrefix(execution, width) +
                (form === 'immediate' ? 'ea' + pointer : addressPrefix(execution) + 'ff2b');
              const descriptor = targetWidth === 64 ? CODE64 : targetWidth === 32 ? CODE32 : CODE16;
              const destination = targetWidth === 16 ? 'b87856' : 'b878563412';
              const linear = real ? 0x12000n : target;
              await using(
                compiler,
                code,
                execution,
                async (cpu) => {
                  const before = initial(0x1000n, { 3: 0x5000n, 4: 0x1122334455667788n }, 0xcd7n),
                    numeric = preserveNumeric(cpu);
                  cpu.setState(before);
                  const first = await cpu.run({ budget: 1n });
                  equal(first.reason, 'budget', 'one far jump');
                  equal(first.retired, 1n, 'jump retirement');
                  state(first.state, changed(before, target));
                  const expected = structuredClone(execution);
                  expected.segments.cs = real
                    ? { ...expected.segments.cs, selector, base: 0x10000n }
                    : loadedCode(targetWidth, selector);
                  same(cpu.readContext(), expected, 'all loaded and preserved context fields');
                  cpu.setContext(cpu.readContext());
                  same(cpu.readContext(), expected, 'produced context roundtrip');
                  const next = await cpu.run({ budget: 1n });
                  equal(next.reason, 'budget', 'target executes');
                  equal(next.retired, 1n, 'one target instruction');
                  state(
                    next.state,
                    changed(before, target + BigInt(destination.length / 2), {
                      0: destinationWrite(before.registers[0]!, execution.mode, targetWidth),
                    }),
                  );
                  numeric();
                },
                {
                  data: [
                    { base: linear, bytes: destination, read: false, write: false, execute: true },
                    ...(form === 'memory' ? [{ base: 0x5000n, bytes: pointer, write: false }] : []),
                    ...(real ? [] : [{ base: 0x4008n, bytes: descriptor, write: false }]),
                  ],
                },
              );
            }
      },
    },
    {
      name: 'far JMP crosses IA32e code submodes with old operand widths and lossless retained caches',
      async run() {
        const cases: { execution: ExecutionContextSnapshot; targetWidth: 16 | 32 | 64 }[] = [];
        for (const execution of profiles().filter((p) => p.mode === 'compatibility'))
          cases.push({ execution, targetWidth: 64 });
        for (const targetWidth of [16, 32] as const) {
          const execution = snapshot();
          execution.segments.ss.usable = false;
          execution.segments.ss.type = 'read-only';
          execution.segments.ss.base = 0x1234567800007000n;
          execution.segments.ds.base = 0x1234567800005000n;
          execution.segments.fs.base = 0xffff800000005000n;
          execution.segments.gs.base = 0x100006000n;
          cases.push({ execution, targetWidth });
        }
        for (const { execution, targetWidth } of cases)
          for (const width of execution.mode === 'long64' ? [16, 32, 64] : [16, 32])
            for (const form of ['immediate', 'memory'] as const) {
              if (execution.mode === 'long64' && form === 'immediate') continue;
              const pointer = bytes(0x2000n, width / 8) + '1000';
              const code =
                operandPrefix(execution, width) +
                (form === 'immediate' ? 'ea' + pointer : addressPrefix(execution) + 'ff2b');
              const descriptor = targetWidth === 64 ? CODE64 : targetWidth === 32 ? CODE32 : CODE16;
              const destination = targetWidth === 16 ? 'b87856' : 'b878563412';
              await using(
                compiler,
                code,
                execution,
                async (cpu) => {
                  const before = initial(0x1000n, { 3: 0x5000n, 4: 0x1122334455667788n }, 0xcd7n),
                    numeric = preserveNumeric(cpu);
                  cpu.setState(before);
                  const first = await cpu.run({ budget: 1n });
                  equal(first.reason, 'budget', 'submode handoff');
                  equal(first.retired, 1n, 'one far instruction');
                  state(first.state, changed(before, 0x2000n));
                  const expected = structuredClone(execution);
                  expected.mode = targetWidth === 64 ? 'long64' : 'compatibility';
                  expected.segments.cs = loadedCode(targetWidth, 16);
                  same(cpu.readContext(), expected, 'CS mode and retained caches');
                  cpu.setContext(cpu.readContext());
                  same(cpu.readContext(), expected, 'retained raw caches import');
                  const next = await cpu.run({ budget: 1n });
                  equal(next.reason, 'budget', 'new submode decode');
                  state(
                    next.state,
                    changed(before, 0x2000n + BigInt(destination.length / 2), {
                      0: destinationWrite(before.registers[0]!, expected.mode, targetWidth),
                    }),
                  );
                  numeric();
                },
                {
                  data: [
                    { base: 0x4010n, bytes: descriptor, write: false },
                    { base: 0x2000n, bytes: destination, read: false, write: false, execute: true },
                    ...(form === 'memory' ? [{ base: 0x5000n, bytes: pointer, write: false }] : []),
                  ],
                },
              );
            }
      },
    },
  ];
}
