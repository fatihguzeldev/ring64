import { createFixture, type Scenario } from '../../../support/fixture.js';
import { byte, input, little, modrm, one, patch, prefix, RAM, view, written } from './fixture.js';

const widths = [8, 16, 32, 64];

export function movementScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'MOV register directions immediates and memory forms cover every low register view',
      run: async () => {
        for (const width of widths)
          for (let bank = 0; bank < 16; bank++) {
            const source = (bank + 5) % 16;
            for (const alias of [false, true]) {
              const src = alias ? bank : source;
              const before = input();
              const result = written(
                before.registers[bank]!,
                view(before.registers[src]!, width),
                width,
              );
              await one(using, {
                code: prefix(width, src, bank) + (width === 8 ? '88' : '89') + modrm(src, bank),
                writes: { [bank]: result },
              });
              await one(using, {
                code: prefix(width, bank, src) + (width === 8 ? '8a' : '8b') + modrm(bank, src),
                writes: { [bank]: result },
              });
            }
            const immediate = width === 64 ? 0x8877665544332211n : 1n << BigInt(width - 1);
            await one(using, {
              code:
                prefix(width, 0, bank) +
                byte((width === 8 ? 0xb0 : 0xb8) + (bank & 7)) +
                little(immediate, width / 8),
              writes: { [bank]: written(input().registers[bank]!, immediate, width) },
            });
            const groupValue = width === 64 ? -0x80000000n : immediate;
            await one(using, {
              code:
                prefix(width, 0, bank) +
                (width === 8 ? 'c6' : 'c7') +
                modrm(0, bank) +
                little(groupValue, Math.min(width / 8, 4)),
              writes: { [bank]: written(input().registers[bank]!, groupValue, width) },
            });
            const loadValue = view(0x88776655800080ffn, width);
            await one(using, {
              code: prefix(width, bank, 3) + (width === 8 ? '8a' : '8b') + modrm(bank, 3, 0),
              ram: patch(RAM, 16, loadValue, width / 8),
              writes: { [bank]: written(input().registers[bank]!, loadValue, width) },
            });
            await one(using, {
              code: prefix(width, bank, 3) + (width === 8 ? '88' : '89') + modrm(bank, 3, 0),
              ramAfter: patch(RAM, 16, input().registers[bank]!, width / 8),
            });
          }
      },
    },
    {
      name: 'byte high views and ignored prefix fields preserve their distinct register selection',
      run: async () => {
        for (let bank = 0; bank < 4; bank++) {
          const high = bank + 4;
          const before = input();
          await one(using, {
            code: byte(0xb0 + high) + '80',
            writes: { [bank]: written(before.registers[bank]!, 0x80n, 8, true) },
          });
          await one(using, {
            code: '88' + modrm(high, bank),
            writes: {
              [bank]: written(before.registers[bank]!, view(before.registers[bank]!, 8, true), 8),
            },
          });
          await one(using, {
            code: '8a' + modrm(high, bank),
            writes: {
              [bank]: written(before.registers[bank]!, view(before.registers[bank]!, 8), 8, true),
            },
          });
          await one(using, {
            code: '88' + modrm(high, 3, 0),
            ramAfter: patch(RAM, 16, view(before.registers[bank]!, 8, true), 1),
          });
          await one(using, {
            code: '8a' + modrm(high, 3, 0),
            writes: { [bank]: written(before.registers[bank]!, 0xa5n, 8, true) },
          });
        }
        await one(using, { code: '6648b480', writes: { 4: 0xaabbccddeeff0080n } });
        await one(using, { code: '664888e0', writes: { 0: 0x1122334455667711n } });
        for (const width of widths) {
          const imm = width === 64 ? -0x80000000n : 1n << BigInt(width - 1);
          const rex = width === 64 ? '4c' : '44';
          await one(using, {
            code:
              (width === 16 ? '66' : '') +
              rex +
              (width === 8 ? 'c6' : 'c7') +
              '03' +
              little(imm, Math.min(width / 8, 4)),
            ramAfter: patch(RAM, 16, imm, width / 8),
          });
        }
      },
    },
    {
      name: 'moffs reads and writes retain eight address bytes independently of data width',
      run: async () => {
        for (const width of widths) {
          const p = (width === 16 ? '66' : '') + (width === 64 ? '49' : '41');
          const address = little(0x100004010n, 8);
          const value = view(0x88776655800080ffn, width);
          await one(using, {
            code: p + (width === 8 ? 'a0' : 'a1') + address,
            ramBase: 0x100004000n,
            ram: patch(RAM, 16, value, width / 8),
            writes: { 0: written(input().registers[0]!, value, width) },
          });
          await one(using, {
            code: p + (width === 8 ? 'a2' : 'a3') + address,
            ramBase: 0x100004000n,
            ramAfter: patch(RAM, 16, input().registers[0]!, width / 8),
          });
        }
      },
    },
    {
      name: 'extensions use explicit source widths and all destination banks without extra clearing',
      run: async () => {
        const pairs = [
          { opcode: '0fbe', source: 8, destination: 16, signed: true },
          { opcode: '0fbe', source: 8, destination: 32, signed: true },
          { opcode: '0fbe', source: 8, destination: 64, signed: true },
          { opcode: '0fbf', source: 16, destination: 32, signed: true },
          { opcode: '0fbf', source: 16, destination: 64, signed: true },
          { opcode: '0fb6', source: 8, destination: 16, signed: false },
          { opcode: '0fb6', source: 8, destination: 32, signed: false },
          { opcode: '0fb6', source: 8, destination: 64, signed: false },
          { opcode: '0fb7', source: 16, destination: 32, signed: false },
          { opcode: '0fb7', source: 16, destination: 64, signed: false },
          { opcode: '63', source: 16, destination: 16, signed: false },
          { opcode: '63', source: 32, destination: 32, signed: false },
          { opcode: '63', source: 32, destination: 64, signed: true },
        ];
        for (const pair of pairs)
          for (let bank = 0; bank < 16; bank++) {
            const source = (bank + 5) % 16;
            const registers = { [source]: 0x11223344800080ffn };
            const before = input(undefined, registers);
            const read = view(before.registers[source]!, pair.source);
            const value = pair.signed ? BigInt.asIntN(pair.source, read) : read;
            const p = prefix(
              pair.destination,
              bank,
              source,
              pair.source === 8 && (source & 7) >= 4,
            );
            await one(using, {
              code: p + pair.opcode + modrm(bank, source),
              registers,
              writes: { [bank]: written(before.registers[bank]!, value, pair.destination) },
            });
            const aliased = input(undefined, { [bank]: 0x11223344800080ffn });
            await one(using, {
              code:
                prefix(pair.destination, bank, bank, pair.source === 8 && (bank & 7) >= 4) +
                pair.opcode +
                modrm(bank, bank),
              registers: { [bank]: aliased.registers[bank]! },
              writes: { [bank]: written(aliased.registers[bank]!, value, pair.destination) },
            });
            await one(using, {
              code: prefix(pair.destination, bank, 3) + pair.opcode + modrm(bank, 3, 0),
              ramBase: 0x4010n,
              ram: little(read, pair.source / 8),
              writes: { [bank]: written(input().registers[bank]!, value, pair.destination) },
            });
          }
        for (const [p, width] of [
          ['', 32],
          ['66', 16],
          ['48', 64],
          ['6648', 64],
          ['6647', 16],
        ] as const)
          for (const negative of [false, true]) {
            const before = input(undefined, {
              0: negative ? 0x8877665580008080n : 0x1122334400010101n,
            });
            const sourceWidth = width === 16 ? 8 : width === 32 ? 16 : 32;
            const value = BigInt.asIntN(sourceWidth, before.registers[0]!);
            await one(using, {
              code: p + '98',
              registers: { 0: before.registers[0]! },
              writes: { 0: written(before.registers[0]!, value, width) },
            });
            const high = BigInt.asIntN(width, before.registers[0]!) < 0n ? -1n : 0n;
            await one(using, {
              code: p + '99',
              registers: { 0: before.registers[0]! },
              writes: { 2: written(before.registers[2]!, high, width) },
            });
          }
      },
    },
    {
      name: 'LEA destination widths preserve upper views and never validate a data span',
      run: async () => {
        for (const width of [16, 32, 64])
          for (let bank = 0; bank < 16; bank++) {
            const before = input(undefined, { 0: 0x112233445566ffffn });
            await one(using, {
              code: prefix(width, bank, 0) + '8d' + modrm(bank, 0, 1) + '01',
              registers: { 0: before.registers[0]! },
              writes: { [bank]: written(before.registers[bank]!, 0x1122334455670000n, width) },
            });
          }
      },
    },
    {
      name: 'byte and word data forms retain every inherited address family and incoming aliased addresses',
      run: async () => {
        const addresses: { tail: string; rex?: number; registers: Record<number, bigint> }[] = [
          { tail: '03', registers: { 3: 0x4010n } },
          { tail: '43f8', registers: { 3: 0x4018n } },
          { tail: '8308000000', registers: { 3: 0x4008n } },
          { tail: '042510400000', registers: {} },
          { tail: '042510400000', rex: 0x41, registers: { 13: 0x800000000000n } },
          { tail: '0424', registers: { 4: 0x4010n } },
          { tail: '0424', rex: 0x41, registers: { 12: 0x4010n } },
          { tail: '4500', registers: { 5: 0x4010n } },
          { tail: '4500', rex: 0x41, registers: { 13: 0x4010n } },
          { tail: '0423', rex: 0x42, registers: { 3: 0x4008n, 12: 8n } },
          { tail: '00', registers: { 0: 0x4010n } },
        ];
        for (let scale = 0; scale < 4; scale++)
          addresses.push({
            tail: '04' + byte((scale << 6) | 0x0b),
            registers: { 3: 0x4010n - 3n * (1n << BigInt(scale)), 1: 3n },
          });
        for (const width of [8, 16]) {
          for (const address of addresses) {
            const p = (width === 16 ? '66' : '') + (address.rex ? byte(address.rex) : '');
            const before = input(undefined, address.registers);
            await one(using, {
              code: p + (width === 8 ? '8a' : '8b') + address.tail,
              registers: address.registers,
              writes: { 0: written(before.registers[0]!, width === 8 ? 0xa5n : 0xa5a5n, width) },
            });
            await one(using, {
              code: p + (width === 8 ? '88' : '89') + address.tail,
              registers: address.registers,
              ramAfter: patch(RAM, 16, before.registers[0]!, width / 8),
            });
          }
          for (const rex of ['', '41']) {
            const p = (width === 16 ? '66' : '') + rex;
            const displacement = 0x4010n - (0x1000n + BigInt(p.length / 2 + 6));
            await one(using, {
              code: p + (width === 8 ? '8a' : '8b') + '05' + little(displacement, 4),
              registers: { 13: 0x800000000000n },
              writes: { 0: written(input().registers[0]!, width === 8 ? 0xa5n : 0xa5a5n, width) },
            });
          }
        }
      },
    },
  ];
}
