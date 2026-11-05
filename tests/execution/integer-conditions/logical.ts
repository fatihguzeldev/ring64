import {
  createFixture,
  type Scenario,
  CODE,
  changed,
  equal,
  exit,
  fault,
  memory,
} from '../fixture.js';
import { defaultRam, input, logicalExit, noFault } from './fixture.js';

export function logicalScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'logical register forms distinguish both destinations and operand widths',
      run: async () => {
        for (const operation of [
          { opcodes: ['21d0', '23c2'], narrow: 0x80n, wide: 0x0022004400000080n, flags: 2n },
          {
            opcodes: ['09d0', '0bc2'],
            narrow: 0xffff0081n,
            wide: 0xbbbbffddffff0081n,
            flags: 0x86n,
          },
          {
            opcodes: ['31d0', '33c2'],
            narrow: 0xffff0001n,
            wide: 0xbb99ff99ffff0001n,
            flags: 0x82n,
          },
        ])
          for (const width of [32, 64])
            for (const extended of [false, true])
              for (const opcode of operation.opcodes) {
                const prefix = extended ? (width === 64 ? '4d' : '45') : width === 64 ? '48' : '';
                const code = prefix + opcode;
                const dst = extended ? 8 : 0;
                const src = extended ? 10 : 2;
                await using(
                  code,
                  async (cpu) => {
                    const before = input(CODE, {
                      [dst]: 0x11223344f0f00080n,
                      [src]: 0xaabbccdd0f0f0081n,
                    });
                    cpu.setState(before);
                    const result = await cpu.run({ budget: 1n });
                    logicalExit(
                      result,
                      'budget',
                      1n,
                      1n,
                      changed(
                        before,
                        CODE + BigInt(code.length / 2),
                        {
                          [dst]: width === 32 ? operation.narrow : operation.wide,
                        },
                        operation.flags,
                      ),
                    );
                    noFault(result);
                    memory(cpu, 0x4000n, '00');
                  },
                  defaultRam,
                );
              }
      },
    },
    {
      name: 'logical aliases write all sixteen banks without changing neighboring banks',
      run: async () => {
        for (const width of [32, 64])
          for (let bank = 0; bank < 16; bank++) {
            const prefix = bank >= 8 ? (width === 64 ? '4d' : '45') : width === 64 ? '48' : '';
            const selector = (0xc0 | ((bank & 7) << 3) | (bank & 7)).toString(16);
            const code = `${prefix}31${selector}`;
            await using(
              code,
              async (cpu) => {
                const before = input(CODE, { [bank]: 0x1122334480000103n });
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                logicalExit(
                  result,
                  'budget',
                  1n,
                  1n,
                  changed(before, CODE + BigInt(code.length / 2), { [bank]: 0n }, 0x46n),
                );
                noFault(result);
                memory(cpu, 0x4000n, '00');
              },
              defaultRam,
            );
          }
      },
    },
    {
      name: 'logical immediate groups sign extend at both widths and ignore selector extensions',
      run: async () => {
        for (const width of [32, 64])
          for (const opcode of ['81', '83'])
            for (const operation of [
              {
                selector: 'e0',
                narrow: 0n,
                wide: 0x1122334400000000n,
                narrowFlags: 0x46n,
                wideFlags: 6n,
              },
              {
                selector: 'c8',
                narrow: 0xffffffffn,
                wide: 0xffffffffffffffffn,
                narrowFlags: 0x86n,
                wideFlags: 0x86n,
              },
              {
                selector: 'f0',
                narrow: 0xffffffffn,
                wide: 0xeeddccbbffffffffn,
                narrowFlags: 0x86n,
                wideFlags: 0x86n,
              },
            ]) {
              const code = `${width === 64 ? '4e' : '46'}${opcode}${operation.selector}${opcode === '81' ? 'ffffffff' : 'ff'}`;
              await using(
                code,
                async (cpu) => {
                  const before = input(CODE, { 0: 0x1122334400000000n });
                  cpu.setState(before);
                  const result = await cpu.run({ budget: 1n });
                  logicalExit(
                    result,
                    'budget',
                    1n,
                    1n,
                    changed(
                      before,
                      CODE + BigInt(code.length / 2),
                      {
                        0: width === 32 ? operation.narrow : operation.wide,
                      },
                      width === 32 ? operation.narrowFlags : operation.wideFlags,
                    ),
                  );
                  noFault(result);
                  memory(cpu, 0x4000n, '00');
                },
                defaultRam,
              );
            }
      },
    },
    {
      name: 'logical literals distinguish identity writes TEST preservation and immediate boundaries',
      run: async () => {
        for (const item of [
          {
            code: '4521c8',
            registers: { 8: 0x1122334480000103n, 9: 0xaabbccddffffffffn },
            writes: { 8: 0x80000103n },
            flags: 0x86n,
          },
          {
            code: '4523c1',
            registers: { 8: 0x1122334480000103n, 9: 0xaabbccddffffffffn },
            writes: { 8: 0x80000103n },
            flags: 0x86n,
          },
          {
            code: '4d09c8',
            registers: { 8: 0x8000000000000000n, 9: 0x101n },
            writes: { 8: 0x8000000000000101n },
            flags: 0x82n,
          },
          {
            code: '4d0bc1',
            registers: { 8: 0x8000000000000000n, 9: 0x101n },
            writes: { 8: 0x8000000000000101n },
            flags: 0x82n,
          },
          {
            code: '4d31c8',
            registers: { 8: 0xffffffff000000ffn, 9: 0xffffffffn },
            writes: { 8: 0xffffffffffffff00n },
            flags: 0x86n,
          },
          {
            code: '4531c0',
            registers: { 8: 0x1122334400000000n },
            writes: { 8: 0n },
            flags: 0x46n,
          },
          { code: '4585c0', registers: { 8: 0x1122334400000000n }, writes: {}, flags: 0x46n },
          { code: '85c0', registers: { 0: 0x1122334400000100n }, writes: {}, flags: 6n },
          {
            code: '4885d0',
            registers: { 0: 0x8000000000000000n, 2: 0xffffffffffffffffn },
            writes: {},
            flags: 0x86n,
          },
          {
            code: '4d85c8',
            registers: { 8: 0x100000000n, 9: 0xffffffff00000000n },
            writes: {},
            flags: 6n,
          },
          { code: 'f7c000000080', registers: { 0: 0x1122334480000000n }, writes: {}, flags: 0x86n },
          {
            code: '83c800',
            registers: { 0: 0x1122334480000100n },
            writes: { 0: 0x80000100n },
            flags: 0x86n,
          },
          {
            code: '4883e080',
            registers: { 0: 0x123456789abcdef0n },
            writes: { 0: 0x123456789abcde80n },
            flags: 2n,
          },
          {
            code: '4881e000000080',
            registers: { 0: 0x123456789abcdef0n },
            writes: { 0: 0x1234567880000000n },
            flags: 6n,
          },
          {
            code: '4881c800000080',
            registers: { 0: 0n },
            writes: { 0: 0xffffffff80000000n },
            flags: 0x86n,
          },
          { code: '4ff7c000000080', registers: { 8: 0x100000000n }, writes: {}, flags: 6n },
        ]) {
          await using(
            item.code,
            async (cpu) => {
              const before = input(CODE, item.registers);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              logicalExit(
                result,
                'budget',
                1n,
                1n,
                changed(before, CODE + BigInt(item.code.length / 2), item.writes, item.flags),
              );
              noFault(result);
              memory(cpu, 0x4000n, '00');
            },
            defaultRam,
          );
        }
      },
    },
    {
      name: 'logical required bytes and unsupported forms remain distinct without operand access',
      run: async () => {
        for (const full of [
          '4521c8',
          '4d09c8',
          '4833c2',
          '4881e000000080',
          '4883f080',
          '4ff7c000000080',
        ])
          for (let length = 1; length < full.length / 2; length++) {
            const code = full.slice(0, length * 2);
            await using(
              code,
              async (cpu) => {
                const before = input(CODE, { 0: 0x800000000000n });
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(result, 'fetch-fault', 1n, 0n, before);
                fault(result, {
                  instructionPc: CODE,
                  address: CODE + BigInt(length),
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  failingAddress: CODE + BigInt(length),
                });
                equal(result.resources.compilations, 0, 'truncation precedes translation');
                memory(cpu, 0x4000n, '00');
              },
              defaultRam,
            );
          }
        for (const code of [
          '2104',
          '0b05',
          '3184',
          '8504',
          '810c',
          '8324',
          'f700',
          'f7c8',
          '6621c0',
          '6721c0',
          'f021c0',
          '2048',
          '25',
          '0d',
          '35',
          'a9',
          'f6',
          'f7d0',
        ]) {
          await using(
            code,
            async (cpu) => {
              const before = input();
              cpu.setState(before);
              const result = await cpu.run({ budget: 0n });
              exit(result, 'budget', 0n, 0n, before);
              const stopped = await cpu.run({ budget: 1n, stop: CODE });
              exit(stopped, 'stop', 1n, 0n, before);
              const reached = await cpu.run({ budget: 1n });
              exit(reached, 'unsupported', 1n, 0n, before);
              noFault(reached);
              equal(reached.resources.compilations, 0, 'unsupported precedes translation');
              memory(cpu, 0x4000n, '00');
            },
            defaultRam,
          );
        }
      },
    },
  ];
}
