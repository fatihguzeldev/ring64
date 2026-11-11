import { createCpu } from '../../../host/index.js';
import { LIMITS } from '../../support/fixture.js';
import { BANK, PC, little, usingPaged } from '../paging/fixture.js';
import {
  LONG,
  input,
  changed,
  outcome,
  stack,
  slot,
  clone,
  environment,
  seed,
  other,
  x87,
  using,
  equal,
  hex,
  memory,
  type Scenario,
} from './fixture.js';

export function specialMemoryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'x87 BCD read and suppressed invalid store refetch successor bytes modified by an operand accessed update',
      async run() {
        for (const store of [false, true]) {
          const tables = new Uint8Array(0x4000);
          for (const [address, value] of [
            [0x1000n, 0x2027n],
            [0x2000n, 0x3027n],
            [0x3010n, 0x4027n],
            [0x4000n, 0x9027n],
          ] as const)
            tables.set(little([value]), Number(address - 0x1000n));
          const code = hex(`${store ? 'df33' : 'df23'}b807a0000000000000`);
          const map = (
            base: bigint,
            backing: string,
            offset: number,
            length: number,
            execute = false,
          ) => ({
            base,
            backing,
            offset,
            length,
            permissions: { read: true, write: true, execute },
          });
          const cpu = await createCpu({
            compiler,
            memoryModel: 'ia32e-paged',
            paging: BANK,
            entry: PC,
            memory: {
              backings: [
                { id: 'tables', bytes: tables },
                { id: 'code', bytes: code },
                { id: 'data', bytes: hex('42000000000000000000') },
              ],
              mappings: [
                map(0x1000n, 'tables', 0, 0x3800),
                map(0x4800n, 'code', 3, 8),
                map(0x4808n, 'tables', 0x3808, 0x7f8),
                map(0x9000n, 'code', 0, code.length, true),
                map(0xa000n, 'data', 0, 10),
              ],
            },
            limits: LIMITS,
            memoryLimits: { maxBackings: 3, maxMappings: 5, maxBackingBytes: 0x5000 },
          });
          try {
            const before = input(PC, { 3: 0x500000n });
            const state = store ? stack({ 0: 0x7fff8000000000000000n }, 0, 0x37e) : stack();
            const expected = clone(state);
            if (store) expected.statusWord = 0x8081;
            else {
              slot(expected, 7, 0x4004a800000000000000n);
              expected.statusWord = 0x3800;
            }
            cpu.setState(before);
            seed(cpu, state);
            const result = await cpu.run({ budget: 2n });
            outcome(result, 'budget', 2n, 2n, 2n, 0n, changed(before, PC + 7n, { 0: 0xa027n }));
            x87(cpu, environment(expected, PC, 0x500000n, store ? 0x733 : undefined));
            other(cpu);
            equal(cpu.readPhysicalMemory(0x9003n, 1)[0], 0x27, 'A changed successor immediate');
            equal(cpu.readPhysicalMemory(0xa000n, 1)[0], 0x42, 'suppressed store keeps payload');
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'x87 BCD dirty metadata failure suppresses precision result pop and producer metadata',
      async run() {
        await usingPaged(
          compiler,
          {
            code: 'df33',
            words: [[0x4800n, 0xa027n]],
            spans: [{ physical: 0xa000n, bytes: new Uint8Array(10).fill(0xa5) }],
            tableWindows: [
              { physical: 0x1000n, offset: 0, length: 0x3800, write: true },
              { physical: 0x4800n, offset: 0x3800, length: 8, write: false },
              { physical: 0x4808n, offset: 0x3808, length: 0x7f8, write: true },
            ],
          },
          async (cpu) => {
            const before = input(PC, { 3: 0x500000n }),
              state = stack({ 0: 0x3fffc000000000000000n }, 0, 0x35f);
            cpu.setState(before);
            seed(cpu, state);
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'physical-memory-fault', 'D write refusal');
            equal(result.physicalMemoryFault?.phase, 'dirty-write', 'D phase');
            equal(result.retired, 0n, 'no numeric producer retirement');
            x87(cpu, state);
            other(cpu);
            equal(
              Array.from(cpu.readPhysicalMemory(0xa000n, 10)).every((v) => v === 0xa5),
              true,
              'no partial payload',
            );
          },
        );
      },
    },
    {
      name: 'x87 BCD full ten-byte operand admission precedes empty stack invalid conversion and pending metadata',
      async run() {
        for (const store of [false, true])
          for (let length = 1; length < 10; length++) {
            await using(
              compiler,
              store ? 'df33' : 'df23',
              LONG,
              async (cpu) => {
                const before = input(0x1000n, { 3: 0x6000n }),
                  state = store
                    ? stack({ 0: 0x7fff8000000000000000n }, 0, 0x37e)
                    : stack({}, 0, 0x37e);
                cpu.setState(before);
                seed(cpu, state);
                const result = await cpu.run({ budget: 1n });
                equal(result.reason, 'data-fault', 'complete operand required');
                equal(result.retired, 0n, 'failed numeric instruction');
                equal(result.fault?.width, 10, 'ten byte operation');
                equal(result.fault?.failingAddress, 0x6000n + BigInt(length), 'exact missing tail');
                x87(cpu, state);
                other(cpu);
                memory(cpu, 0x6000n, 'a5'.repeat(length));
              },
              { data: [{ base: 0x6000n, bytes: 'a5'.repeat(length) }] },
            );
          }
      },
    },
  ];
}
