import { createCpu, type MemoryMapping } from '../../../host/index.js';
import { LIMITS } from '../../support/fixture.js';
import {
  ONE,
  NUMERIC_STATUS,
  LONG,
  input,
  changed,
  outcome,
  stack,
  slot,
  clone,
  pop,
  environment,
  seed,
  other,
  x87,
  noFault,
  using,
  raw,
  bytes,
  memory,
  fault,
  equal,
  hex,
  type Scenario,
} from './fixture.js';

const map = (
  base: bigint,
  backing: string,
  length: number,
  read = true,
  write = true,
  offset = 0,
  execute = false,
): MemoryMapping => ({ base, backing, offset, length, permissions: { read, write, execute } });

export function memoryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'x87 ten-byte loads and write-only stores cross every split using exact raw payloads and guards',
      async run() {
        const value = 0x7fff8000000000000011n,
          payload = bytes(value, 10);
        for (let split = 1; split < 10; split++) {
          const mappings = [
            map(0x1000n, 'code', 4, true, false, 0, true),
            map(0x6000n, 'a', split),
            map(0x6000n + BigInt(split), 'b', 10 - split),
            map(0x7000n, 'c', split, false),
            map(0x7000n + BigInt(split), 'd', 10 - split, false),
          ];
          const cpu = await createCpu({
            compiler,
            context: LONG,
            limits: LIMITS,
            entry: 0x1000n,
            memoryLimits: { maxBackings: 5, maxMappings: 5, maxBackingBytes: 128 },
            memory: {
              backings: [
                { id: 'code', bytes: hex('db2bdb3f') },
                { id: 'a', bytes: hex(payload.slice(0, split * 2)) },
                { id: 'b', bytes: hex(payload.slice(split * 2)) },
                { id: 'c', bytes: new Uint8Array(split).fill(0xa5) },
                { id: 'd', bytes: new Uint8Array(10 - split).fill(0xa5) },
              ],
              mappings,
            },
          });
          try {
            const before = input(0x1000n, { 3: 0x6000n, 7: 0x7000n }, 0xcd7n),
              state = stack(),
              loaded = clone(state);
            slot(loaded, 7, value);
            loaded.statusWord = 0x3800;
            cpu.setState(before);
            seed(cpu, state);
            const load = await cpu.run({ budget: 1n });
            outcome(load, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
            x87(cpu, environment(loaded, 0x1000n, 0x6000n), NUMERIC_STATUS);
            noFault(load);
            const stored = clone(loaded);
            pop(stored);
            const store = await cpu.run({ budget: 1n });
            outcome(store, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1004n));
            x87(cpu, environment(stored, 0x1002n, 0x7000n), NUMERIC_STATUS);
            other(cpu);
            noFault(store);
            cpu.setMappings(
              mappings.map((m) => ({ ...m, permissions: { ...m.permissions, read: true } })),
            );
            memory(cpu, 0x6000n, payload);
            memory(cpu, 0x7000n, payload);
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'x87 m80 accesses reach the final guest byte and overflowing spans preserve every stack field',
      async run() {
        const address = (1n << 64n) - 10n;
        for (const store of [false, true])
          await using(
            compiler,
            store ? 'db3b' : 'db2b',
            LONG,
            async (cpu) => {
              const before = input(0x1000n, { 3: address }, 0xcd7n),
                state = store ? stack({ 0: ONE }) : stack(),
                expected = clone(state);
              if (store) pop(expected);
              else {
                slot(expected, 7, ONE);
                expected.statusWord = 0x3800;
              }
              cpu.setState(before);
              seed(cpu, state);
              const result = await cpu.run({ budget: 1n });
              outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
              x87(cpu, environment(expected, 0x1000n, address), NUMERIC_STATUS);
              noFault(result);
              memory(cpu, address, bytes(ONE, 10));
              const failedState = cpu.readX87State(),
                retry = input(0x1000n, { 3: address + 1n }, 0xcd7n);
              cpu.setState(retry);
              const failed = await cpu.run({ budget: 1n, repeatBudget: 7n });
              outcome(failed, 'data-fault', 1n, 0n, 7n, 0n, retry);
              fault(failed, {
                instructionPc: 0x1000n,
                address: address + 1n,
                width: 10,
                access: store ? 'write' : 'read',
                cause: 'address-range',
                failingAddress: 1n << 64n,
              });
              x87(cpu, failedState);
              other(cpu);
              memory(cpu, address, bytes(ONE, 10));
            },
            { data: [{ base: address, bytes: bytes(ONE, 10) }] },
          );
      },
    },
    {
      name: 'x87 late memory permission failures precede numeric status tags pops and environment publication',
      async run() {
        for (const store of [false, true])
          for (let split = 1; split < 10; split++) {
            const code = store ? 'db3b' : 'db2b';
            await using(
              compiler,
              code,
              LONG,
              async (cpu) => {
                const before = input(0x1000n, { 3: 0x6000n }, 0xcd7n),
                  state = stack({ 0: ONE });
                cpu.setState(before);
                seed(cpu, state);
                const result = await cpu.run({ budget: 1n, repeatBudget: 3n });
                outcome(result, 'data-fault', 1n, 0n, 3n, 0n, before);
                fault(result, {
                  instructionPc: 0x1000n,
                  address: 0x6000n,
                  width: 10,
                  access: store ? 'write' : 'read',
                  cause: 'permission',
                  failingAddress: 0x6000n + BigInt(split),
                });
                x87(cpu, state);
                other(cpu);
                if (store) {
                  memory(cpu, 0x6000n, 'a5'.repeat(split));
                  memory(cpu, 0x6000n + BigInt(split), 'a5'.repeat(10 - split));
                }
              },
              {
                data: [
                  { base: 0x6000n, bytes: 'a5'.repeat(split) },
                  {
                    base: 0x6000n + BigInt(split),
                    bytes: 'a5'.repeat(10 - split),
                    read: store,
                    write: !store,
                  },
                ],
              },
            );
          }
        await using(
          compiler,
          'd91b',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 3: 0x6000n }, 0xcd7n),
              state = stack({ 0: raw(0x407f) }, 0, 0x377);
            cpu.setState(before);
            seed(cpu, state);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'data-fault', 1n, 0n, 1n, 0n, before);
            fault(result, {
              instructionPc: 0x1000n,
              address: 0x6000n,
              width: 4,
              access: 'write',
              cause: 'permission',
              failingAddress: 0x6000n,
            });
            x87(cpu, state);
            other(cpu);
            memory(cpu, 0x6000n, 'a5a5a5a5');
          },
          { data: [{ base: 0x6000n, bytes: 'a5a5a5a5', write: false }] },
        );
      },
    },
    {
      name: 'x87 m80 alias stores preserve increasing guest-byte order when backing destinations overlap',
      async run() {
        const payload = '10111213141516171819',
          value = 0x19181716151413121110n;
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          entry: 0x1000n,
          memoryLimits: { maxBackings: 2, maxMappings: 3, maxBackingBytes: 64 },
          memory: {
            backings: [
              { id: 'code', bytes: hex('db3b') },
              { id: 'data', bytes: new Uint8Array(8).fill(0xa5) },
            ],
            mappings: [
              map(0x1000n, 'code', 2, true, false, 0, true),
              map(0x6000n, 'data', 5),
              map(0x6005n, 'data', 5),
            ],
          },
        });
        try {
          const before = input(0x1000n, { 3: 0x6000n }),
            state = stack({ 0: value }),
            expected = clone(state);
          pop(expected);
          cpu.setState(before);
          seed(cpu, state);
          const result = await cpu.run({ budget: 1n });
          outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
          x87(cpu, environment(expected, 0x1000n, 0x6000n), NUMERIC_STATUS);
          other(cpu);
          noFault(result);
          memory(cpu, 0x6000n, payload.slice(10).repeat(2));
          cpu.setMappings([map(0x8000n, 'data', 8)]);
          memory(cpu, 0x8000n, '1516171819a5a5a5');
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'x87 changed and identical m80 code-alias stores retire once then execute the current successor bytes',
      async run() {
        for (const original of ['01', '07']) {
          const code = `db3bb8${original}0000009090909090`,
            written = 'b8070000009090909090';
          const cpu = await createCpu({
            compiler,
            limits: LIMITS,
            entry: 0x1000n,
            memoryLimits: { maxBackings: 1, maxMappings: 2, maxBackingBytes: 32 },
            memory: {
              backings: [{ id: 'code', bytes: hex(code) }],
              mappings: [
                map(0x1000n, 'code', 12, true, false, 0, true),
                map(0x6000n, 'code', 10, false, true, 2),
              ],
            },
          });
          try {
            const before = input(0x1000n, { 3: 0x6000n }),
              state = stack({ 0: 0x909090909000000007b8n }),
              expected = clone(state);
            pop(expected);
            cpu.setState(before);
            seed(cpu, state);
            const result = await cpu.run({ budget: 2n, repeatBudget: 3n });
            outcome(result, 'budget', 2n, 2n, 3n, 0n, changed(before, 0x1007n, { 0: 7n }));
            x87(cpu, environment(expected, 0x1000n, 0x6000n), NUMERIC_STATUS);
            other(cpu);
            noFault(result);
            memory(cpu, 0x1002n, written);
            equal(result.resources.compilations, 2, 'fresh post-store owner');
            equal(result.resources.nativeEntries, 2, 'store and successor native entries');
            equal(result.resources.dispatches, 1, 'one code-change dispatch');
          } finally {
            cpu.dispose();
          }
        }
      },
    },
  ];
}
