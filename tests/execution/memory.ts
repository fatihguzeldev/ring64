import {
  createFixture,
  type Scenario,
  CODE,
  DATA,
  FRAME,
  hex,
  memory,
  initial,
  changed,
  exit,
  fault,
} from './fixture.js';

export function memoryScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'memory forms use exact widths, displacement signs and high bases',
      run: async () => {
        const cases = [
          { code: '8b03', registers: {}, dst: 0, value: 0x55667788n },
          { code: '488b03', registers: {}, dst: 0, value: 0x1122334455667788n },
          { code: '458b45fc', registers: { 13: DATA + 4n }, dst: 8, value: 0x55667788n },
          { code: '8b437f', registers: { 3: DATA - 127n }, dst: 0, value: 0x55667788n },
          {
            code: '4a8b8300000080',
            registers: { 3: DATA + 0x80000000n },
            dst: 0,
            value: 0x1122334455667788n,
          },
        ];
        for (const item of cases)
          await using(item.code, async (cpu) => {
            const input = initial(CODE, item.registers, 0x8d7n);
            cpu.setState(input);
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(input, CODE + BigInt(item.code.length / 2), { [item.dst]: item.value }),
            );
            memory(cpu, DATA - 8n, FRAME);
          });
        for (const item of [
          { code: '8903', registers: { 0: 0xaabbccdd89abcdefn }, word: 'efcdab8944332211' },
          { code: '488903', registers: { 0: 0xaabbccdd89abcdefn }, word: 'efcdab89ddccbbaa' },
          {
            code: '4d8945fc',
            registers: { 8: 0xaabbccdd89abcdefn, 13: DATA + 4n },
            word: 'efcdab89ddccbbaa',
          },
          {
            code: '48894380',
            registers: { 0: 0xaabbccdd89abcdefn, 3: DATA + 128n },
            word: 'efcdab89ddccbbaa',
          },
          {
            code: '89bdffffff7f',
            registers: { 5: DATA - 0x7fffffffn, 7: 0x1122334489abcdefn },
            word: 'efcdab8944332211',
          },
        ])
          await using(item.code, async (cpu) => {
            const input = initial(CODE, item.registers, 0x8d7n);
            cpu.setState(input);
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(input, CODE + BigInt(item.code.length / 2)),
            );
            memory(cpu, DATA - 8n, `1011121314151617${item.word}f0f1f2f3f4f5f6f7`);
          });
      },
    },
    {
      name: 'address formation wraps before checking the complete operand',
      run: async () => {
        await using(
          '488b4320',
          async (cpu) => {
            const input = initial(CODE, { 3: 0xfffffffffffffff0n });
            cpu.setState(input);
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(input, CODE + 4n, { 0: 0x1122334455667788n }),
            );
            memory(cpu, 0x10n, '8877665544332211');
          },
          { ramBase: 0x10n, ram: '8877665544332211' },
        );
        await using(
          '8b43fc',
          async (cpu) => {
            const input = initial(CODE, { 3: 0x800000000000n });
            cpu.setState(input);
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(input, CODE + 3n, { 0: 0x12345678n }),
            );
          },
          { ramBase: 0x7ffffffffffcn, ram: '78563412' },
        );
      },
    },
    {
      name: 'loads cross adjacent readable spans while RAM stays non-executable',
      run: async () => {
        await using(
          '8b03',
          async (cpu) => {
            const input = initial(CODE, { 3: CODE }, 0x8d7n);
            cpu.setState(input);
            const after = changed(input, CODE + 2n, { 0: 0x1234038bn });
            exit(await cpu.run({ budget: 1n }), 'budget', 1n, 1n, after);
            const result = await cpu.run({ budget: 1n });
            exit(result, 'fetch-fault', 1n, 0n, after);
            fault(result, {
              instructionPc: CODE + 2n,
              address: CODE + 2n,
              width: 1,
              access: 'execute',
              cause: 'permission',
              failingAddress: CODE + 2n,
            });
            memory(cpu, CODE + 2n, '3412');
          },
          { ramBase: CODE + 2n, ram: '3412' },
        );
      },
    },
    {
      name: 'data failures preserve stores and follow range-canonical-mapping priority',
      run: async () => {
        const cases = [
          {
            pointer: 0xfffffffffffffffcn,
            ramBase: 0xfffffffffffffffcn,
            ram: 'aabbccdd',
            cause: 'address-range',
            failing: 1n << 64n,
          },
          {
            pointer: 0x7ffffffffffcn,
            ramBase: 0x7ffffffffffcn,
            ram: 'aabbccdd',
            cause: 'noncanonical',
            failing: 0x800000000000n,
          },
          { pointer: DATA, ramBase: DATA, ram: 'aabbccdd', cause: 'unmapped', failing: DATA + 4n },
          {
            pointer: CODE - 4n,
            ramBase: CODE - 4n,
            ram: 'aabbccdd',
            cause: 'permission',
            failing: CODE,
          },
        ] as const;
        for (const item of cases)
          await using(
            '488903',
            async (cpu) => {
              const input = initial(CODE, { 3: item.pointer }, 0x8d7n);
              cpu.setState(input);
              const result = await cpu.run({ budget: 5n });
              exit(result, 'data-fault', 5n, 0n, input);
              fault(result, {
                instructionPc: CODE,
                address: item.pointer,
                width: 8,
                access: 'write',
                cause: item.cause,
                failingAddress: item.failing,
              });
              memory(cpu, item.ramBase, item.ram);
            },
            { ramBase: item.ramBase, ram: item.ram },
          );
      },
    },
    {
      name: 'repair and resume do not replay a completed earlier store',
      run: async () => {
        await using('488903488b16', async (cpu) => {
          const input = initial(CODE, { 0: 0xaabbccdd89abcdefn, 6: 0x7000n }, 0x8d7n);
          cpu.setState(input);
          const failed = await cpu.run({ budget: 5n });
          exit(failed, 'data-fault', 5n, 1n, changed(input, CODE + 3n));
          fault(failed, {
            instructionPc: CODE + 3n,
            address: 0x7000n,
            width: 8,
            access: 'read',
            cause: 'unmapped',
            failingAddress: 0x7000n,
          });
          memory(cpu, DATA - 8n, '1011121314151617efcdab89ddccbbaaf0f1f2f3f4f5f6f7');
          cpu.writeMemory(DATA, hex('0807060504030201'));
          const repaired = changed(input, CODE + 3n, { 6: DATA });
          cpu.setState(repaired);
          exit(
            await cpu.run({ budget: 1n }),
            'budget',
            1n,
            1n,
            changed(repaired, CODE + 6n, { 2: 0x0102030405060708n }),
          );
          memory(cpu, DATA - 8n, '10111213141516170807060504030201f0f1f2f3f4f5f6f7');
        });
      },
    },
  ];
}
