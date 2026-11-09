import {
  createCpu,
  using,
  snapshot,
  initial,
  outcome,
  equal,
  same,
  hex,
  LIMITS,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function memoryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'system PUSHF preflights the full split slot before any source-alias byte or owner mutation',
      async run() {
        for (const width of [2, 4, 8]) {
          const code = width === 2 ? '669c' : '9c';
          const execution = snapshot(width === 4 ? 'protected' : 'long64');
          const mappings = [
            {
              base: 0x1000n,
              backing: 'code',
              offset: 0,
              length: code.length / 2,
              permissions: { read: true, write: false, execute: true },
            },
            {
              base: 0x6000n,
              backing: 'code',
              offset: code.length / 2 - 1,
              length: 1,
              permissions: { read: false, write: true, execute: false },
            },
            ...(width > 2
              ? [
                  {
                    base: 0x6001n,
                    backing: 'ram',
                    offset: 1,
                    length: width - 2,
                    permissions: { read: false, write: true, execute: false },
                  },
                ]
              : []),
            {
              base: 0x6000n + BigInt(width - 1),
              backing: 'ram',
              offset: width - 1,
              length: 1,
              permissions: { read: true, write: false, execute: false },
            },
            {
              base: 0x7000n,
              backing: 'ram',
              offset: 0,
              length: width + 2,
              permissions: { read: true, write: false, execute: false },
            },
          ];
          const cpu = await createCpu({
            compiler,
            context: execution,
            entry: 0x1000n,
            limits: LIMITS,
            memoryLimits: { maxBackings: 2, maxMappings: 5, maxBackingBytes: 32 },
            memory: {
              backings: [
                { id: 'code', bytes: hex(code) },
                { id: 'ram', bytes: hex('a5'.repeat(width + 2)) },
              ],
              mappings,
            },
          });
          try {
            const numeric = preserveNumeric(cpu);
            const before = initial(0x1000n, { 4: 0x6000n + BigInt(width) }, 0x3c7ed7n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'data-fault', 1n, 0n);
            same(result.state, before, 'failed push has no scalar publication');
            equal(result.fault?.address, 0x6000n, 'whole slot address');
            equal(result.fault?.width, width, 'whole slot width');
            equal(
              result.fault?.failingAddress,
              0x6000n + BigInt(width - 1),
              'late permission byte',
            );
            equal(result.fault?.cause, 'permission', 'tail permission cause');
            same(cpu.readMemory(0x1000n, code.length / 2), hex(code), 'source alias unchanged');
            same(
              cpu.readMemory(0x7000n, width + 2),
              hex('a5'.repeat(width + 2)),
              'all backing guards',
            );
            equal(cpu.inspectTranslations().length, 1, 'failed write retains source owner');
            numeric();
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'system POP SS admits complete padding before descriptor reads and retains old state on failure',
      async run() {
        const cpu = await createCpu({
          compiler,
          context: snapshot('protected'),
          entry: 0x1000n,
          limits: LIMITS,
          memoryLimits: { maxBackings: 2, maxMappings: 4, maxBackingBytes: 16 },
          memory: {
            backings: [
              { id: 'code', bytes: hex('17') },
              { id: 'stack', bytes: hex('1800aabb') },
            ],
            mappings: [
              {
                base: 0x1000n,
                backing: 'code',
                offset: 0,
                length: 1,
                permissions: { read: true, write: false, execute: true },
              },
              {
                base: 0x6000n,
                backing: 'stack',
                offset: 0,
                length: 2,
                permissions: { read: true, write: false, execute: false },
              },
              {
                base: 0x6002n,
                backing: 'stack',
                offset: 2,
                length: 2,
                permissions: { read: false, write: true, execute: false },
              },
              {
                base: 0x7000n,
                backing: 'stack',
                offset: 0,
                length: 4,
                permissions: { read: true, write: false, execute: false },
              },
            ],
          },
        });
        try {
          const numeric = preserveNumeric(cpu);
          const before = initial(0x1000n, { 4: 0x1122334400006000n }, 0x10102n, {
            sti: false,
            ss: true,
          });
          const context = cpu.readContext();
          cpu.setState(before);
          const result = await cpu.run({ budget: 1n });
          outcome(result, 'data-fault', 1n, 0n);
          same(result.state, { ...before, flags: 0x102n }, 'RF only changes before source fault');
          equal(result.fault?.width, 4, 'selected full source width');
          equal(result.fault?.failingAddress, 0x6002n, 'padding admission precedes missing GDT');
          equal(result.systemMemoryFault, undefined, 'no descriptor read yet');
          same(cpu.readContext(), context, 'old SS preserved');
          same(
            cpu.readMemory(0x7000n, 4),
            hex('1800aabb'),
            'captured source and padding unchanged',
          );
          numeric();
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'system full-width FLAGS stack geometry precedes mapping access and clears begun RF only',
      async run() {
        const execution = snapshot('protected', 0, true, false);
        execution.segments.ss.limit = 0xffff;
        for (const pop of [false, true]) {
          await using(compiler, pop ? '9d' : '9c', execution, async (cpu) => {
            const numeric = preserveNumeric(cpu);
            const sp = pop ? 0xfffen : 2n;
            const before = initial(0x1000n, { 4: 0x1122334400000000n | sp }, 0x10102n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'segment-fault', 1n, 0n);
            equal(result.segmentFault?.segment, 'ss', 'implicit stack owner');
            equal(result.segmentFault?.offset, 0xfffen, 'slot start wraps once');
            equal(result.segmentFault?.failingOffset, 0x10000n, 'bytes do not wrap per byte');
            equal(result.segmentFault?.width, 4, 'operand width retained');
            same(result.state, { ...before, flags: 0x102n }, 'no popped or pushed state');
            numeric();
          });
        }
      },
    },
  ];
}
