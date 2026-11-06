import {
  CODE,
  changed,
  createFixture,
  equal,
  exit,
  memory,
  type Scenario,
} from '../../../support/fixture.js';
import { hex } from '../../../support/fixture.js';
import { carry } from '../arithmetic/oracle.js';
import { input, little, modrm, noFault, paired, prefix, RAM, setup, written } from './fixture.js';
import { multiply } from './oracle.js';

export function multiplyConsumerScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'every multiply form supplies live carry and overflow to SETcc CMOVcc and branch consumers',
      run: async () => {
        for (const width of [8, 16, 32, 64])
          for (const kind of width === 8 ? ['mul', 'one'] : ['mul', 'one', 'two', '69', '6b']) {
            const isSigned = kind !== 'mul';
            const code =
              prefix(width) +
              (kind === 'mul' || kind === 'one'
                ? (width === 8 ? 'f6' : 'f7') + modrm(kind === 'mul' ? 4 : 5, 1)
                : (kind === 'two' ? '0faf' : kind) +
                  'c1' +
                  (kind === 'two' ? '' : little(-1n, kind === '6b' ? 1 : Math.min(width, 32) / 8)));
            const image = code + '410f92c0410f90c14d0f42d3720341fec4';
            const end = CODE + BigInt(image.length / 2);
            await using(
              image,
              async (cpu) => {
                for (const overflow of [false, true]) {
                  const a = overflow
                    ? isSigned
                      ? 2n ** BigInt(width - 1)
                      : 2n ** BigInt(width) - 1n
                    : 1n;
                  const b = isSigned ? -1n : 2n;
                  const registers = {
                    0: BigInt.asUintN(64, a),
                    1: BigInt.asUintN(64, kind === '69' || kind === '6b' ? a : b),
                    12: 0x112233440000000fn,
                  };
                  const before = input(CODE, registers);
                  const answer = multiply(a, b, width, isSigned);
                  equal(answer.flags, overflow ? 0x803n : 2n, 'literal overflow distinction');
                  const writes =
                    kind === 'mul' || kind === 'one'
                      ? paired(before, width, answer)
                      : { 0: written(before.registers[0]!, answer.low, width) };
                  cpu.writeMemory(setup.ramBase, hex(RAM));
                  cpu.setState(before);
                  const result = await cpu.run({ budget: 7n, stop: end });
                  exit(
                    result,
                    'stop',
                    7n,
                    overflow ? 5n : 6n,
                    changed(
                      before,
                      end,
                      {
                        ...writes,
                        8: written(before.registers[8]!, overflow ? 1n : 0n, 8),
                        9: written(before.registers[9]!, overflow ? 1n : 0n, 8),
                        10: before.registers[overflow ? 11 : 10]!,
                        12: overflow ? before.registers[12]! : 0x1122334400000010n,
                      },
                      result.state.flags,
                    ),
                  );
                  equal(result.state.flags & ~0x8d7n, 0n, 'concrete flags stay valid');
                  equal(result.state.flags & 2n, 2n, 'fixed flag bit');
                  equal(
                    result.state.flags & (overflow ? 0x803n : 0x8d7n),
                    overflow ? 0x803n : 0x12n,
                    'live producer conditions precede the path writer',
                  );
                  noFault(result);
                  equal(
                    result.resources.nativeEntries,
                    1,
                    'multiply and consumers share a native entry',
                  );
                  equal(
                    result.resources.compilations,
                    overflow ? 0 : 1,
                    'changed operands reuse the chain',
                  );
                  memory(cpu, setup.ramBase, RAM);
                  memory(cpu, CODE, image);
                }
              },
              setup,
            );
            for (const subtract of [false, true])
              await using(
                code + (subtract ? '4819d0' : '4811d0'),
                async (cpu) => {
                  for (const overflow of [false, true]) {
                    const a = overflow
                      ? isSigned
                        ? 2n ** BigInt(width - 1)
                        : 2n ** BigInt(width) - 1n
                      : 1n;
                    const b = isSigned ? -1n : 2n;
                    const before = input(CODE, {
                      0: BigInt.asUintN(64, a),
                      1: BigInt.asUintN(64, kind === '69' || kind === '6b' ? a : b),
                    });
                    const product = multiply(a, b, width, isSigned);
                    const writes =
                      kind === 'mul' || kind === 'one'
                        ? paired(before, width, product)
                        : { 0: written(before.registers[0]!, product.low, width) };
                    const produced = changed(before, CODE, writes, product.flags);
                    const answer = carry(
                      produced.registers[0]!,
                      produced.registers[2]!,
                      64,
                      product.flags,
                      subtract,
                    );
                    cpu.setState(before);
                    const result = await cpu.run({ budget: 2n });
                    exit(
                      result,
                      'budget',
                      2n,
                      2n,
                      changed(
                        produced,
                        CODE + BigInt(code.length / 2 + 3),
                        { 0: answer.result },
                        answer.flags,
                      ),
                    );
                    noFault(result);
                    equal(
                      result.resources.compilations,
                      overflow ? 0 : 1,
                      'carry consumer reuses its producer',
                    );
                    memory(cpu, setup.ramBase, RAM);
                    memory(cpu, CODE, code + (subtract ? '4819d0' : '4811d0'));
                  }
                },
                setup,
              );
          }
        for (const subtract of [false, true]) {
          const code = '48f7e1' + (subtract ? '4819d0' : '4811d0');
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, { 0: 0xffffffffffffffffn, 1: 2n });
              cpu.setState(before);
              const result = await cpu.run({ budget: 2n });
              exit(
                result,
                'budget',
                2n,
                2n,
                changed(
                  before,
                  0x1006n,
                  { 0: subtract ? 0xfffffffffffffffcn : 0n, 2: 1n },
                  subtract ? 0x86n : 0x57n,
                ),
              );
              noFault(result);
              memory(cpu, setup.ramBase, RAM);
              memory(cpu, CODE, code);
            },
            setup,
          );
        }
      },
    },
  ];
}
