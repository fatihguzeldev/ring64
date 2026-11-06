import { createFixture, type Scenario } from '../../../support/fixture.js';
import { one, patch, RAM, type Packet } from './fixture.js';

export function literalScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'scalar data literal packets distinguish register views widths extensions and conditional reads',
      run: async () => {
        const packets: Packet[] = [
          { code: 'b480', writes: { 0: 0x1122334455668088n } },
          { code: '40b480', writes: { 4: 0xaabbccddeeff0080n } },
          { code: '48b480', writes: { 4: 0xaabbccddeeff0080n } },
          { code: '88e0', writes: { 0: 0x1122334455667777n } },
          { code: '66b80080', writes: { 0: 0x1122334455668000n } },
          {
            code: '6648b88877665544332211',
            registers: { 0: 0n },
            writes: { 0: 0x1122334455667788n },
          },
          { code: '48c7c000000080', writes: { 0: 0xffffffff80000000n } },
          { code: '66448b03', ram: patch(RAM, 16, 0x8000n, 2), writes: { 8: 0x1122334400008000n } },
          { code: '0fbec4', registers: { 0: 0x11223344556680ffn }, writes: { 0: 0xffffff80n } },
          {
            code: '660fbec4',
            registers: { 0: 0x11223344556680ffn },
            writes: { 0: 0x112233445566ff80n },
          },
          { code: '480fbe03', ramBase: 0x4010n, ram: '80', writes: { 0: 0xffffffffffffff80n } },
          { code: '0fbf03', ram: patch(RAM, 16, 0x8000n, 2), writes: { 0: 0xffff8000n } },
          { code: '480fbf03', ram: patch(RAM, 16, 0x8000n, 2), writes: { 0: 0xffffffffffff8000n } },
          { code: '6663c0', registers: { 0: 0x1122334480008001n } },
          { code: '63c0', registers: { 0: 0x1122334480008001n }, writes: { 0: 0x80008001n } },
          {
            code: '4863c0',
            registers: { 0: 0x1122334480008001n },
            writes: { 0: 0xffffffff80008001n },
          },
          {
            code: '6698',
            registers: { 0: 0x1122334455667780n },
            writes: { 0: 0x112233445566ff80n },
          },
          { code: '98', registers: { 0: 0x1122334455668000n }, writes: { 0: 0xffff8000n } },
          {
            code: '6699',
            registers: { 0: 0x8000000080008000n },
            writes: { 2: 0x112233440000ffffn },
          },
          { code: '99', registers: { 0: 0x8000000080008000n }, writes: { 2: 0xffffffffn } },
          {
            code: '4899',
            registers: { 0: 0x8000000080008000n },
            writes: { 2: 0xffffffffffffffffn },
          },
          {
            code: '668d4001',
            registers: { 0: 0x112233445566ffffn },
            writes: { 0: 0x1122334455660000n },
          },
          { code: '0f94fc', writes: { 0: 0x1122334455660188n } },
          { code: '400f94fc', writes: { 4: 0xaabbccddeeff0001n } },
          { code: '0f44c1', flags: 2n, writes: { 0: 0x55667788n } },
          { code: '660f44c1', flags: 2n },
          { code: '480f44c1', flags: 2n },
          {
            code: '0f4400',
            registers: { 0: 0x100004000n },
            flags: 2n,
            ramBase: 0x100004000n,
            ram: '78563412',
            writes: { 0: 0x4000n },
          },
          {
            code: '66a10040000001000000',
            ramBase: 0x100004000n,
            ram: '3412',
            writes: { 0: 0x1122334455661234n },
          },
          {
            code: '41a00040000001000000',
            ramBase: 0x100004000n,
            ram: '80',
            writes: { 0: 0x1122334455667780n },
          },
          {
            code: '66050100',
            registers: { 0: 0x112233445566ffffn },
            writes: { 0: 0x1122334455660000n },
            outputFlags: 0x57n,
          },
          {
            code: '6683c001',
            registers: { 0: 0x1122334455667fffn },
            writes: { 0: 0x1122334455668000n },
            outputFlags: 0x896n,
          },
          {
            code: '00e0',
            registers: { 0: 0x112233445566ff01n },
            writes: { 0: 0x112233445566ff00n },
            outputFlags: 0x57n,
          },
          {
            code: 'f6c480',
            registers: { 0: 0x11223344556680ffn },
            outputFlags: 0x82n,
            logical: true,
          },
          { code: '66c705000000003412', ramBase: 0x1009n, ram: 'a5a5', ramAfter: '3412' },
          {
            code: '8803',
            registers: { 3: 0xffffffffffffffffn },
            ramBase: 0xffffffffffffffffn,
            ram: 'a5',
            ramAfter: '88',
          },
        ];
        for (const packet of packets) await one(using, packet);
      },
    },
  ];
}
