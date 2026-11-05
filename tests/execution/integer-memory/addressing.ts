import { createFixture, type Scenario, CODE, changed, exit, memory } from '../fixture.js';
import { frame, input, noFault } from './fixture.js';

export function addressingScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'integer reads and writes retain every existing address expression and displacement sign',
      run: async () => {
        const addresses: { tail: string; extension: number; registers: Record<number, bigint> }[] =
          [
            { tail: '03', extension: 0, registers: {} },
            { tail: '43f0', extension: 0, registers: { 3: 0x4020n } },
            { tail: '83f0ffffff', extension: 0, registers: { 3: 0x4020n } },
            { tail: '4500', extension: 0, registers: { 5: 0x4010n } },
            { tail: '4500', extension: 1, registers: { 13: 0x4010n } },
            { tail: '0424', extension: 0, registers: { 4: 0x4010n } },
            { tail: '0424', extension: 1, registers: { 12: 0x4010n } },
            { tail: '040b', extension: 0, registers: { 3: 0x4000n, 1: 16n } },
            { tail: '044b', extension: 0, registers: { 3: 0x4000n, 1: 8n } },
            { tail: '048b', extension: 0, registers: { 3: 0x4000n, 1: 4n } },
            { tail: '04cb', extension: 0, registers: { 3: 0x4000n, 1: 2n } },
            { tail: '04e3', extension: 0, registers: { 4: 0x800000000000n } },
            { tail: '0423', extension: 2, registers: { 3: 0x4000n, 12: 16n } },
            { tail: '042510400000', extension: 1, registers: { 13: 0x800000000000n } },
            { tail: '048508400000', extension: 0, registers: {} },
            { tail: '04cb', extension: 0, registers: { 3: 0xfffffffffffffff0n, 1: 0x804n } },
          ];
        for (const width of [32, 64])
          for (const address of addresses)
            for (const writeMemory of [false, true]) {
              const rex = 0x40 | (width === 64 ? 8 : 0) | address.extension;
              const code = `${rex === 0x40 ? '' : rex.toString(16)}${writeMemory ? '01' : '03'}${address.tail}`;
              const word = width === 64 ? '0100000000000000' : '01000000';
              await using(
                code,
                async (cpu) => {
                  const before = input(CODE, { 0: 2n, ...address.registers });
                  cpu.setState(before);
                  const result = await cpu.run({ budget: 1n });
                  exit(
                    result,
                    'budget',
                    1n,
                    1n,
                    changed(
                      before,
                      CODE + BigInt(code.length / 2),
                      writeMemory ? {} : { 0: 3n },
                      6n,
                    ),
                  );
                  noFault(result);
                  memory(
                    cpu,
                    0x4000n,
                    frame(writeMemory ? (width === 64 ? '0300000000000000' : '03000000') : word),
                  );
                },
                { ramBase: 0x4000n, ram: frame(word) },
              );
            }
      },
    },
    {
      name: 'integer memory operands read incoming source base and index values before alias writes',
      run: async () => {
        const packets: {
          code: string;
          registers: Record<number, bigint>;
          writes: Record<number, bigint>;
          word: string;
          stored?: string;
          ramBase: bigint;
        }[] = [
          {
            code: '48011b',
            registers: {},
            writes: {},
            word: '0100000000000000',
            stored: '1140000000000000',
            ramBase: 0x4000n,
          },
          {
            code: '48010c8b',
            registers: { 3: 0x4000n, 1: 4n },
            writes: {},
            word: '0100000000000000',
            stored: '0500000000000000',
            ramBase: 0x4000n,
          },
          {
            code: '010c8b',
            registers: { 3: 0x4000n, 1: 0x100000004n },
            writes: {},
            word: '01000000',
            stored: '05000000',
            ramBase: 0x400004000n,
          },
          {
            code: '031b',
            registers: { 3: 0x100004010n },
            writes: { 3: 0x4011n },
            word: '01000000',
            ramBase: 0x100004000n,
          },
          {
            code: '48031b',
            registers: { 3: 0x100004010n },
            writes: { 3: 0x100004011n },
            word: '0100000000000000',
            ramBase: 0x100004000n,
          },
          {
            code: '030c8b',
            registers: { 3: 0x4000n, 1: 0x100000004n },
            writes: { 1: 5n },
            word: '01000000',
            ramBase: 0x400004000n,
          },
          {
            code: '48030c8b',
            registers: { 3: 0x4000n, 1: 0x100000004n },
            writes: { 1: 0x100000005n },
            word: '0100000000000000',
            ramBase: 0x400004000n,
          },
          {
            code: '45036d00',
            registers: { 13: 0x100004010n },
            writes: { 13: 0x4011n },
            word: '01000000',
            ramBase: 0x100004000n,
          },
        ];
        for (const packet of packets)
          await using(
            packet.code,
            async (cpu) => {
              const before = input(CODE, packet.registers);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(
                result,
                'budget',
                1n,
                1n,
                changed(before, CODE + BigInt(packet.code.length / 2), packet.writes, 6n),
              );
              noFault(result);
              memory(cpu, packet.ramBase, frame(packet.stored ?? packet.word));
            },
            { ramBase: packet.ramBase, ram: frame(packet.word) },
          );
      },
    },
    {
      name: 'integer memory widths may end at the final u64 byte without widening the operand',
      run: async () => {
        for (const width of [32, 64])
          for (const writeMemory of [false, true]) {
            const word = width === 64 ? '0100000000000000' : '01000000';
            const code = `${width === 64 ? '48' : ''}${writeMemory ? '01' : '03'}03`;
            const pointer = width === 64 ? 0xfffffffffffffff8n : 0xfffffffffffffffcn;
            const offset = width === 64 ? 8 : 12;
            await using(
              code,
              async (cpu) => {
                const before = input(CODE, { 0: 2n, 3: pointer });
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(
                  result,
                  'budget',
                  1n,
                  1n,
                  changed(before, CODE + BigInt(code.length / 2), writeMemory ? {} : { 0: 3n }, 6n),
                );
                noFault(result);
                memory(
                  cpu,
                  0xfffffffffffffff0n,
                  frame(
                    writeMemory ? (width === 64 ? '0300000000000000' : '03000000') : word,
                    offset,
                    16,
                  ),
                );
              },
              { ramBase: 0xfffffffffffffff0n, ram: frame(word, offset, 16) },
            );
          }
      },
    },
  ];
}
