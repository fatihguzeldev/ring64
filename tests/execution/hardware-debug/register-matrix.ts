import { using, initial, equal, same, type Scenario } from '../exception-delivery/fixture.js';
import { profiles } from '../far-control/fixture.js';
export function registerMatrixScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'hardware debug literal MOVDR matrix covers every GPR register direction mode and ignored width prefix',
      async run() {
        for (const context of profiles().filter((c) => c.mode !== 'virtual8086')) {
          const long = context.mode === 'long64';
          const cases: { dr: number; gpr: number; write: boolean; code: string; pc: bigint }[] = [];
          let code = '';
          for (const dr of [0, 1, 2, 3, 6, 7])
            for (const write of [false, true])
              for (let gpr = 0; gpr < (long ? 16 : 8); gpr++) {
                const modrm = ((gpr & 3) << 6) | (dr << 3) | (gpr & 7);
                const bytes =
                  '66' +
                  (long ? (gpr < 8 ? '48' : '49') : '') +
                  '0f' +
                  (write ? '23' : '21') +
                  modrm.toString(16).padStart(2, '0');
                cases.push({ dr, gpr, write, code: bytes, pc: 0x1000n + BigInt(code.length / 2) });
                code += bytes;
              }
          await using(compiler, code, context, async (cpu) => {
            for (const c of cases) {
              const input = c.dr === 6 ? 0x200fn : c.dr === 7 ? 0x7ffn : 0x11223344deadbeefn;
              const original = {
                addresses: [0xa0n, 0xa1n, 0xa2n, 0xa3n],
                dr6: 0xe000n,
                dr7: 0x400n,
              };
              cpu.setDebugState(original);
              const bank = cpu.readDebugState();
              const before = initial(c.pc, { [c.gpr]: input }, 0x8d7n);
              cpu.setState(before);
              const r = await cpu.run({ budget: 1n });
              equal(
                r.reason,
                'budget',
                `MOVDR ${context.mode} DR${c.dr} GPR${c.gpr} write${c.write}`,
              );
              equal(r.retired, 1n, 'one transfer');
              equal(r.state.rip, c.pc + BigInt(c.code.length / 2), 'no address tail');
              equal(r.state.flags, 0x8d7n, 'undefined flag preservation');
              const registers = before.registers.slice();
              const expected = { ...bank, addresses: bank.addresses.slice() };
              if (c.write) {
                const value = long ? input : input & 0xffffffffn;
                if (c.dr < 4) expected.addresses[c.dr] = value;
                else if (c.dr === 6) expected.dr6 = 0xffff2fffn;
                else expected.dr7 = 0x7ffn;
              } else {
                const value = c.dr < 4 ? bank.addresses[c.dr]! : c.dr === 6 ? bank.dr6 : bank.dr7;
                registers[c.gpr] = long ? value : (input & ~0xffffffffn) | value;
              }
              same(r.state.registers, registers, 'exact GPR bank');
              same(cpu.readDebugState(), expected, 'exact debug bank');
            }
          });
        }
      },
    },
  ];
}
