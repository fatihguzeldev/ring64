import {
  createFixture,
  type Scenario,
  CODE,
  DATA,
  FRAME,
  memory,
  initial,
  changed,
  exit,
} from '../../support/fixture.js';

export function registerScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'MOV forms execute both widths and register directions',
      run: async () => {
        const cases = [
          { code: 'b8efcdab89', dst: 0, value: 0x89abcdefn },
          { code: '41bfffffffff', dst: 15, value: 0xffffffffn },
          { code: '4fb88877665544332211', dst: 8, value: 0x1122334455667788n },
          { code: '89d0', dst: 0, value: 0x89abcdefn },
          { code: '8bc2', dst: 0, value: 0x89abcdefn },
          { code: '4889d0', dst: 0, value: 0xaabbccdd89abcdefn },
          { code: '488bc2', dst: 0, value: 0xaabbccdd89abcdefn },
          { code: '4589c8', dst: 8, value: 0x89abcdefn },
          { code: '4d8bc1', dst: 8, value: 0xaabbccdd89abcdefn },
        ];
        for (const item of cases)
          await using(item.code, async (cpu) => {
            const input = initial(CODE, { 2: 0xaabbccdd89abcdefn, 9: 0xaabbccdd89abcdefn }, 0x8d7n);
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
      },
    },
    {
      name: 'register arithmetic preserves width, flags and CMP operands',
      run: async () => {
        const cases = [
          { code: '01d0', a: 0x11223344ffffffffn, b: 1n, value: 0n, flags: 0x57n },
          { code: '4801d0', a: 0xffffffffffffffffn, b: 1n, value: 0n, flags: 0x57n },
          { code: '29d0', a: 0x1122334400000000n, b: 1n, value: 0xffffffffn, flags: 0x97n },
          { code: '4829d0', a: 0n, b: 1n, value: 0xffffffffffffffffn, flags: 0x97n },
          { code: '39d0', a: 0x1122334400000000n, b: 1n, value: 0x1122334400000000n, flags: 0x97n },
          { code: '4839d0', a: 0n, b: 1n, value: 0n, flags: 0x97n },
          { code: '01d0', a: 0x7fffffffn, b: 1n, value: 0x80000000n, flags: 0x896n },
          {
            code: '4801d0',
            a: 0x7fffffffffffffffn,
            b: 1n,
            value: 0x8000000000000000n,
            flags: 0x896n,
          },
          { code: '29d0', a: 0x80000000n, b: 1n, value: 0x7fffffffn, flags: 0x816n },
          {
            code: '4829d0',
            a: 0x8000000000000000n,
            b: 1n,
            value: 0x7fffffffffffffffn,
            flags: 0x816n,
          },
          { code: '4801c0', a: 0x8000000000000000n, b: 0n, value: 0n, flags: 0x847n },
        ];
        for (const item of cases)
          await using(item.code, async (cpu) => {
            const input = initial(CODE, { 0: item.a, 2: item.b });
            cpu.setState(input);
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(input, CODE + BigInt(item.code.length / 2), { 0: item.value }, item.flags),
            );
            memory(cpu, DATA - 8n, FRAME);
          });
        await using('4539c8', async (cpu) => {
          const input = initial(CODE, { 8: 0x1122334400000000n, 9: 0xaabbccdd00000001n });
          cpu.setState(input);
          exit(
            await cpu.run({ budget: 1n }),
            'budget',
            1n,
            1n,
            changed(input, CODE + 3n, {}, 0x97n),
          );
          memory(cpu, DATA - 8n, FRAME);
        });
      },
    },
    {
      name: 'signed immediate arithmetic executes every selected group and width',
      run: async () => {
        for (const width of [32, 64])
          for (const opcode of ['81', '83'])
            for (const kind of ['add', 'sub', 'cmp']) {
              const selector = kind === 'add' ? 'c0' : kind === 'sub' ? 'e8' : 'f8';
              const code = `${width === 64 ? '48' : ''}${opcode}${selector}${opcode === '81' ? 'ffffffff' : 'ff'}`;
              await using(code, async (cpu) => {
                const inputValue = width === 32 ? 0x1122334400000000n : 0n;
                const value =
                  kind === 'cmp'
                    ? inputValue
                    : kind === 'sub'
                      ? 1n
                      : width === 32
                        ? 0xffffffffn
                        : 0xffffffffffffffffn;
                const input = initial(CODE, { 0: inputValue });
                cpu.setState(input);
                exit(
                  await cpu.run({ budget: 1n }),
                  'budget',
                  1n,
                  1n,
                  changed(
                    input,
                    CODE + BigInt(code.length / 2),
                    { 0: value },
                    kind === 'add' ? 0x86n : 0x13n,
                  ),
                );
                memory(cpu, DATA - 8n, FRAME);
              });
            }
        for (const item of [
          { code: '4c83c001', input: 0n, value: 1n, flags: 2n },
          { code: '4883c000', input: 0x100n, value: 0x100n, flags: 6n },
          { code: '4883c080', input: 0n, value: 0xffffffffffffff80n, flags: 0x82n },
          { code: '4881c000000080', input: 0n, value: 0xffffffff80000000n, flags: 0x86n },
          { code: '4881c0ffffff7f', input: 0n, value: 0x7fffffffn, flags: 6n },
        ])
          await using(item.code, async (cpu) => {
            const input = initial(CODE, { 0: item.input }, 0x8d7n);
            cpu.setState(input);
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(input, CODE + BigInt(item.code.length / 2), { 0: item.value }, item.flags),
            );
          });
      },
    },
  ];
}
