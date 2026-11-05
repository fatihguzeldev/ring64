import { createFixture, type Scenario, CODE, changed, exit, memory } from '../fixture.js';
import { frame, input, logicalExit, noFault } from './fixture.js';

export function operandScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'all register-memory integer encodings execute both widths and operand orders',
      run: async () => {
        for (const operation of [
          {
            memory: '01',
            register: '03',
            m32: '0101ffff',
            r32: 0xffff0101n,
            fm32: 0x82n,
            fr32: 0x82n,
            m64: '0101ffff2100debb',
            r64: 0xbbde0021ffff0101n,
            fm64: 0x82n,
            fr64: 0x82n,
            logical: false,
          },
          {
            memory: '29',
            register: '2b',
            m32: '01001f1e',
            r32: 0xe1e0ffffn,
            fm32: 3n,
            fr32: 0x96n,
            m64: '01001f1e98999999',
            r64: 0x66666667e1e0ffffn,
            fm64: 0x82n,
            fr64: 0x17n,
            logical: false,
          },
          {
            memory: '39',
            register: '3b',
            m32: '81000f0f',
            r32: 0n,
            fm32: 3n,
            fr32: 0x96n,
            m64: '81000f0fddccbbaa',
            r64: 0n,
            fm64: 0x82n,
            fr64: 0x17n,
            logical: false,
          },
          {
            memory: '21',
            register: '23',
            m32: '80000000',
            r32: 0x80n,
            fm32: 2n,
            fr32: 2n,
            m64: '8000000044002200',
            r64: 0x0022004400000080n,
            fm64: 2n,
            fr64: 2n,
            logical: true,
          },
          {
            memory: '09',
            register: '0b',
            m32: '8100ffff',
            r32: 0xffff0081n,
            fm32: 0x86n,
            fr32: 0x86n,
            m64: '8100ffffddffbbbb',
            r64: 0xbbbbffddffff0081n,
            fm64: 0x86n,
            fr64: 0x86n,
            logical: true,
          },
          {
            memory: '31',
            register: '33',
            m32: '0100ffff',
            r32: 0xffff0001n,
            fm32: 0x82n,
            fr32: 0x82n,
            m64: '0100ffff99ff99bb',
            r64: 0xbb99ff99ffff0001n,
            fm64: 0x82n,
            fr64: 0x82n,
            logical: true,
          },
          {
            memory: '85',
            register: '',
            m32: '81000f0f',
            r32: 0n,
            fm32: 2n,
            fr32: 2n,
            m64: '81000f0fddccbbaa',
            r64: 0n,
            fm64: 2n,
            fr64: 2n,
            logical: true,
          },
        ])
          for (const width of [32, 64])
            for (const register of [0, 8])
              for (const direction of ['memory', 'register'] as const) {
                const opcode = operation[direction];
                if (!opcode) continue;
                const prefix =
                  register === 8 ? (width === 64 ? '4c' : '44') : width === 64 ? '48' : '';
                const code = prefix + opcode + '03';
                const word = width === 64 ? '81000f0fddccbbaa' : '81000f0f';
                const writes = direction === 'register' && opcode !== '3b';
                await using(
                  code,
                  async (cpu) => {
                    const before = input(CODE, { [register]: 0x11223344f0f00080n });
                    cpu.setState(before);
                    const result = await cpu.run({ budget: 1n });
                    const assertExit = operation.logical ? logicalExit : exit;
                    const flags =
                      direction === 'memory'
                        ? width === 64
                          ? operation.fm64
                          : operation.fm32
                        : width === 64
                          ? operation.fr64
                          : operation.fr32;
                    assertExit(
                      result,
                      'budget',
                      1n,
                      1n,
                      changed(
                        before,
                        CODE + BigInt(code.length / 2),
                        writes ? { [register]: width === 64 ? operation.r64 : operation.r32 } : {},
                        flags,
                      ),
                    );
                    noFault(result);
                    memory(
                      cpu,
                      0x4000n,
                      frame(
                        direction === 'memory'
                          ? width === 64
                            ? operation.m64
                            : operation.m32
                          : word,
                      ),
                    );
                  },
                  { ramBase: 0x4000n, ram: frame(word) },
                );
              }
      },
    },
    {
      name: 'all immediate-memory selectors sign extend and ignore REX register extensions',
      run: async () => {
        for (const operation of [
          {
            selector: '03',
            m32: '80000f0f',
            f32: 0x13n,
            m64: '80000f0fddccbbaa',
            f64: 0x93n,
            logical: false,
            test: false,
          },
          {
            selector: '2b',
            m32: '82000f0f',
            f32: 0x17n,
            m64: '82000f0fddccbbaa',
            f64: 0x97n,
            logical: false,
            test: false,
          },
          {
            selector: '3b',
            m32: '81000f0f',
            f32: 0x17n,
            m64: '81000f0fddccbbaa',
            f64: 0x97n,
            logical: false,
            test: false,
          },
          {
            selector: '23',
            m32: '81000f0f',
            f32: 6n,
            m64: '81000f0fddccbbaa',
            f64: 0x86n,
            logical: true,
            test: false,
          },
          {
            selector: '0b',
            m32: 'ffffffff',
            f32: 0x86n,
            m64: 'ffffffffffffffff',
            f64: 0x86n,
            logical: true,
            test: false,
          },
          {
            selector: '33',
            m32: '7efff0f0',
            f32: 0x86n,
            m64: '7efff0f022334455',
            f64: 6n,
            logical: true,
            test: false,
          },
          {
            selector: '03',
            m32: '81000f0f',
            f32: 6n,
            m64: '81000f0fddccbbaa',
            f64: 0x86n,
            logical: true,
            test: true,
          },
        ])
          for (const width of [32, 64])
            for (const opcode of operation.test ? ['f7'] : ['81', '83']) {
              const code = `${width === 64 ? '4e' : '46'}${opcode}${operation.selector}${opcode === '83' ? 'ff' : 'ffffffff'}`;
              const word = width === 64 ? '81000f0fddccbbaa' : '81000f0f';
              await using(
                code,
                async (cpu) => {
                  const before = input();
                  cpu.setState(before);
                  const result = await cpu.run({ budget: 1n });
                  const assertExit = operation.logical ? logicalExit : exit;
                  assertExit(
                    result,
                    'budget',
                    1n,
                    1n,
                    changed(
                      before,
                      CODE + BigInt(code.length / 2),
                      {},
                      width === 64 ? operation.f64 : operation.f32,
                    ),
                  );
                  noFault(result);
                  memory(cpu, 0x4000n, frame(width === 64 ? operation.m64 : operation.m32));
                },
                { ramBase: 0x4000n, ram: frame(word) },
              );
            }
      },
    },
    {
      name: 'memory integer source and destination register fields reach all sixteen banks',
      run: async () => {
        for (const width of [32, 64])
          for (let bank = 0; bank < 16; bank++)
            for (const writeRegister of [false, true]) {
              const rex = 0x40 | (width === 64 ? 8 : 0) | (bank >= 8 ? 4 : 0) | 1;
              const modrm = (4 | ((bank & 7) << 3)).toString(16).padStart(2, '0');
              const code = `${rex.toString(16)}${writeRegister ? '2b' : '01'}${modrm}2510400000`;
              const word = width === 64 ? '81000f0fddccbbaa' : '81000f0f';
              await using(
                code,
                async (cpu) => {
                  const before = input(CODE, { [bank]: 0x11223344f0f00080n });
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
                      writeRegister
                        ? { [bank]: width === 64 ? 0x66666667e1e0ffffn : 0xe1e0ffffn }
                        : {},
                      writeRegister ? (width === 64 ? 0x17n : 0x96n) : 0x82n,
                    ),
                  );
                  noFault(result);
                  memory(
                    cpu,
                    0x4000n,
                    frame(writeRegister ? word : width === 64 ? '0101ffff2100debb' : '0101ffff'),
                  );
                },
                { ramBase: 0x4000n, ram: frame(word) },
              );
            }
      },
    },
    {
      name: 'integer memory literals retain operand direction widths and full guarded RAM',
      run: async () => {
        const packets: {
          code: string;
          registers: Record<number, bigint>;
          word: string;
          stored?: string;
          writes?: Record<number, bigint>;
          flags: bigint;
          logical?: boolean;
          ramBase?: bigint;
          offset?: number;
        }[] = [
          {
            code: '480303',
            registers: { 0: 0x7fffffff00000000n },
            word: '0000000001000000',
            writes: { 0: 0x8000000000000000n },
            flags: 0x886n,
          },
          {
            code: '0103',
            registers: { 0: 1n },
            word: 'ffffffff',
            stored: '00000000',
            flags: 0x57n,
          },
          {
            code: '291b',
            registers: { 3: 0x100004000n },
            word: '01400000',
            stored: '01000000',
            flags: 2n,
            ramBase: 0x100004000n,
            offset: 0,
          },
          {
            code: '2b1b',
            registers: { 3: 0x100004000n },
            word: '01400000',
            writes: { 3: 0xffffffffn },
            flags: 0x97n,
            ramBase: 0x100004000n,
            offset: 0,
          },
          {
            code: '4f014ca5f8',
            registers: { 13: 0x4000n, 12: 6n, 9: 1n },
            word: 'ffffffffffffffff',
            stored: '0000000000000000',
            flags: 0x57n,
          },
          {
            code: '4c8303ff',
            registers: {},
            word: '0000000000000000',
            stored: 'ffffffffffffffff',
            flags: 0x86n,
          },
          {
            code: '48812bffffffff',
            registers: {},
            word: '0000000000000000',
            stored: '0100000000000000',
            flags: 0x13n,
          },
          {
            code: '488323ff',
            registers: {},
            word: '0100000000000080',
            flags: 0x82n,
            logical: true,
          },
          {
            code: '4d090c24',
            registers: { 12: 0x4010n, 9: 1n },
            word: '0000000000000080',
            stored: '0100000000000080',
            flags: 0x82n,
            logical: true,
          },
          {
            code: '44334bfc',
            registers: { 3: 0x4014n, 9: 0xaabbccdd80000103n },
            word: '03010080',
            writes: { 9: 0n },
            flags: 0x46n,
            logical: true,
          },
          {
            code: '483103',
            registers: { 0: 0xffffffffffffffffn },
            word: 'ffffffffffffffff',
            stored: '0000000000000000',
            flags: 0x46n,
            logical: true,
          },
          { code: '3903', registers: { 0: 0x1122334400000002n }, word: '01000000', flags: 0x97n },
          { code: '3b03', registers: { 0: 0x1122334400000002n }, word: '01000000', flags: 2n },
          {
            code: '48f703ffffffff',
            registers: {},
            word: '0000000000000080',
            flags: 0x86n,
            logical: true,
          },
        ];
        for (const packet of packets) {
          const ram = frame(packet.word, packet.offset ?? 16);
          await using(
            packet.code,
            async (cpu) => {
              const before = input(CODE, packet.registers);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              const assertExit = packet.logical ? logicalExit : exit;
              assertExit(
                result,
                'budget',
                1n,
                1n,
                changed(
                  before,
                  CODE + BigInt(packet.code.length / 2),
                  packet.writes ?? {},
                  packet.flags,
                ),
              );
              noFault(result);
              memory(
                cpu,
                packet.ramBase ?? 0x4000n,
                frame(packet.stored ?? packet.word, packet.offset ?? 16),
              );
            },
            { ramBase: packet.ramBase ?? 0x4000n, ram },
          );
        }
      },
    },
    {
      name: 'RIP-relative memory immediates use the complete next instruction address',
      run: async () => {
        for (const packet of [
          { code: '830d0000000000', base: 0x1007n, word: '01000000', flags: 2n, logical: true },
          {
            code: '48833d0000000001',
            base: 0x1008n,
            word: '0100000000000000',
            flags: 0x46n,
            logical: false,
          },
          {
            code: '48813d0000000001000000',
            base: 0x100bn,
            word: '0100000000000000',
            flags: 0x46n,
            logical: false,
          },
          {
            code: '48f70500000000ffffffff',
            base: 0x100bn,
            word: '0000000000000080',
            flags: 0x86n,
            logical: true,
          },
        ])
          await using(
            packet.code,
            async (cpu) => {
              const before = input();
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              const assertExit = packet.logical ? logicalExit : exit;
              assertExit(result, 'budget', 1n, 1n, changed(before, packet.base, {}, packet.flags));
              noFault(result);
              memory(cpu, packet.base, packet.word);
            },
            { ramBase: packet.base, ram: packet.word },
          );
        await using(
          '8503',
          async (cpu) => {
            const before = input(CODE, { 3: CODE, 0: 0x11223344ffffffffn });
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            logicalExit(result, 'budget', 1n, 1n, changed(before, 0x1002n, {}, 2n));
            noFault(result);
            memory(cpu, CODE, '85033412');
          },
          { ramBase: 0x1002n, ram: '3412' },
        );
      },
    },
  ];
}
