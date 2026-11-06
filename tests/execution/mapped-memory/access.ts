import { type Scenario, changed, exit, fault, memory } from '../../support/fixture.js';
import { BASE, RW, RX, backing, input, mapping, using } from './fixture.js';

export function accessScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'every mapping permission mask independently controls fetch read store and RMW',
      run: async () => {
        for (let mask = 0; mask < 8; mask++) {
          const permissions = { read: !!(mask & 1), write: !!(mask & 2), execute: !!(mask & 4) };
          for (const item of [
            {
              code: '8a03',
              access: 'read',
              allowed: permissions.read,
              value: '7f',
              after: { 0: 0x112233445566777fn },
              flags: 0x8d7n,
            },
            {
              code: '8803',
              access: 'write',
              allowed: permissions.write,
              value: '88',
              after: {},
              flags: 0x8d7n,
            },
            {
              code: 'fe03',
              access: 'write',
              allowed: permissions.read && permissions.write,
              value: '80',
              after: {},
              flags: 0x893n,
            },
          ] as const) {
            await using(
              compiler,
              [backing('code', item.code), backing('data', '7f')],
              [mapping(BASE, 'code', 2, RX), mapping(0x4000n, 'data', 1, permissions)],
              async (cpu) => {
                const before = input({ 3: 0x4000n });
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                if (item.allowed)
                  exit(
                    result,
                    'budget',
                    1n,
                    1n,
                    changed(before, BASE + 2n, item.after, item.flags),
                  );
                else {
                  exit(result, 'data-fault', 1n, 0n, before);
                  fault(result, {
                    instructionPc: BASE,
                    address: 0x4000n,
                    failingAddress: 0x4000n,
                    width: 1,
                    access: item.access,
                    cause: 'permission',
                  });
                }
                cpu.setMappings([mapping(BASE, 'code', 2, RX), mapping(0x4000n, 'data', 1, RW)]);
                memory(cpu, 0x4000n, item.allowed ? item.value : '7f');
              },
            );
          }
          await using(
            compiler,
            [backing('code', 'b801000000')],
            [mapping(BASE, 'code', 5, permissions)],
            async (cpu) => {
              const before = input();
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              if (permissions.execute)
                exit(result, 'budget', 1n, 1n, changed(before, BASE + 5n, { 0: 1n }));
              else {
                exit(result, 'fetch-fault', 1n, 0n, before);
                fault(result, {
                  instructionPc: BASE,
                  address: BASE,
                  failingAddress: BASE,
                  width: 1,
                  access: 'execute',
                  cause: 'permission',
                });
              }
            },
          );
        }
      },
    },
    {
      name: 'split operands gather distinct backings and preflight all bytes before stores',
      run: async () => {
        for (const item of [
          { load: '8a03', store: '8803', width: 1, value: 0x11n },
          { load: '668b03', store: '668903', width: 2, value: 0x2211n },
          { load: '8b03', store: '8903', width: 4, value: 0x44332211n },
          { load: '488b03', store: '488903', width: 8, value: 0x8877665544332211n },
        ]) {
          for (const store of [false, true]) {
            const code = store ? item.store : item.load;
            const count = item.width;
            const banks = [
              backing('code', code),
              ...Array.from({ length: count }, (_, i) =>
                backing(`byte${i}`, `a5${((i + 1) * 0x11).toString(16).padStart(2, '0')}a5`),
              ),
            ];
            const maps = [
              mapping(BASE, 'code', code.length / 2, RX),
              ...Array.from({ length: count }, (_, i) =>
                mapping(0x4000n + BigInt(i), `byte${i}`, 1, RW, 1),
              ),
            ];
            await using(compiler, banks, maps, async (cpu) => {
              const before = input({ 0: store ? 0x0102030405060708n : 0n, 3: 0x4000n });
              cpu.setState(before);
              exit(
                await cpu.run({ budget: 1n }),
                'budget',
                1n,
                1n,
                changed(before, BASE + BigInt(code.length / 2), store ? {} : { 0: item.value }),
              );
              memory(
                cpu,
                0x4000n,
                store
                  ? '0807060504030201'.slice(0, count * 2)
                  : '1122334455667788'.slice(0, count * 2),
              );
              cpu.setMappings([
                mapping(BASE, 'code', code.length / 2, RX),
                ...Array.from({ length: count }, (_, i) =>
                  mapping(0x5000n + 3n * BigInt(i), `byte${i}`, 3, RW),
                ),
              ]);
              for (let i = 0; i < count; i++) {
                const value = store
                  ? '0807060504030201'.slice(i * 2, i * 2 + 2)
                  : ((i + 1) * 0x11).toString(16).padStart(2, '0');
                memory(cpu, 0x5000n + 3n * BigInt(i), `a5${value}a5`);
              }
            });
          }
        }
        for (const permission of [false, true]) {
          await using(
            compiler,
            [backing('code', '488903'), backing('first', 'a5a5a5a5'), backing('last', 'a5a5a5a5')],
            [
              mapping(BASE, 'code', 3, RX),
              mapping(0x4000n, 'first', 4, RW),
              ...(permission ? [mapping(0x4004n, 'last', 4, RX)] : []),
            ],
            async (cpu) => {
              const before = input({ 3: 0x4000n });
              cpu.setState(before);
              const result = await cpu.run({ budget: 3n });
              exit(result, 'data-fault', 3n, 0n, before);
              fault(result, {
                instructionPc: BASE,
                address: 0x4000n,
                failingAddress: 0x4004n,
                width: 8,
                access: 'write',
                cause: permission ? 'permission' : 'unmapped',
              });
              memory(cpu, 0x4000n, 'a5a5a5a5');
            },
          );
        }
      },
    },
    {
      name: 'split RMW captures its complete aliased old operand before any store byte',
      run: async () => {
        await using(
          compiler,
          [backing('code', '660103'), backing('data', '10')],
          [
            mapping(BASE, 'code', 3, RX),
            mapping(0x4000n, 'data', 1, RW),
            mapping(0x4001n, 'data', 1, RW),
          ],
          async (cpu) => {
            const before = input({ 3: 0x4000n });
            cpu.setState(before);
            // 0x1010 + AX(0x7788) = 0x8798, then the high guest byte wins the alias collision.
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(before, BASE + 3n, {}, 0x882n),
            );
            memory(cpu, 0x4000n, '8787');
          },
        );
      },
    },
    {
      name: 'mapped high addresses preserve full-u64 and whole-span failure priority',
      run: async () => {
        await using(
          compiler,
          [backing('code', '8a038803'), backing('last', '7f')],
          [mapping(BASE, 'code', 4, RX), mapping(0xffffffffffffffffn, 'last', 1, RW)],
          async (cpu) => {
            const before = input({ 3: 0xffffffffffffffffn });
            cpu.setState(before);
            const first = changed(before, BASE + 2n, { 0: 0x112233445566777fn });
            exit(await cpu.run({ budget: 1n }), 'budget', 1n, 1n, first);
            exit(await cpu.run({ budget: 1n }), 'budget', 1n, 1n, changed(first, BASE + 4n));
            memory(cpu, 0xffffffffffffffffn, '7f');
          },
        );
        for (const item of [
          { address: 0xffffffffffffffffn, cause: 'address-range', failing: 1n << 64n },
          { address: 0x7fffffffffffn, cause: 'noncanonical', failing: 0x800000000000n },
        ] as const) {
          await using(
            compiler,
            [backing('code', '668903'), backing('last', 'a5')],
            [mapping(BASE, 'code', 3, RX), mapping(item.address, 'last', 1, RW)],
            async (cpu) => {
              const before = input({ 3: item.address });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'data-fault', 1n, 0n, before);
              fault(result, {
                instructionPc: BASE,
                address: item.address,
                failingAddress: item.failing,
                width: 2,
                access: 'write',
                cause: item.cause,
              });
              memory(cpu, item.address, 'a5');
            },
          );
        }
      },
    },
  ];
}
