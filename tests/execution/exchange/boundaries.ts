import { createCpu } from '../../../host/index.js';
import { LIMITS, equal, exit, fault, hex, memory } from '../../support/fixture.js';
import {
  LONG,
  arithmeticFlags,
  bytes,
  changed,
  context,
  input,
  outcome,
  patch,
  using,
  type Scenario,
} from './fixture.js';

const rx = { read: true, write: false, execute: true };
const rw = { read: true, write: true, execute: false };

export function boundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'exchange and compare memory require both permissions on every hit miss and identity path',
      async run() {
        for (const read of [false, true])
          for (const write of [false, true])
            for (const family of [
              'exchange',
              'add',
              'hit',
              'miss',
              'pair-hit',
              'pair-miss',
            ] as const) {
              const pair = family.startsWith('pair');
              const old = pair ? 0x5566778811223344n : 2n;
              const code =
                family === 'exchange'
                  ? 'f0871e'
                  : family === 'add'
                    ? 'f00fc11e'
                    : pair
                      ? 'f00fc70e'
                      : 'f00fb11e';
              const frame = 'a5'.repeat(8) + bytes(old, pair ? 8 : 4) + 'a5'.repeat(8);
              const mappings = [
                {
                  base: 0x1000n,
                  backing: 'code',
                  offset: 0,
                  length: code.length / 2,
                  permissions: rx,
                },
                {
                  base: 0x6000n,
                  backing: 'data',
                  offset: 8,
                  length: pair ? 8 : 4,
                  permissions: { read, write, execute: false },
                },
                {
                  base: 0x7000n,
                  backing: 'data',
                  offset: 0,
                  length: frame.length / 2,
                  permissions: rx,
                },
              ];
              const cpu = await createCpu({
                compiler,
                context: LONG,
                entry: 0x1000n,
                memory: {
                  backings: [
                    { id: 'code', bytes: hex(code) },
                    { id: 'data', bytes: hex(frame) },
                  ],
                  mappings,
                },
                memoryLimits: {
                  maxBackings: 2,
                  maxMappings: 3,
                  maxBackingBytes: code.length / 2 + frame.length / 2,
                },
                limits: LIMITS,
              });
              try {
                const hit = family === 'hit' || family === 'pair-hit';
                const before = input(
                  0x1000n,
                  {
                    0: 0xaaaabbbb00000000n | (hit ? old & 0xffffffffn : 1n),
                    2: 0xccccdddd00000000n | (family === 'pair-hit' ? old >> 32n : 0n),
                    3: 3n,
                    1: 4n,
                    6: 0x6000n,
                  },
                  0xcd7n,
                );
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                if (!read || !write) {
                  outcome(result, 'data-fault', 1n, 0n, before);
                  fault(result, {
                    instructionPc: before.rip,
                    address: 0x6000n,
                    width: pair ? 8 : 4,
                    access: 'write',
                    cause: 'permission',
                    failingAddress: 0x6000n,
                    segment: 'ds',
                  });
                  memory(cpu, 0x7000n, frame);
                } else {
                  const updates: Record<number, bigint> = {};
                  let value = old,
                    flags = 0xcd7n;
                  if (family === 'exchange' || family === 'add') {
                    updates[3] = old;
                    value = family === 'exchange' ? 3n : old + 3n;
                  }
                  if (family === 'add') flags = arithmeticFlags(old, 3n, 32);
                  if (family === 'hit' || family === 'miss') {
                    if (hit) value = 3n;
                    else updates[0] = old;
                    flags = arithmeticFlags(before.registers[0]! & 0xffffffffn, old, 32, true);
                  }
                  if (pair) {
                    if (hit) value = 0x400000003n;
                    else {
                      updates[0] = 0x11223344n;
                      updates[2] = 0x55667788n;
                    }
                    flags = hit ? 0xcd7n : 0xc97n;
                  }
                  outcome(
                    result,
                    'budget',
                    1n,
                    1n,
                    changed(before, 0x1000n + BigInt(code.length / 2), updates, flags),
                  );
                  memory(cpu, 0x7000n, patch(frame, 8, bytes(value, pair ? 8 : 4)));
                }
              } finally {
                cpu.dispose();
              }
            }
      },
    },
    {
      name: 'split qword exchange stores preflight every byte and repaired faults preserve captured inputs',
      async run() {
        for (const cut of [1, 2, 3, 4, 5, 6, 7])
          for (const family of ['add', 'pair-miss'] as const) {
            const code = family === 'add' ? 'f0480fc116' : 'f00fc70e';
            const old = 0xfffffffffffffffen;
            const mappings = [
              {
                base: 0x1000n,
                backing: 'code',
                offset: 0,
                length: code.length / 2,
                permissions: rx,
              },
              { base: 0x6000n, backing: 'data', offset: 8, length: cut, permissions: rw },
              {
                base: 0x6000n + BigInt(cut),
                backing: 'data',
                offset: 8 + cut,
                length: 8 - cut,
                permissions: rx,
              },
              { base: 0x7000n, backing: 'data', offset: 0, length: 24, permissions: rx },
            ];
            const frame = 'a5'.repeat(8) + bytes(old, 8) + 'a5'.repeat(8);
            const cpu = await createCpu({
              compiler,
              context: LONG,
              entry: 0x1000n,
              memory: {
                backings: [
                  { id: 'code', bytes: hex(code) },
                  { id: 'data', bytes: hex(frame) },
                ],
                mappings,
              },
              memoryLimits: {
                maxBackings: 2,
                maxMappings: 4,
                maxBackingBytes: 24 + code.length / 2,
              },
              limits: LIMITS,
            });
            try {
              const before = input(0x1000n, { 0: 1n, 2: 3n, 1: 4n, 3: 5n, 6: 0x6000n }, 0xcd7n);
              cpu.setState(before);
              const failed = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(failed, 'data-fault', 1n, 0n, before);
              fault(failed, {
                instructionPc: before.rip,
                address: 0x6000n,
                width: 8,
                access: 'write',
                cause: 'permission',
                failingAddress: 0x6000n + BigInt(cut),
                segment: 'ds',
              });
              memory(cpu, 0x7000n, frame);
              mappings[2]!.permissions = rw;
              cpu.setMappings(mappings);
              const repaired = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(
                repaired,
                'budget',
                1n,
                1n,
                changed(
                  before,
                  0x1000n + BigInt(code.length / 2),
                  family === 'add' ? { 2: old } : { 0: 0xfffffffen, 2: 0xffffffffn },
                  family === 'add' ? arithmeticFlags(old, 3n, 64) : 0xc97n,
                ),
              );
              memory(cpu, 0x7000n, patch(frame, 8, bytes(family === 'add' ? 1n : old, 8)));
            } finally {
              cpu.dispose();
            }
          }
      },
    },
    {
      name: 'LOCK preserves existing ALU unary and bit operation results in the private observer model',
      async run() {
        for (const body of [
          '010b',
          '090b',
          '110b',
          '190b',
          '210b',
          '290b',
          '310b',
          '830300',
          '830b00',
          '831300',
          '831b00',
          '832300',
          '832b00',
          '833300',
          'fe03',
          'fe0b',
          'ff03',
          'ff0b',
          'f613',
          'f61b',
          'f713',
          'f71b',
          '0fab0b',
          '0fb30b',
          '0fbb0b',
          '0fba2b00',
          '0fba3300',
          '0fba3b00',
        ]) {
          let expectedState: ReturnType<typeof input> | undefined,
            expectedBytes = '';
          for (const locked of [false, true])
            await using(
              compiler,
              (locked ? 'f0' : '') + body,
              LONG,
              async (cpu) => {
                const before = input(0x1000n, { 1: 3n, 3: 0x6008n }, 0xcd7n);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                if (!locked) {
                  expectedState = result.state;
                  expectedBytes = Array.from(cpu.readMemory(0x6000n, 24), (v) =>
                    v.toString(16).padStart(2, '0'),
                  ).join('');
                }
                outcome(
                  result,
                  'budget',
                  1n,
                  1n,
                  locked
                    ? {
                        ...expectedState!,
                        registers: [...expectedState!.registers],
                        rip: expectedState!.rip + 1n,
                      }
                    : expectedState!,
                );
                memory(cpu, 0x6000n, expectedBytes);
              },
              {
                data: [
                  { base: 0x6000n, bytes: 'a5'.repeat(8) + '78563412aabbccdd' + 'a5'.repeat(8) },
                ],
              },
            );
        }
      },
    },
    {
      name: 'selected LOCK decode diagnostics consume required tails without accessing operand data',
      async run() {
        for (const code of [
          'f086c0',
          'f087c0',
          'f00fc0c0',
          'f00fc1c0',
          'f00fb0c0',
          'f00fb1c0',
          'f090',
          '0fc7c8',
          '480fc7c8',
          'f0480fc7c8',
          'f03903',
          'f08503',
          'f00fa303',
          'f00fba2300',
          'f0f70378563412',
          'f0f723',
          'f0ff10',
        ])
          await using(compiler, code, LONG, async (cpu) => {
            const before = input(0x1000n, { 0: 0x800000000000n, 3: 0x800000000000n }, 0xcd7n);
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 1n, repeatBudget: 0n }),
              'invalid-encoding',
              1n,
              0n,
              before,
            );
          });
        for (const code of [
          'f390',
          'f290',
          'f0f090',
          'f2f08703',
          'f0f38703',
          '480fc70c',
          '0fc734',
          'f00fc734',
          'f08903',
        ])
          await using(compiler, code, LONG, async (cpu) => {
            const before = input(0x1000n, {}, 0xcd7n);
            cpu.setState(before);
            outcome(await cpu.run({ budget: 1n, repeatBudget: 0n }), 'unsupported', 1n, 0n, before);
          });
        for (const body of [
          '0103',
          '87842478563412',
          '0fc1842478563412',
          '0fb1842478563412',
          '0fc78c2478563412',
          '0fba2c2400',
          'f784247856341278563412',
        ])
          for (const prefix of ['', 'f0']) {
            const full = prefix + body;
            for (let length = 1; length < full.length / 2; length++)
              await using(compiler, full.slice(0, length * 2), LONG, async (cpu) => {
                const before = input(0x1000n, { 4: 0x800000000000n }, 0xcd7n);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                outcome(result, 'fetch-fault', 1n, 0n, before);
                fault(result, {
                  instructionPc: before.rip,
                  address: before.rip + BigInt(length),
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  failingAddress: before.rip + BigInt(length),
                  segment: 'cs',
                });
              });
          }
        for (const count of [14, 15])
          await using(compiler, '66'.repeat(count) + '90', LONG, async (cpu) => {
            const before = input(0x1000n, {}, 0xcd7n);
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 1n, repeatBudget: 0n }),
              count === 14 ? 'budget' : 'invalid-encoding',
              1n,
              count === 14 ? 1n : 0n,
              count === 14 ? changed(before, 0x100fn) : before,
            );
          });
      },
    },
    {
      name: 'exchange addresses retain high FS bases logical CS offsets and incoming implicit pair banks',
      async run() {
        for (const long64 of [false, true]) {
          const execution = long64
            ? { mode: 'long64' as const, fsBase: 0x100000000n, gsBase: 0n }
            : context('protected', true, true);
          if ('segments' in execution) {
            execution.segments.cs.base = 0x10000n;
            execution.segments.fs.base = 0x20000n;
          }
          const pc = long64 ? 0x100001000n : 0x12345000n;
          const destination = long64 ? 0x100006000n : 0x26000n;
          await using(
            compiler,
            'f0640fc10e',
            execution,
            async (cpu) => {
              const before = input(
                pc,
                { 1: 0x99aabbcc00000003n, 6: long64 ? 0x6000n : 0x1122334400006000n },
                0xcd7n,
              );
              cpu.setState(before);
              outcome(
                await cpu.run({ budget: 1n, repeatBudget: 0n }),
                'budget',
                1n,
                1n,
                changed(
                  before,
                  pc + 5n,
                  { 1: long64 ? 0xfffffffen : 0x99aabbccfffffffen },
                  arithmeticFlags(0xfffffffen, 3n, 32),
                ),
              );
              memory(cpu, destination - 4n, 'a5'.repeat(4) + '01000000' + 'a5'.repeat(4));
            },
            {
              entry: pc,
              codeBase: long64 ? pc : pc + 0x10000n,
              data: [
                { base: destination - 4n, bytes: 'a5'.repeat(4) + 'feffffff' + 'a5'.repeat(4) },
              ],
            },
          );
        }
        for (const pair of [false, true])
          await using(
            compiler,
            pair ? '0fc708' : '0fb108',
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 0: 0x6000n, 1: 3n, 2: 0n }, 0xcd7n);
              cpu.setState(before);
              outcome(
                await cpu.run({ budget: 1n, repeatBudget: 0n }),
                'budget',
                1n,
                1n,
                changed(
                  before,
                  0x1003n,
                  pair ? { 0: 0x11223344n, 2: 0x55667788n } : { 0: 1n },
                  pair ? 0xc97n : arithmeticFlags(0x6000n, 1n, 32, true),
                ),
              );
              memory(
                cpu,
                0x5ffcn,
                'a5'.repeat(4) + (pair ? '4433221188776655' : '01000000') + 'a5'.repeat(4),
              );
            },
            {
              data: [
                {
                  base: 0x5ffcn,
                  bytes: 'a5'.repeat(4) + (pair ? '4433221188776655' : '01000000') + 'a5'.repeat(4),
                },
              ],
            },
          );
      },
    },
    {
      name: 'cached compare entries reread RAM operands and preserve conditional upper register writes',
      async run() {
        await using(
          compiler,
          '90f00fb11ef4',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 0: 0x1122334400000001n, 3: 3n, 6: 0x6000n }, 0xcd7n);
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 1n, repeatBudget: 0n }),
              'budget',
              1n,
              1n,
              changed(before, 0x1001n),
            );
            const owner = cpu.inspectTranslations()[0]!.owner;
            for (const value of [1n, 2n, 1n, 0n]) {
              cpu.writeMemory(0x6000n, hex(bytes(value, 4)));
              const fresh = changed(before, 0x1001n);
              cpu.setState(fresh);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(
                result,
                'budget',
                1n,
                1n,
                changed(
                  fresh,
                  0x1005n,
                  value === 1n ? {} : { 0: value },
                  arithmeticFlags(1n, value, 32, true),
                ),
              );
              equal(
                result.resources.compilations,
                0,
                'retained compare compiles no data-dependent variant',
              );
              equal(result.resources.nativeEntries, 1, 'cached middle entry executes once');
              equal(
                cpu.inspectTranslations()[0]!.owner,
                owner,
                'ordinary data writes retain owner',
              );
              memory(cpu, 0x6000n, bytes(value === 1n ? 3n : value, 4));
            }
          },
          { data: [{ base: 0x6000n, bytes: bytes(1n, 4) }] },
        );
      },
    },
    {
      name: 'exchange instructions retain repetition accounting after a preceding REP retires',
      async run() {
        await using(
          compiler,
          'f3a4f00fc10b',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 1: 1n, 3: 0x6000n, 6: 0x7000n, 7: 0x7100n }, 0x8d7n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 2n, repeatBudget: 1n });
            exit(
              result,
              'budget',
              2n,
              2n,
              changed(before, 0x1006n, { 1: 9n, 6: 0x7001n, 7: 0x7101n }, 6n),
            );
            equal(result.repeatIterations, 1n, 'previous repeated element retained');
            equal(
              result.remainingRepeatBudget,
              0n,
              'exchange consumes no repeated element allowance',
            );
            memory(cpu, 0x6000n, bytes(9n, 4));
            memory(cpu, 0x7100n, '7b');
          },
          {
            data: [
              { base: 0x6000n, bytes: bytes(9n, 4) },
              { base: 0x7000n, bytes: '7b' },
              { base: 0x7100n, bytes: 'a5' },
            ],
          },
        );
      },
    },
  ];
}
