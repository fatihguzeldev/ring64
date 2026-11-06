import {
  createFixture,
  type Scenario,
  CODE,
  DATA,
  equal,
  hex,
  memory,
  changed,
  exit,
} from '../../support/fixture.js';
import { input, noFault, defaultRam } from './fixture.js';

export function addressingOperandScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'LEA literals retain full addresses, special fields and instruction-relative bases',
      run: async () => {
        const cases: {
          code: string;
          registers: Record<number, bigint>;
          dst: number;
          value: bigint;
          pc?: bigint;
          next?: bigint;
          ramBase?: bigint;
          ram?: string;
        }[] = [
          { code: '4f8d448cf0', registers: { 12: 0x1000n, 9: 5n }, dst: 8, value: 0x1004n },
          { code: '488d04e4', registers: { 4: 0x1000n, 12: 0x10n }, dst: 0, value: 0x1000n },
          { code: '4a8d04e4', registers: { 4: 0x1000n, 12: 0x10n }, dst: 0, value: 0x1080n },
          {
            code: '498d0425fcffffff',
            registers: { 13: 0x4000n },
            dst: 0,
            value: 0xfffffffffffffffcn,
          },
          { code: '498d05f9ffffff', registers: {}, dst: 0, value: CODE },
          { code: '498d05f9ffffff', registers: {}, dst: 0, value: 0x100001000n, pc: 0x100001000n },
          {
            code: '488d04cb',
            registers: { 3: 0xfffffffffffffff8n, 1: 0x2000000100000002n },
            dst: 0,
            value: 0x800000008n,
            ramBase: 0x800000008n,
            ram: '8877665544332211',
          },
          { code: '488d448008', registers: { 0: 1n }, dst: 0, value: 13n },
          { code: '488d4301', registers: { 3: 0x7fffffffffffn }, dst: 0, value: 0x800000000000n },
          { code: '8d4301', registers: { 3: 0x7fffffffffffn }, dst: 0, value: 0n },
          {
            code: '488d0500000000',
            registers: {},
            dst: 0,
            value: 0n,
            pc: 0xfffffffffffffff9n,
            next: 0n,
          },
        ];
        for (const item of cases) {
          const pc = item.pc ?? CODE,
            ramBase = item.ramBase ?? defaultRam.ramBase,
            ram = item.ram ?? defaultRam.ram;
          await using(
            item.code,
            async (cpu) => {
              const before = input(pc, item.registers);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(
                result,
                'budget',
                1n,
                1n,
                changed(before, item.next ?? pc + BigInt(item.code.length / 2), {
                  [item.dst]: item.value,
                }),
              );
              noFault(result);
              memory(cpu, ramBase, ram);
            },
            { codeBase: pc, ramBase, ram },
          );
        }
      },
    },
    {
      name: 'SIB MOV literals retain full address terms and aliased store sources',
      run: async () => {
        for (const item of [
          {
            code: '488b0424',
            registers: { 4: DATA, 12: DATA + 8n },
            ramBase: DATA,
            ram: '88776655443322110807060504030201',
            dst: 0,
            value: 0x1122334455667788n,
          },
          {
            code: '498b0424',
            registers: { 4: DATA, 12: DATA + 8n },
            ramBase: DATA,
            ram: '88776655443322110807060504030201',
            dst: 0,
            value: 0x0102030405060708n,
          },
          {
            code: '8b048b',
            registers: { 3: DATA, 1: 2n },
            ramBase: DATA + 8n,
            ram: '78563412',
            dst: 0,
            value: 0x12345678n,
          },
          {
            code: '428b040dfcffffff',
            registers: { 9: DATA + 4n },
            ramBase: DATA,
            ram: '78563412',
            dst: 0,
            value: 0x12345678n,
          },
          {
            code: '488b04cb',
            registers: { 3: 0xfffffffffffffff8n, 1: 0x2000000100000002n },
            ramBase: 0x800000008n,
            ram: '8877665544332211',
            dst: 0,
            value: 0x1122334455667788n,
          },
          {
            code: '4f8b448cf0',
            registers: { 12: DATA, 9: 5n },
            ramBase: DATA,
            ram: '101112131415161718191a1b1c1d1e1f',
            dst: 8,
            value: 0x1b1a191817161514n,
          },
          {
            code: '478b448cf0',
            registers: { 12: DATA, 9: 5n },
            ramBase: DATA,
            ram: '101112131415161718191a1b1c1d1e1f',
            dst: 8,
            value: 0x17161514n,
          },
        ])
          await using(
            item.code,
            async (cpu) => {
              const before = input(CODE, item.registers);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(
                result,
                'budget',
                1n,
                1n,
                changed(before, CODE + BigInt(item.code.length / 2), { [item.dst]: item.value }),
              );
              noFault(result);
              memory(cpu, item.ramBase, item.ram);
            },
            { ramBase: item.ramBase, ram: item.ram },
          );
        for (const item of [
          {
            code: '4789448cf0',
            registers: { 12: DATA, 9: 5n, 8: 0x11223344aabbccddn },
            ramBase: DATA,
            ram: '101112131415161718191a1b1c1d1e1f',
            after: '10111213ddccbbaa18191a1b1c1d1e1f',
          },
          {
            code: '890c8b',
            registers: { 3: 0x4000n, 1: 0x100000002n },
            ramBase: 0x400004008n,
            ram: 'a0a1a2a3',
            after: '02000000',
          },
          {
            code: '488904c3',
            registers: { 3: DATA, 0: 5n },
            ramBase: DATA + 0x20n,
            ram: 'a0a1a2a3a4a5a6a7b0b1b2b3b4b5b6b7c0c1c2c3c4c5c6c7',
            after: 'a0a1a2a3a4a5a6a70500000000000000c0c1c2c3c4c5c6c7',
          },
          {
            code: '48891c8b',
            registers: { 3: DATA, 1: 2n },
            ramBase: DATA,
            ram: 'a0a1a2a3a4a5a6a7b0b1b2b3b4b5b6b7c0c1c2c3c4c5c6c7',
            after: 'a0a1a2a3a4a5a6a70040000001000000c0c1c2c3c4c5c6c7',
          },
        ])
          await using(
            item.code,
            async (cpu) => {
              const before = input(CODE, item.registers);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'budget', 1n, 1n, changed(before, CODE + BigInt(item.code.length / 2)));
              noFault(result);
              memory(cpu, item.ramBase, item.after);
            },
            { ramBase: item.ramBase, ram: item.ram },
          );
      },
    },
    {
      name: 'RIP-relative stores use the complete next pc at both data widths',
      run: async () => {
        const ram = '1011121314151617a0a1a2a3a4a5a6a7f0f1f2f3f4f5f6f7';
        for (const pc of [CODE, 0x100001000n, 0xffff800000001000n])
          for (const item of [
            {
              code: '8905fa2f0000',
              source: 0,
              after: '1011121314151617ddccbbaaa4a5a6a7f0f1f2f3f4f5f6f7',
            },
            {
              code: '488905f92f0000',
              source: 0,
              after: '1011121314151617ddccbbaa44332211f0f1f2f3f4f5f6f7',
            },
            {
              code: '4c8905f92f0000',
              source: 8,
              after: '1011121314151617ddccbbaa44332211f0f1f2f3f4f5f6f7',
            },
          ]) {
            const ramBase = pc + 0x2ff8n;
            await using(
              item.code,
              async (cpu) => {
                const before = input(pc, { [item.source]: 0x11223344aabbccddn }, 0x82n);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(result, 'budget', 1n, 1n, changed(before, pc + BigInt(item.code.length / 2)));
                noFault(result);
                memory(cpu, ramBase, item.after);
              },
              { codeBase: pc, ramBase, ram },
            );
          }
      },
    },
    {
      name: 'SIB scales and signed displacements execute both widths through LEA and MOV',
      run: async () => {
        const ram = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';
        for (const item of [
          {
            sib: '0b',
            offset: 3,
            address: 0x4003n,
            value32: 0x06050403n,
            value64: 0x0a09080706050403n,
          },
          {
            sib: '4b',
            offset: 6,
            address: 0x4006n,
            value32: 0x09080706n,
            value64: 0x0d0c0b0a09080706n,
          },
          {
            sib: '8b',
            offset: 12,
            address: 0x400cn,
            value32: 0x0f0e0d0cn,
            value64: 0x131211100f0e0d0cn,
          },
          {
            sib: 'cb',
            offset: 24,
            address: 0x4018n,
            value32: 0x1b1a1918n,
            value64: 0x1f1e1d1c1b1a1918n,
          },
        ]) {
          for (const form of [
            { code: `8d04${item.sib}`, value: item.address },
            { code: `488d04${item.sib}`, value: item.address },
            { code: `8b04${item.sib}`, value: item.value32 },
            { code: `488b04${item.sib}`, value: item.value64 },
          ])
            await using(
              form.code,
              async (cpu) => {
                const before = input(CODE, { 3: 0x4000n, 1: 3n });
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(
                  result,
                  'budget',
                  1n,
                  1n,
                  changed(before, CODE + BigInt(form.code.length / 2), { 0: form.value }),
                );
                noFault(result);
                memory(cpu, 0x4000n, ram);
              },
              { ramBase: 0x4000n, ram },
            );
          for (const form of [
            { code: `8914${item.sib}`, width: 4, word: 'ddccbbaa' },
            { code: `488914${item.sib}`, width: 8, word: 'ddccbbaa44332211' },
          ])
            await using(
              form.code,
              async (cpu) => {
                const before = input(CODE, { 3: 0x4000n, 1: 3n, 2: 0x11223344aabbccddn });
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(
                  result,
                  'budget',
                  1n,
                  1n,
                  changed(before, CODE + BigInt(form.code.length / 2)),
                );
                noFault(result);
                memory(
                  cpu,
                  0x4000n,
                  ram.slice(0, item.offset * 2) +
                    form.word +
                    ram.slice((item.offset + form.width) * 2),
                );
              },
              { ramBase: 0x4000n, ram },
            );
        }
        for (const item of [
          { lea: '488d444b80', load: '488b444b80', base: 0x4080n, address: 0x4006n },
          { lea: '488d444b7f', load: '488b444b7f', base: 0x3f81n, address: 0x4006n },
          {
            lea: '488d844b00000080',
            load: '488b844b00000080',
            base: 0x80004000n,
            address: 0x4006n,
          },
          {
            lea: '488d844bffffff7f',
            load: '488b844bffffff7f',
            base: 0x4000n,
            address: 0x80004005n,
          },
        ])
          for (const form of [
            { code: item.lea, value: item.address },
            { code: item.lea.slice(2), value: item.address },
            { code: item.load, value: 0x1122334455667788n },
            { code: item.load.slice(2), value: 0x55667788n },
          ])
            await using(
              form.code,
              async (cpu) => {
                const before = input(CODE, { 3: item.base, 1: 3n });
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(
                  result,
                  'budget',
                  1n,
                  1n,
                  changed(before, CODE + BigInt(form.code.length / 2), { 0: form.value }),
                );
                noFault(result);
                memory(cpu, item.address, '8877665544332211');
              },
              { ramBase: item.address, ram: '8877665544332211' },
            );
      },
    },
    {
      name: 'SIB absent terms and special bases retain ignored REX and scale fields',
      run: async () => {
        for (const item of [
          { lea: '488d0403', load: '488b0403', registers: { 3: 0x4000n, 0: 0n } },
          ...['23', '63', 'a3', 'e3'].map((sib) => ({
            lea: `488d04${sib}`,
            load: `488b04${sib}`,
            registers: { 3: 0x4000n },
          })),
          { lea: '488d0424', load: '488b0424', registers: { 4: 0x4000n } },
          { lea: '498d0424', load: '498b0424', registers: { 12: 0x4000n } },
          { lea: '488d442500', load: '488b442500', registers: { 5: 0x4000n } },
          { lea: '498d442500', load: '498b442500', registers: { 13: 0x4000n } },
          { lea: '488d842500000000', load: '488b842500000000', registers: { 5: 0x4000n } },
          { lea: '498d842500000000', load: '498b842500000000', registers: { 13: 0x4000n } },
          { lea: '488d4500', load: '488b4500', registers: { 5: 0x4000n } },
          { lea: '498d4500', load: '498b4500', registers: { 13: 0x4000n } },
          { lea: '4a8d4301', load: '4a8b4301', registers: { 3: 0x3fffn } },
          { lea: '488d042500400000', load: '488b042500400000', registers: {} },
          { lea: '498d042500400000', load: '498b042500400000', registers: {} },
          { lea: '488d04e500400000', load: '488b04e500400000', registers: {} },
          { lea: '4b8d044d00000000', load: '4b8b044d00000000', registers: { 9: 0x2000n } },
        ])
          for (const form of [
            { code: item.lea, value: 0x4000n },
            { code: item.load, value: 0x1122334455667788n },
          ]) {
            await using(
              form.code,
              async (cpu) => {
                const before = input(CODE, item.registers);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(
                  result,
                  'budget',
                  1n,
                  1n,
                  changed(before, CODE + BigInt(form.code.length / 2), { 0: form.value }),
                );
                noFault(result);
                memory(cpu, 0x4000n, '8877665544332211');
              },
              { ramBase: 0x4000n, ram: '8877665544332211' },
            );
          }
        for (const item of [
          { code: '4b8d0501000000', value: 0x1008n },
          { code: '4b8b0501000000', value: 0x1122334455667788n },
        ])
          await using(
            item.code,
            async (cpu) => {
              const before = input();
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              exit(result, 'budget', 1n, 1n, changed(before, CODE + 7n, { 0: item.value }));
              noFault(result);
              memory(cpu, CODE + 8n, '8877665544332211');
            },
            { ramBase: CODE + 8n, ram: '8877665544332211' },
          );
      },
    },
    {
      name: 'new MOV and LEA paths preserve every admitted flag through artifact reuse',
      run: async () => {
        const ram = '88776655443322110807060504030201';
        for (const item of [
          { code: '8d048b', value: 0x4008n, after: ram },
          { code: '488d048b', value: 0x4008n, after: ram },
          { code: '8b048b', value: 0x05060708n, after: ram },
          { code: '488b048b', value: 0x0102030405060708n, after: ram },
          { code: '890c8b', value: undefined, after: '88776655443322110200000004030201' },
          { code: '48890c8b', value: undefined, after: '88776655443322110200000000000000' },
        ])
          await using(
            item.code,
            async (cpu) => {
              for (const [index, flags] of [
                2n,
                3n,
                6n,
                0x12n,
                0x42n,
                0x82n,
                0x802n,
                0x8d7n,
              ].entries()) {
                cpu.writeMemory(0x4000n, hex(ram));
                const before = input(CODE, { 3: 0x4000n, 1: 2n }, flags);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                exit(
                  result,
                  'budget',
                  1n,
                  1n,
                  changed(
                    before,
                    CODE + BigInt(item.code.length / 2),
                    item.value === undefined ? {} : { 0: item.value },
                  ),
                );
                noFault(result);
                memory(cpu, 0x4000n, item.after);
                equal(
                  result.resources.compilations,
                  index === 0 ? 1 : 0,
                  'flag changes reuse the addressing artifact',
                );
              }
            },
            { ramBase: 0x4000n, ram },
          );
      },
    },
  ];
}
