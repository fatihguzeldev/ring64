import { createCpu, type RunResult, type SegmentFault } from '../../../host/index.js';
import { LIMITS, check, equal, exit, fault, hex, memory } from '../../support/fixture.js';
import {
  LONG,
  bytes,
  changed,
  context,
  input,
  outcome,
  patch,
  using,
  type Scenario,
} from './fixture.js';

function segmentFault(result: RunResult, expected: SegmentFault): void {
  equal(result.fault, undefined, 'segment fault has no linear diagnostic');
  check(result.segmentFault, 'missing segment diagnostic');
  for (const key of [
    'instructionPc',
    'segment',
    'offset',
    'width',
    'access',
    'cause',
    'failingOffset',
  ] as const)
    equal(result.segmentFault[key], expected[key], `segment fault ${key}`);
}

export function boundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'memory transfer and stack forms preserve source target and destination fault order',
      async run() {
        for (const row of [
          { code: 'ff10', source: true, sp: 0x800000000000n },
          { code: 'ff20', source: true, sp: 0x800000000000n },
          { code: 'ff30', source: true, sp: 0x800000000000n },
          { code: '8f00', source: false, sp: 0x7000n },
        ])
          await using(compiler, row.code, LONG, async (cpu) => {
            const before = input(
              0x1000n,
              { 0: row.source ? 0x6000n : 0x800000000000n, 4: row.sp },
              0xcd7n,
            );
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
            outcome(result, 'data-fault', 1n, 0n, before);
            fault(result, {
              instructionPc: 0x1000n,
              address: row.source ? 0x6000n : 0x7000n,
              width: 8,
              access: 'read',
              cause: 'unmapped',
              failingAddress: row.source ? 0x6000n : 0x7000n,
              segment: row.source ? 'ds' : 'ss',
            });
          });
        for (const code of ['ff10', 'ff20'])
          await using(
            compiler,
            code,
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 0: 0x6000n, 4: 0x7000n }, 0xcd7n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(result, 'target-fault', 1n, 0n, before);
              fault(result, {
                instructionPc: 0x1000n,
                address: 0x800000000000n,
                width: 0,
                access: 'execute',
                cause: 'noncanonical',
                failingAddress: 0x800000000000n,
                segment: 'cs',
              });
              memory(cpu, 0x6000n, bytes(0x800000000000n, 8));
            },
            { data: [{ base: 0x6000n, bytes: bytes(0x800000000000n, 8), write: false }] },
          );
      },
    },
    {
      name: 'memory PUSH and POP preflight the entire destination before publishing bytes or SP',
      async run() {
        for (const code of ['ff30', '8f00']) {
          const push = code === 'ff30';
          const stack = bytes(0x8877665544332211n, 8);
          const source = '1020304050607080';
          await using(
            compiler,
            code,
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 0: 0x6000n, 4: push ? 0x4018n : 0x4010n }, 0xcd7n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(result, 'data-fault', 1n, 0n, before);
              fault(result, {
                instructionPc: 0x1000n,
                address: push ? 0x4010n : 0x6000n,
                width: 8,
                access: 'write',
                cause: 'permission',
                failingAddress: push ? 0x4014n : 0x6004n,
                segment: push ? 'ss' : 'ds',
              });
              memory(cpu, 0x4010n, stack);
              memory(cpu, 0x6000n, source);
            },
            {
              data: [
                { base: 0x4010n, bytes: stack.slice(0, 8) },
                { base: 0x4014n, bytes: stack.slice(8), write: !push },
                { base: 0x6000n, bytes: source.slice(0, 8) },
                { base: 0x6004n, bytes: source.slice(8), write: push },
              ],
            },
          );
        }
      },
    },
    {
      name: 'POP uses pending RSP only for the explicit overridden destination',
      async run() {
        const code = '648f0424';
        await using(
          compiler,
          code,
          { mode: 'long64', fsBase: 0x10000n, gsBase: 0n },
          async (cpu) => {
            const before = input(0x1000n, { 4: 0x4010n }, 0xcd7n);
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 1n, repeatBudget: 0n }),
              'budget',
              1n,
              1n,
              changed(before, 0x1004n, { 4: 0x4018n }),
            );
            memory(cpu, 0x4010n, '8877665544332211');
            memory(cpu, 0x14010n, 'a5'.repeat(8) + '8877665544332211' + 'a5'.repeat(8));
          },
          {
            data: [
              { base: 0x4010n, bytes: '8877665544332211', write: false },
              { base: 0x14010n, bytes: 'a5'.repeat(24) },
            ],
          },
        );
      },
    },
    {
      name: 'near memory CALL keeps logical targets and return PCs across wrapped segment bases',
      async run() {
        const ctx = context('protected', true, true);
        ctx.segments.cs.base = 0xfffff000n;
        ctx.segments.ds.base = 0xfffff000n;
        ctx.segments.ss.base = 0xffffe000n;
        const stack = 'a5'.repeat(32);
        await using(
          compiler,
          'ff13',
          ctx,
          async (cpu) => {
            const before = input(
              0x1000n,
              { 3: 0x1122334400006000n, 4: 0x5566778800004020n },
              0xcd7n,
            );
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 1n, repeatBudget: 0n }),
              'budget',
              1n,
              1n,
              changed(before, 0x1010n, { 4: 0x556677880000401cn }),
            );
            memory(cpu, 0x2010n, patch(stack, 12, '02100000'));
            memory(cpu, 0x5000n, '10100000');
            equal(
              cpu.inspectTranslations()[0]!.entries[0],
              0x1000n,
              'entry remains a logical CS offset',
            );
          },
          {
            codeBase: 0n,
            data: [
              { base: 0x2010n, bytes: stack },
              { base: 0x5000n, bytes: '10100000', write: false },
            ],
          },
        );
      },
    },
    {
      name: 'memory near transfers preserve full high linear addresses and pointer targets in long64',
      async run() {
        await using(
          compiler,
          'ff10',
          LONG,
          async (cpu) => {
            const before = input(0x100001000n, { 0: 0x100006000n, 4: 0x100004020n }, 0xcd7n);
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 1n, repeatBudget: 0n }),
              'budget',
              1n,
              1n,
              changed(before, 0x100001010n, { 4: 0x100004018n }),
            );
            memory(cpu, 0x100004000n, 'a5'.repeat(24) + '0210000001000000');
            memory(cpu, 0x100006000n, '1010000001000000');
          },
          {
            entry: 0x100001000n,
            data: [
              { base: 0x100004000n, bytes: 'a5'.repeat(32) },
              { base: 0x100006000n, bytes: '1010000001000000', write: false },
            ],
          },
        );
      },
    },
    {
      name: 'memory-indirect targets remain runtime data when a retained artifact is reused',
      async run() {
        for (const code of ['ff10', 'ff20'])
          await using(
            compiler,
            code,
            LONG,
            async (cpu) => {
              let owner: bigint | undefined;
              for (const target of [0x1010n, 0x1020n, 0x800000000000n, 0x1030n]) {
                cpu.writeMemory(0x6000n, hex(bytes(target, 8)));
                const before = input(0x1000n, { 0: 0x6000n, 4: 0x4020n }, 0xcd7n);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                outcome(
                  result,
                  target === 0x800000000000n ? 'target-fault' : 'budget',
                  1n,
                  target === 0x800000000000n ? 0n : 1n,
                  target === 0x800000000000n
                    ? before
                    : changed(before, target, code === 'ff10' ? { 4: 0x4018n } : {}),
                );
                const nextOwner = cpu.inspectTranslations()[0]!.owner;
                if (owner !== undefined) {
                  equal(nextOwner, owner, 'pointer writes retain code ownership');
                  equal(result.resources.compilations, 0, 'pointer changes need no retranslation');
                }
                owner = nextOwner;
              }
            },
            {
              data: [
                { base: 0x6000n, bytes: bytes(0x1010n, 8) },
                { base: 0x4010n, bytes: 'a5'.repeat(32) },
              ],
            },
          );
      },
    },
    {
      name: 'counter target faults roll back counts while untaken branches do not validate that target',
      async run() {
        for (const code of ['e20a', 'e10a', 'e00a', 'e30a']) {
          const ctx = context();
          ctx.segments.cs.limit = 0x1001;
          await using(compiler, code, ctx, async (cpu) => {
            const flags = code === 'e00a' ? 0xc97n : 0xcd7n;
            const takenCount = code === 'e30a' ? 0n : 2n;
            const before = input(0x1000n, { 1: 0x1122334400000000n | takenCount }, flags);
            cpu.setState(before);
            const failed = await cpu.run({ budget: 1n, repeatBudget: 0n });
            outcome(failed, 'segment-fault', 1n, 0n, before);
            segmentFault(failed, {
              instructionPc: 0x1000n,
              segment: 'cs',
              offset: 0x100cn,
              width: 1,
              access: 'execute',
              cause: 'limit',
              failingOffset: 0x100cn,
            });
            const untaken = input(0x1000n, { 1: 0x1122334400000001n }, flags);
            cpu.setState(untaken);
            outcome(
              await cpu.run({ budget: 1n, repeatBudget: 0n }),
              'budget',
              1n,
              1n,
              changed(untaken, 0x1002n, code === 'e30a' ? {} : { 1: 0x1122334400000000n }),
            );
          });
        }
      },
    },
    {
      name: 'counter self loops use instruction budget with zero repetition allowance',
      async run() {
        for (const code of ['e2fe', 'e3fe'])
          await using(compiler, code, LONG, async (cpu) => {
            const before = input(0x1000n, { 1: 0n }, 0xcd7n);
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 3n, repeatBudget: 0n }),
              'budget',
              3n,
              3n,
              changed(before, 0x1000n, code === 'e2fe' ? { 1: 0xfffffffffffffffdn } : {}),
            );
          });
      },
    },
    {
      name: 'LOCK and repeat diagnostics precede operand accesses for the admitted near stack forms',
      async run() {
        for (const body of ['ff10', 'ff20', 'ff30', '8f00', 'c9', 'e000', 'e100', 'e200', 'e300'])
          for (const prefix of ['f0', 'f2', 'f3', 'f0f0'])
            await using(compiler, prefix + body, LONG, async (cpu) => {
              const before = input(
                0x1000n,
                { 0: 0x800000000000n, 4: 0x800000000000n, 5: 0x800000000000n },
                0xcd7n,
              );
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(result, prefix === 'f0' ? 'invalid-encoding' : 'unsupported', 1n, 0n, before);
              equal(result.fault, undefined, 'prefix failure does not read data');
              equal(result.segmentFault, undefined, 'prefix failure has no segment access');
            });
      },
    },
    {
      name: 'near encodings fetch every required byte before LOCK rejection and stop at fifteen bytes',
      async run() {
        for (const body of [
          'ff942478563412',
          'ffb42478563412',
          '8f842478563412',
          'e001',
          'e101',
          'e201',
          'e301',
        ])
          for (const prefix of ['', 'f0']) {
            const code = prefix + body;
            for (let length = 1; length < code.length / 2; length++)
              await using(compiler, code.slice(0, length * 2), LONG, async (cpu) => {
                const before = input(0x1000n, { 4: 0x800000000000n }, 0xcd7n);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                outcome(result, 'fetch-fault', 1n, 0n, before);
                fault(result, {
                  instructionPc: 0x1000n,
                  address: 0x1000n + BigInt(length),
                  failingAddress: 0x1000n + BigInt(length),
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  segment: 'cs',
                });
              });
          }
        for (const length of [13, 14])
          await using(compiler, '66'.repeat(length) + 'e200', LONG, async (cpu) => {
            const before = input(0x1000n, { 1: 2n }, 0xcd7n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
            outcome(
              result,
              length === 13 ? 'budget' : 'invalid-encoding',
              1n,
              length === 13 ? 1n : 0n,
              length === 13 ? changed(before, 0x100fn, { 1: 1n }) : before,
            );
            equal(result.fault, undefined, 'instruction length rejection has no operand access');
          });
        for (const code of ['ff1c', '8f0c'])
          await using(compiler, code, LONG, async (cpu) => {
            const before = input(0x1000n, {}, 0xcd7n);
            cpu.setState(before);
            outcome(await cpu.run({ budget: 1n, repeatBudget: 0n }), 'unsupported', 1n, 0n, before);
          });
      },
    },
    {
      name: 'REX B selects actual extended stack registers while REX R leaves digit selectors unchanged',
      async run() {
        for (const row of [
          { code: '45fff4', push: true, width: 8 },
          { code: '458fc4', push: false, width: 8 },
          { code: '6645fff4', push: true, width: 2 },
          { code: '66458fc4', push: false, width: 2 },
        ]) {
          const stack = patch('a5'.repeat(40), 16, '8877665544332211');
          await using(
            compiler,
            row.code,
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 4: 0x4010n, 12: 0x99aabbccddeeff00n }, 0xcd7n);
              cpu.setState(before);
              outcome(
                await cpu.run({ budget: 1n, repeatBudget: 0n }),
                'budget',
                1n,
                1n,
                changed(
                  before,
                  0x1000n + BigInt(row.code.length / 2),
                  row.push
                    ? { 4: 0x4010n - BigInt(row.width) }
                    : {
                        4: 0x4010n + BigInt(row.width),
                        12: row.width === 8 ? 0x1122334455667788n : 0x99aabbccddee7788n,
                      },
                ),
              );
              memory(
                cpu,
                0x4000n,
                row.push
                  ? patch(stack, 16 - row.width, bytes(0x99aabbccddeeff00n, row.width))
                  : stack,
              );
            },
            { data: [{ base: 0x4000n, bytes: stack }] },
          );
        }
      },
    },
    {
      name: 'bounded stack instructions preserve preceding REP accounting',
      async run() {
        await using(
          compiler,
          'f3a4ff30',
          LONG,
          async (cpu) => {
            const before = input(
              0x1000n,
              { 0: 0x6000n, 1: 1n, 4: 0x4010n, 6: 0x7000n, 7: 0x7100n },
              0x8d7n,
            );
            cpu.setState(before);
            const result = await cpu.run({ budget: 2n, repeatBudget: 1n });
            exit(
              result,
              'budget',
              2n,
              2n,
              changed(before, 0x1004n, { 1: 0n, 4: 0x4008n, 6: 0x7001n, 7: 0x7101n }),
            );
            equal(result.repeatIterations, 1n, 'preceding REP iteration retained');
            equal(result.remainingRepeatBudget, 0n, 'bounded PUSH consumes no repetition quota');
            memory(cpu, 0x7100n, '7b');
            memory(cpu, 0x4000n, 'a5'.repeat(8) + '8877665544332211' + 'a5'.repeat(8));
          },
          {
            data: [
              { base: 0x4000n, bytes: 'a5'.repeat(24) },
              { base: 0x6000n, bytes: '8877665544332211', write: false },
              { base: 0x7000n, bytes: '7b', write: false },
              { base: 0x7100n, bytes: 'a5' },
            ],
          },
        );
      },
    },
    {
      name: 'code-writing memory PUSH and POP retire completely before the changed successor is fetched',
      async run() {
        for (const pop of [false, true]) {
          const code = (pop ? '8f00' : 'ff30') + 'f5f4' + 'a5'.repeat(6);
          const value = 'f4' + 'a5'.repeat(7);
          const cpu = await createCpu({
            compiler,
            entry: 0x1000n,
            context: LONG,
            limits: LIMITS,
            memory: {
              backings: [
                { id: 'code', bytes: hex(code) },
                { id: 'data', bytes: hex(value) },
              ],
              mappings: [
                {
                  base: 0x1000n,
                  backing: 'code',
                  offset: 0,
                  length: 10,
                  permissions: { read: true, write: false, execute: true },
                },
                {
                  base: 0x3000n,
                  backing: 'code',
                  offset: 2,
                  length: 8,
                  permissions: { read: true, write: true, execute: false },
                },
                {
                  base: 0x6000n,
                  backing: 'data',
                  offset: 0,
                  length: 8,
                  permissions: { read: true, write: false, execute: false },
                },
              ],
            },
            memoryLimits: { maxBackings: 4, maxMappings: 6, maxBackingBytes: 256 },
          });
          try {
            const before = input(
              0x1000n,
              { 0: pop ? 0x3000n : 0x6000n, 4: pop ? 0x6000n : 0x3008n },
              0xcd7n,
            );
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 2n, repeatBudget: 0n }),
              'unsupported',
              2n,
              1n,
              changed(before, 0x1002n, { 4: pop ? 0x6008n : 0x3000n }),
            );
            memory(cpu, 0x1000n, (pop ? '8f00' : 'ff30') + value);
            memory(cpu, 0x6000n, value);
          } finally {
            cpu.dispose();
          }
        }
      },
    },
  ];
}
