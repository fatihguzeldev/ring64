import { type Scenario, CODE, changed, equal, exit, hex, memory } from '../fixture.js';
import { FLAGS, RAM, createStackFixture, input, noFault, stack } from './fixture.js';

export function operandScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createStackFixture(core);
  return [
    {
      name: 'stack and near-transfer literal packets preserve complete state and guarded RAM',
      run: async () => {
        const rows = [
          {
            code: '50',
            registers: { 0: 0x1122334400000000n },
            rip: 0x1001n,
            sp: 0x4018n,
            saved: 0x1122334400000000n,
          },
          { code: '54', rip: 0x1001n, sp: 0x4018n, saved: 0x4020n },
          {
            code: '4f54',
            registers: { 12: 0x0123456789abcdefn },
            rip: 0x1002n,
            sp: 0x4018n,
            saved: 0x0123456789abcdefn,
          },
          { code: '4f6a80', rip: 0x1003n, sp: 0x4018n, saved: 0xffffffffffffff80n },
          { code: '476800000080', rip: 0x1006n, sp: 0x4018n, saved: 0xffffffff80000000n },
          {
            code: '58',
            top: 0xfedcba9876543210n,
            rip: 0x1001n,
            sp: 0x4028n,
            writes: { 0: 0xfedcba9876543210n },
          },
          { code: '5c', top: 0x800000000000n, rip: 0x1001n, sp: 0x800000000000n },
          {
            code: '4f5c',
            top: 0xfedcba9876543210n,
            rip: 0x1002n,
            sp: 0x4028n,
            writes: { 12: 0xfedcba9876543210n },
          },
          { code: 'e80b000000', rip: 0x1010n, sp: 0x4018n, saved: 0x1005n },
          { code: '4fe800000000', rip: 0x1006n, sp: 0x4018n, saved: 0x1006n },
          { code: 'ffd0', registers: { 0: 0x1010n }, rip: 0x1010n, sp: 0x4018n, saved: 0x1002n },
          { code: 'ffd4', rip: 0x4020n, sp: 0x4018n, saved: 0x1002n },
          {
            code: '47ffd4',
            registers: { 12: 0xffff800000001010n },
            rip: 0xffff800000001010n,
            sp: 0x4018n,
            saved: 0x1003n,
          },
          {
            code: '47ffe4',
            registers: { 12: 0xffff800000001010n, 4: 0x800000000000n },
            rip: 0xffff800000001010n,
            sp: 0x800000000000n,
          },
          { code: 'c3', top: 0x1010n, rip: 0x1010n, sp: 0x4028n },
          { code: '4fc20080', top: 0x1010n, rip: 0x1010n, sp: 0xc028n },
        ];
        for (const row of rows) {
          const original = row.top === undefined ? RAM : stack(row.top);
          await using(
            row.code,
            async (cpu) => {
              const before = input(CODE, row.registers);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(
                result,
                'budget',
                1n,
                1n,
                changed(before, row.rip, { ...row.writes, 4: row.sp }),
              );
              noFault(result);
              memory(cpu, CODE, row.code);
              memory(cpu, 0x4000n, row.saved === undefined ? original : stack(row.saved, 24));
            },
            { ram: original },
          );
        }
      },
    },
    {
      name: 'all sixteen stack and indirect register selections retain full 64-bit bank values',
      run: async () => {
        for (let register = 0; register < 16; register++) {
          const prefix = register >= 8 ? '41' : '';
          const low = register & 7;
          for (const operation of ['push', 'pop', 'call', 'jump'] as const) {
            const opcode =
              operation === 'push' ? 0x50 + low : operation === 'pop' ? 0x58 + low : 0xff;
            const code =
              prefix +
              opcode.toString(16) +
              (operation === 'call'
                ? (0xd0 + low).toString(16)
                : operation === 'jump'
                  ? (0xe0 + low).toString(16)
                  : '');
            const target = register === 4 ? 0x4020n : 0xffff800000001010n;
            const value =
              operation === 'call' || operation === 'jump' ? target : 0xfedcba9876543210n;
            const original = stack(0x0123456789abcdefn);
            await using(
              code,
              async (cpu) => {
                const before = input(CODE, register === 4 ? {} : { [register]: value });
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                const next = CODE + BigInt(code.length / 2);
                const writes =
                  operation === 'pop'
                    ? {
                        [register]: 0x0123456789abcdefn,
                        4: register === 4 ? 0x0123456789abcdefn : 0x4028n,
                      }
                    : operation === 'push' || operation === 'call'
                      ? { 4: 0x4018n }
                      : {};
                exit(
                  result,
                  'budget',
                  1n,
                  1n,
                  changed(
                    before,
                    operation === 'call' || operation === 'jump' ? target : next,
                    writes,
                  ),
                );
                noFault(result);
                const saved =
                  operation === 'push'
                    ? before.registers[register]!
                    : operation === 'call'
                      ? next
                      : undefined;
                memory(
                  cpu,
                  0x4000n,
                  saved === undefined
                    ? original
                    : stack(saved, 24).slice(0, 64) + original.slice(64),
                );
                memory(cpu, CODE, code);
              },
              { ram: original },
            );
          }
        }
      },
    },
    {
      name: 'every single REX field combination is ignored or selects the documented stack bank',
      run: async () => {
        for (let rex = 0x40; rex <= 0x4f; rex++) {
          const prefix = rex.toString(16);
          const register = rex & 1 ? 12 : 4;
          for (const operation of ['54', '5c', 'ffd4', 'ffe4']) {
            const code = prefix + operation;
            await using(
              code,
              async (cpu) => {
                const before = input(CODE, { 12: 0xffff800000001010n });
                const selected = before.registers[register]!;
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                const next = CODE + BigInt(code.length / 2);
                const writes =
                  operation === '5c'
                    ? { [register]: 0x1010n, 4: register === 4 ? 0x1010n : 0x4028n }
                    : operation === '54' || operation === 'ffd4'
                      ? { 4: 0x4018n }
                      : {};
                exit(
                  result,
                  'budget',
                  1n,
                  1n,
                  changed(before, operation.startsWith('ff') ? selected : next, writes),
                );
                noFault(result);
                const original = stack(0x1010n);
                memory(
                  cpu,
                  0x4000n,
                  operation === '54' || operation === 'ffd4'
                    ? stack(operation === '54' ? selected : next, 24).slice(0, 64) +
                        original.slice(64)
                    : original,
                );
                memory(cpu, CODE, code);
              },
              { ram: stack(0x1010n) },
            );
          }
        }
      },
    },
    {
      name: 'signed PUSH immediates and unsigned RET cleanup retain their stack-specific widths',
      run: async () => {
        for (const row of [
          { code: '6a00', value: 0n },
          { code: '6a7f', value: 127n },
          { code: '6a80', value: 0xffffffffffffff80n },
          { code: '6aff', value: 0xffffffffffffffffn },
          { code: '6800000000', value: 0n },
          { code: '68ffffff7f', value: 0x7fffffffn },
          { code: '6800000080', value: 0xffffffff80000000n },
          { code: '68ffffffff', value: 0xffffffffffffffffn },
        ])
          for (const prefix of ['', '40', '4f']) {
            const code = prefix + row.code;
            await using(code, async (cpu) => {
              const before = input();
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(
                result,
                'budget',
                1n,
                1n,
                changed(before, CODE + BigInt(code.length / 2), { 4: 0x4018n }),
              );
              noFault(result);
              memory(cpu, 0x4000n, stack(row.value, 24));
              memory(cpu, CODE, code);
            });
          }
        for (const row of [
          { code: 'c20000', sp: 0x4028n },
          { code: 'c2ff7f', sp: 0xc027n },
          { code: 'c20080', sp: 0xc028n },
          { code: 'c2ffff', sp: 0x14027n },
        ])
          for (const prefix of ['', '40', '4f']) {
            await using(
              prefix + row.code,
              async (cpu) => {
                const before = input();
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(result, 'budget', 1n, 1n, changed(before, 0x1010n, { 4: row.sp }));
                noFault(result);
                memory(cpu, 0x4000n, stack(0x1010n));
                memory(cpu, CODE, prefix + row.code);
              },
              { ram: stack(0x1010n) },
            );
          }
      },
    },
    {
      name: 'cached stack and transfer instructions preserve each imported flag independently',
      run: async () => {
        for (const code of [
          '54',
          '5c',
          '6aff',
          '68ffffffff',
          'e800000000',
          'ffd0',
          'ffe0',
          'c3',
          'c2ffff',
        ]) {
          await using(
            code,
            async (cpu) => {
              for (const flags of FLAGS) {
                cpu.writeMemory(0x4000n, hex(stack(0x1010n)));
                const before = input(CODE, { 0: 0x1010n }, flags);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                const pushes =
                  code === '54' || code.startsWith('6') || code.startsWith('e8') || code === 'ffd0';
                const next = CODE + BigInt(code.length / 2);
                const rip =
                  code === 'ffd0' || code === 'ffe0' || code.startsWith('c') ? 0x1010n : next;
                const sp =
                  code === '5c'
                    ? 0x1010n
                    : code === 'c3'
                      ? 0x4028n
                      : code === 'c2ffff'
                        ? 0x14027n
                        : pushes
                          ? 0x4018n
                          : 0x4020n;
                exit(result, 'budget', 1n, 1n, changed(before, rip, { 4: sp }));
                noFault(result);
                if (flags !== FLAGS[0])
                  equal(result.resources.compilations, 0, 'flag changes reuse the artifact');
                const saved =
                  code === '54' ? 0x4020n : code.startsWith('6') ? 0xffffffffffffffffn : next;
                memory(
                  cpu,
                  0x4000n,
                  pushes
                    ? stack(saved, 24).slice(0, 64) + stack(0x1010n).slice(64)
                    : stack(0x1010n),
                );
                memory(cpu, CODE, code);
              }
            },
            { ram: stack(0x1010n) },
          );
        }
      },
    },
  ];
}
