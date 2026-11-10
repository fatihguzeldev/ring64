import { createCpu } from '../../../host/index.js';
import { LIMITS, equal, fault, hex, memory } from '../../support/fixture.js';
import { LONG, changed, context, input, using, type Scenario } from '../modes/fixture.js';
import { outcome } from '../strings/fixture.js';

export function literalPackets(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'near packets capture CALL and PUSH sources before overlapping stack stores',
      async run() {
        for (const packet of [
          {
            code: 'ff5424f8',
            source: 0x4018n,
            bytes: '1010000000000000',
            target: 0x1010n,
            saved: '0410000000000000',
          },
          {
            code: 'ff3424',
            source: 0x4020n,
            bytes: 'efcdab8967452301',
            target: 0x1003n,
            saved: 'efcdab8967452301',
          },
        ]) {
          await using(
            compiler,
            packet.code,
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 4: 0x4020n }, 0xcd7n);
              cpu.setState(before);
              outcome(
                await cpu.run({ budget: 1n, repeatBudget: 0n }),
                'budget',
                1n,
                1n,
                0n,
                0n,
                changed(before, packet.target, { 4: 0x4018n }),
              );
              memory(cpu, 0x4018n, packet.saved);
              if (packet.source === 0x4020n) memory(cpu, packet.source, packet.bytes);
            },
            {
              data: [
                {
                  base: 0x4018n,
                  bytes:
                    packet.source === 0x4018n
                      ? packet.bytes + 'a5'.repeat(8)
                      : 'a5'.repeat(8) + packet.bytes,
                },
              ],
            },
          );
        }
      },
    },
    {
      name: 'near packet long64 operand override still reads and pushes eight-byte CALL words',
      async run() {
        for (const truncated of [false, true])
          await using(
            compiler,
            '66ff10',
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 0: 0x6000n, 4: 0x4020n }, 0xcd7n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(
                result,
                truncated ? 'data-fault' : 'budget',
                1n,
                truncated ? 0n : 1n,
                0n,
                0n,
                truncated ? before : changed(before, 0x1010n, { 4: 0x4018n }),
              );
              if (truncated)
                fault(result, {
                  instructionPc: 0x1000n,
                  address: 0x6000n,
                  width: 8,
                  access: 'read',
                  cause: 'unmapped',
                  failingAddress: 0x6002n,
                  segment: 'ds',
                });
              memory(cpu, 0x4018n, truncated ? 'a5'.repeat(8) : '0310000000000000');
            },
            {
              data: [
                { base: 0x6000n, bytes: truncated ? '1010' : '1010000000000000', write: false },
                { base: 0x4018n, bytes: 'a5'.repeat(8) },
              ],
            },
          );
      },
    },
    {
      name: 'near packet CALL rereads ordinary pointer data and preserves captured invalid targets',
      async run() {
        await using(
          compiler,
          'ff10',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 0: 0x6000n, 4: 0x4020n }, 0xcd7n);
            for (const [index, target] of [0x1010n, 0x1020n, 0x800000000000n].entries()) {
              const bytes = new Uint8Array(8);
              new DataView(bytes.buffer).setBigUint64(0, target, true);
              cpu.writeMemory(0x6000n, bytes);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              const invalid = index === 2;
              outcome(
                result,
                invalid ? 'target-fault' : 'budget',
                1n,
                invalid ? 0n : 1n,
                0n,
                0n,
                invalid ? before : changed(before, target, { 4: 0x4018n }),
              );
              if (index > 0)
                equal(result.resources.compilations, 0, 'pointer mutation retains code owner');
              if (invalid)
                fault(result, {
                  instructionPc: 0x1000n,
                  address: target,
                  width: 0,
                  access: 'execute',
                  cause: 'noncanonical',
                  failingAddress: target,
                  segment: 'cs',
                });
            }
          },
          {
            data: [
              { base: 0x6000n, bytes: '00'.repeat(8) },
              { base: 0x4018n, bytes: 'a5'.repeat(8) },
            ],
          },
        );
      },
    },
    {
      name: 'near packets POP uses pending RSP while R12 remains a different bank',
      async run() {
        for (const packet of [
          { code: '8f0424', destination: 0x4028n, write: true, segment: 'ss' as const },
          { code: '8f0424', destination: 0x4028n, write: false, segment: 'ss' as const },
          { code: '8f4424f8', destination: 0x4020n, write: false, segment: 'ss' as const },
          { code: '418f0424', destination: 0x5000n, write: true, segment: 'ds' as const },
          { code: '418f0424', destination: 0x800000000000n, write: false, segment: 'ds' as const },
        ]) {
          const noncanonical = packet.destination === 0x800000000000n;
          const same = packet.destination === 0x4020n;
          const data = [{ base: 0x4020n, bytes: '8877665544332211', write: !same }];
          if (!same && !noncanonical)
            data.push({ base: packet.destination, bytes: 'a5'.repeat(8), write: packet.write });
          await using(
            compiler,
            packet.code,
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 4: 0x4020n, 12: 0x5000n }, 0xcd7n);
              if (noncanonical) before.registers[12] = packet.destination;
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(
                result,
                packet.write ? 'budget' : 'data-fault',
                1n,
                packet.write ? 1n : 0n,
                0n,
                0n,
                packet.write
                  ? changed(before, 0x1000n + BigInt(packet.code.length / 2), { 4: 0x4028n })
                  : before,
              );
              if (!packet.write)
                fault(result, {
                  instructionPc: 0x1000n,
                  address: packet.destination,
                  width: 8,
                  access: 'write',
                  cause: noncanonical ? 'noncanonical' : 'permission',
                  failingAddress: packet.destination,
                  segment: packet.segment,
                });
              if (!noncanonical)
                memory(
                  cpu,
                  packet.destination,
                  packet.write || same ? '8877665544332211' : 'a5'.repeat(8),
                );
              memory(cpu, 0x4020n, '8877665544332211');
            },
            { data },
          );
        }
      },
    },
    {
      name: 'near packet POP word-stack wrap retains full pending bank for address32 destination',
      async run() {
        const execution = context('protected', true, false);
        execution.segments.ss.base = 0x20000n;
        for (const write of [true, false])
          await using(
            compiler,
            '8f0424',
            execution,
            async (cpu) => {
              const before = input(0x1000n, { 4: 0x112233440001fffcn }, 0xcd7n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(
                result,
                write ? 'budget' : 'data-fault',
                1n,
                write ? 1n : 0n,
                0n,
                0n,
                write ? changed(before, 0x1003n, { 4: 0x1122334400010000n }) : before,
              );
              memory(cpu, 0x30000n, write ? '78563412' : 'a5a5a5a5');
              if (!write)
                fault(result, {
                  instructionPc: 0x1000n,
                  address: 0x30000n,
                  width: 4,
                  access: 'write',
                  cause: 'permission',
                  failingAddress: 0x30000n,
                  segment: 'ss',
                });
            },
            {
              data: [
                { base: 0x2fffcn, bytes: '78563412', write: false },
                { base: 0x30000n, bytes: 'a5a5a5a5', write },
              ],
            },
          );
      },
    },
    {
      name: 'near packets LEAVE uses frame address independently of old SP and operand width',
      async run() {
        for (const wide of [false, true])
          for (const read of [false, true])
            await using(
              compiler,
              wide ? '6648c9' : '66c9',
              LONG,
              async (cpu) => {
                const before = input(
                  0x1000n,
                  { 4: 0x800000000000n, 5: 0xffff800000004020n },
                  0xcd7n,
                );
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                outcome(
                  result,
                  read ? 'budget' : 'data-fault',
                  1n,
                  read ? 1n : 0n,
                  0n,
                  0n,
                  read
                    ? changed(before, wide ? 0x1003n : 0x1002n, {
                        4: wide ? 0xffff800000004028n : 0xffff800000004022n,
                        5: wide ? 0x1122334455667788n : 0xffff800000007788n,
                      })
                    : before,
                );
                if (!read)
                  fault(result, {
                    instructionPc: 0x1000n,
                    address: 0xffff800000004020n,
                    width: wide ? 8 : 2,
                    access: 'read',
                    cause: 'permission',
                    failingAddress: 0xffff800000004020n,
                    segment: 'ss',
                  });
              },
              { data: [{ base: 0xffff800000004020n, bytes: '8877665544332211', read }] },
            );
        const execution = context('protected', false, true);
        execution.segments.ss.base = 0x20000n;
        await using(
          compiler,
          'c9',
          execution,
          async (cpu) => {
            const before = input(
              0x1000n,
              { 4: 0x1122334400abcde0n, 5: 0x99aabbcc00014000n },
              0xcd7n,
            );
            cpu.setState(before);
            outcome(
              await cpu.run({ budget: 1n, repeatBudget: 0n }),
              'budget',
              1n,
              1n,
              0n,
              0n,
              changed(before, 0x1001n, { 4: 0x1122334400014002n, 5: 0x99aabbcc00015678n }),
            );
          },
          { data: [{ base: 0x34000n, bytes: '7856' }] },
        );
      },
    },
    {
      name: 'near packets counter selection target narrowing and untaken sequential PC are independent',
      async run() {
        for (const packet of [
          {
            code: '66e200',
            count: 0x1122334400000002n,
            nextCount: 0x1122334400000001n,
            next: 0x5003n,
          },
          {
            code: '66e200',
            count: 0x1122334400000001n,
            nextCount: 0x1122334400000000n,
            next: 0x12345003n,
          },
          {
            code: '67e200',
            count: 0x1122334400010000n,
            nextCount: 0x112233440001ffffn,
            next: 0x12345003n,
          },
          {
            code: '66e300',
            count: 0x1122334400000000n,
            nextCount: 0x1122334400000000n,
            next: 0x5003n,
          },
        ])
          await using(
            compiler,
            packet.code,
            context('protected', true, true),
            async (cpu) => {
              const before = input(0x12345000n, { 1: packet.count }, 0xcd7n);
              cpu.setState(before);
              outcome(
                await cpu.run({ budget: 1n, repeatBudget: 0n }),
                'budget',
                1n,
                1n,
                0n,
                0n,
                changed(before, packet.next, { 1: packet.nextCount }),
              );
            },
            { entry: 0x12345000n },
          );
        await using(compiler, '6748e200', LONG, async (cpu) => {
          const before = input(0x1000n, { 1: 0x1122334400000002n }, 0xcd7n);
          cpu.setState(before);
          outcome(
            await cpu.run({ budget: 1n, repeatBudget: 0n }),
            'budget',
            1n,
            1n,
            0n,
            0n,
            changed(before, 0x1004n, { 1: 1n }),
          );
        });
      },
    },
    {
      name: 'near packet taken counter target failure never publishes decrement',
      async run() {
        for (const count of [1n, 2n])
          await using(
            compiler,
            'e27f',
            LONG,
            async (cpu) => {
              const before = input(0x7ffffffffff0n, { 1: count }, 0xcd7n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(
                result,
                count === 1n ? 'budget' : 'target-fault',
                1n,
                count === 1n ? 1n : 0n,
                0n,
                0n,
                count === 1n ? changed(before, 0x7ffffffffff2n, { 1: 0n }) : before,
              );
              if (count === 2n)
                fault(result, {
                  instructionPc: before.rip,
                  address: 0x800000000071n,
                  width: 0,
                  access: 'execute',
                  cause: 'noncanonical',
                  failingAddress: 0x800000000071n,
                  segment: 'cs',
                });
            },
            { entry: 0x7ffffffffff0n },
          );
      },
    },
    {
      name: 'near packet aliased CALL code write commits captured target before stale successor dispatch',
      async run() {
        for (const budget of [1n, 2n]) {
          const cpu = await createCpu({
            compiler,
            context: LONG,
            entry: 0x1080n,
            memory: {
              backings: [
                { id: 'code', bytes: hex('ff10f582a5a5a5a5a5a5') },
                { id: 'pointer', bytes: hex('8210000000000000') },
              ],
              mappings: [
                {
                  base: 0x1080n,
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
                  backing: 'pointer',
                  offset: 0,
                  length: 8,
                  permissions: { read: true, write: false, execute: false },
                },
              ],
            },
            memoryLimits: { maxBackings: 2, maxMappings: 3, maxBackingBytes: 18 },
            limits: LIMITS,
          });
          try {
            const before = input(0x1080n, { 0: 0x6000n, 4: 0x3008n }, 0xcd7n);
            cpu.setState(before);
            outcome(
              await cpu.run({ budget, repeatBudget: 0n }),
              budget === 1n ? 'budget' : 'unsupported',
              budget,
              1n,
              0n,
              0n,
              changed(before, 0x1082n, { 4: 0x3000n }),
            );
            memory(cpu, 0x1082n, '8210000000000000');
          } finally {
            cpu.dispose();
          }
        }
      },
    },
  ];
}
