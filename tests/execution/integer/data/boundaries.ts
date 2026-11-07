import {
  CODE,
  changed,
  createFixture,
  equal,
  exit,
  fault,
  memory,
  type Scenario,
} from '../../../support/fixture.js';
import { byte, input, modrm, noFault, one, prefix, RAM, setup } from './fixture.js';

export function dataBoundaryScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'scalar data required encoding bytes precede unusable addresses and false conditions',
      run: async () => {
        const packets = [
          '67b001',
          '26b001',
          '6666b001',
          '4040b001',
          '4866b001',
          '664166b001',
          '480f8400000000',
          '667400',
          'b480',
          '40b480',
          '66b80080',
          '6648b88877665544332211',
          'c60380',
          '66c7030080',
          '48c70300000080',
          'a00040000001000000',
          '66a10040000001000000',
          '80848b0100000080',
          '6681848b010000000080',
          '664883848b01000000ff',
          'f6848b0100000080',
          '66f7848b010000000080',
          '0fb603',
          '660fbe03',
          '480fbf03',
          '666303',
          '660f4403',
          '0f9403',
          '66448b8ca5f8ffffff',
          'c6848b0100000080',
          '66c7848b010000000080',
        ];
        for (const full of packets)
          for (let length = 1; length < full.length / 2; length++) {
            const code = full.slice(0, length * 2);
            await using(
              code,
              async (cpu) => {
                const before = input(CODE, { 3: 0x800000000000n }, 0x12n);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(result, 'fetch-fault', 1n, 0n, before);
                const missing = CODE + BigInt(length);
                fault(result, {
                  instructionPc: CODE,
                  address: missing,
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  failingAddress: missing,
                });
                equal(result.resources.compilations, 0, 'incomplete scalar form is not compiled');
                memory(cpu, setup.ramBase, RAM);
                memory(cpu, CODE, code);
              },
              setup,
            );
          }
      },
    },
    {
      name: 'scalar unsupported prefixes maps and selectors stop before speculative address tails',
      run: async () => {
        const codes = ['f08b', 'f28b', 'f38b', '660fbf', '660fb7', '66400fbf', '82'];
        for (const opcode of ['c6', 'c7'])
          for (let selector = 1; selector < 8; selector++)
            codes.push('6644' + opcode + modrm(selector, 4, 0));
        for (const opcode of ['f6', 'f7'])
          for (const selector of [1]) codes.push('6644' + opcode + modrm(selector, 4, 0));
        for (const opcode of ['c0', 'c1', 'd0', 'd1', 'd2', 'd3'])
          codes.push('6644' + opcode + modrm(6, 4, 0));
        for (const code of codes)
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, { 3: 0x800000000000n });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'unsupported', 1n, 0n, before);
              noFault(result);
              equal(result.resources.compilations, 0, 'known unsupported encoding is not compiled');
              memory(cpu, setup.ramBase, RAM);
              memory(cpu, CODE, code);
            },
            setup,
          );
        for (const code of ['668dc0', '66448dc4'])
          await using(
            code,
            async (cpu) => {
              const before = input();
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'invalid-encoding', 1n, 0n, before);
              noFault(result);
              memory(cpu, setup.ramBase, RAM);
              memory(cpu, CODE, code);
            },
            setup,
          );
      },
    },
    {
      name: 'narrow scalar access faults retain full banks concrete flags and exact span diagnostics',
      run: async () => {
        const cases: {
          code: string;
          pointer: bigint;
          width: number;
          access: 'read' | 'write';
          cause: 'unmapped' | 'permission' | 'noncanonical' | 'address-range';
          failing: bigint;
          pc?: bigint;
          ramBase?: bigint;
          ram?: string;
        }[] = [
          {
            code: '668b03',
            pointer: 0x4010n,
            width: 2,
            access: 'read',
            cause: 'unmapped',
            failing: 0x4011n,
            ram: 'a5'.repeat(17),
          },
          {
            code: '480fbf03',
            pointer: 0x4010n,
            width: 2,
            access: 'read',
            cause: 'unmapped',
            failing: 0x4011n,
            ram: 'a5'.repeat(17),
          },
          {
            code: '666303',
            pointer: 0x4010n,
            width: 2,
            access: 'read',
            cause: 'unmapped',
            failing: 0x4011n,
            ram: 'a5'.repeat(17),
          },
          {
            code: '486303',
            pointer: 0x4010n,
            width: 4,
            access: 'read',
            cause: 'unmapped',
            failing: 0x4013n,
            ram: 'a5'.repeat(19),
          },
          {
            code: '66830b00',
            pc: 0x2001n,
            pointer: 0x2000n,
            width: 2,
            access: 'write',
            cause: 'permission',
            failing: 0x2001n,
            ramBase: 0x2000n,
            ram: 'ff',
          },
          {
            code: '66830300',
            pointer: 0x7fffffffffffn,
            width: 2,
            access: 'write',
            cause: 'noncanonical',
            failing: 0x800000000000n,
          },
          {
            code: '668903',
            pointer: 0xffffffffffffffffn,
            width: 2,
            access: 'write',
            cause: 'address-range',
            failing: 1n << 64n,
          },
          {
            code: '800b00',
            pointer: CODE,
            width: 1,
            access: 'write',
            cause: 'permission',
            failing: CODE,
          },
          {
            code: '8023ff',
            pointer: CODE,
            width: 1,
            access: 'write',
            cause: 'permission',
            failing: CODE,
          },
          {
            code: '8803',
            pointer: CODE,
            width: 1,
            access: 'write',
            cause: 'permission',
            failing: CODE,
          },
          {
            code: 'c60300',
            pointer: CODE,
            width: 1,
            access: 'write',
            cause: 'permission',
            failing: CODE,
          },
          {
            code: '0f9403',
            pointer: CODE,
            width: 1,
            access: 'write',
            cause: 'permission',
            failing: CODE,
          },
          {
            code: '0f9503',
            pointer: CODE,
            width: 1,
            access: 'write',
            cause: 'permission',
            failing: CODE,
          },
        ];
        for (const item of cases) {
          const pc = item.pc ?? CODE;
          const ramBase = item.ramBase ?? setup.ramBase;
          const ram = item.ram ?? RAM;
          await using(
            item.code,
            async (cpu) => {
              const before = input(pc, { 3: item.pointer });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'data-fault', 1n, 0n, before);
              fault(result, {
                instructionPc: pc,
                address: item.pointer,
                width: item.width,
                access: item.access,
                cause: item.cause,
                failingAddress: item.failing,
              });
              memory(cpu, ramBase, ram);
              memory(cpu, pc, item.code);
            },
            { codeBase: pc, ramBase, ram },
          );
        }
        for (const width of [16, 32, 64])
          for (const flags of [0x12n, 0x52n])
            await using(
              prefix(width) + '0f4400',
              async (cpu) => {
                const before = input(CODE, { 0: 0x100004000n }, flags);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(result, 'data-fault', 1n, 0n, before);
                fault(result, {
                  instructionPc: CODE,
                  address: 0x100004000n,
                  width: width / 8,
                  access: 'read',
                  cause: 'unmapped',
                  failingAddress: 0x100004000n,
                });
                memory(cpu, setup.ramBase, RAM);
              },
              setup,
            );
      },
    },
    {
      name: 'every narrow integer family preserves AF and full destination state when its operand fails',
      run: async () => {
        for (const width of [8, 16])
          for (const base of [0x00, 0x08, 0x20, 0x28, 0x30, 0x38, 0x84])
            for (const registerFirst of base === 0x84 ? [false] : [false, true]) {
              const opcode = base + (registerFirst ? 2 : 0) + (width === 16 ? 1 : 0);
              const code = prefix(width) + byte(opcode) + '03';
              await using(
                code,
                async (cpu) => {
                  const before = input(CODE, { 3: 0x7000n });
                  cpu.setState(before);
                  const result = await cpu.run({ budget: 1n });
                  exit(result, 'data-fault', 1n, 0n, before);
                  fault(result, {
                    instructionPc: CODE,
                    address: 0x7000n,
                    width: width / 8,
                    access: registerFirst || base === 0x38 || base === 0x84 ? 'read' : 'write',
                    cause: 'unmapped',
                    failingAddress: 0x7000n,
                  });
                  memory(cpu, setup.ramBase, RAM);
                },
                setup,
              );
            }
      },
    },
    {
      name: 'narrow reads cross readable code and RAM while complete encodings alone may wrap next RIP',
      run: async () => {
        await one(using, {
          code: '0fb703',
          registers: { 3: 0x1002n },
          ramBase: 0x1003n,
          ram: '12',
          writes: { 0: 0x1203n },
        });
        await one(using, {
          code: '66833b00',
          codeBase: 0x2001n,
          registers: { 3: 0x2000n },
          ramBase: 0x2000n,
          ram: 'ff',
          outputFlags: 6n,
        });
        await one(using, {
          code: '66b8ffff',
          codeBase: 0xfffffffffffffffcn,
          writes: { 0: 0x112233445566ffffn },
        });
        await using(
          '66b8ff',
          async (cpu) => {
            const pc = 0xfffffffffffffffdn;
            const before = input(pc);
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            exit(result, 'fetch-fault', 1n, 0n, before);
            fault(result, {
              instructionPc: pc,
              address: pc,
              width: 4,
              access: 'execute',
              cause: 'address-range',
              failingAddress: 1n << 64n,
            });
            memory(cpu, setup.ramBase, RAM);
          },
          { ...setup, codeBase: 0xfffffffffffffffdn },
        );
      },
    },
    {
      name: 'scalar data budget stop and reached decode retain priority over operand and resource checks',
      run: async () => {
        for (const code of ['660f4403', '0f9403', '66830300'])
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, { 3: 0x800000000000n });
              for (const gate of [
                { budget: 0n, stop: undefined, reason: 'budget' },
                { budget: 1n, stop: CODE, reason: 'stop' },
              ]) {
                cpu.setState(before);
                const result = await cpu.run(
                  gate.stop === undefined
                    ? { budget: gate.budget }
                    : { budget: gate.budget, stop: gate.stop },
                );
                exit(result, gate.reason, gate.budget, 0n, before);
                noFault(result);
                equal(
                  result.resources.compilations,
                  0,
                  'entry gate prevents translation and access',
                );
              }
              memory(cpu, setup.ramBase, RAM);
            },
            setup,
          );
        for (const [tail, reason] of [
          ['668103ff', 'fetch-fault'],
          ['c60c', 'unsupported'],
          ['660f4403', 'resource-limit'],
        ] as const) {
          const code = 'b480' + tail;
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, { 3: 0x800000000000n });
              cpu.setState(before);
              const result = await cpu.run({ budget: 3n });
              exit(result, reason, 3n, 1n, changed(before, 0x1002n, { 0: 0x1122334455668088n }));
              equal(result.resources.compilations, 1, 'only reached scalar prefix is compiled');
              if (reason === 'fetch-fault') {
                const missing = CODE + BigInt(code.length / 2);
                fault(result, {
                  instructionPc: 0x1002n,
                  address: missing,
                  width: 1,
                  access: 'execute',
                  cause: 'unmapped',
                  failingAddress: missing,
                });
              } else noFault(result);
              memory(cpu, setup.ramBase, RAM);
            },
            { ...setup, limits: { maxInstructions: 1, maxTranslationsPerRun: 1 } },
          );
        }
      },
    },
    {
      name: 'scalar source admission counts both prefixes and every immediate byte',
      run: async () => {
        const code = '6648b88877665544332211';
        for (const bytes of [10, 11])
          await using(
            code,
            async (cpu) => {
              const before = input(CODE, { 0: 0n });
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(
                result,
                bytes === 10 ? 'resource-limit' : 'budget',
                1n,
                bytes === 10 ? 0n : 1n,
                bytes === 10 ? before : changed(before, 0x100bn, { 0: 0x1122334455667788n }),
              );
              noFault(result);
              const units = cpu.inspectTranslations();
              equal(units.length, bytes === 10 ? 0 : 1, 'only complete source span is installed');
              if (bytes === 11)
                equal(units[0]!.sourceBytes, 11, 'source metadata includes both prefixes');
              memory(cpu, setup.ramBase, RAM);
            },
            { ...setup, limits: { maxSourceBytes: bytes } },
          );
      },
    },
  ];
}
