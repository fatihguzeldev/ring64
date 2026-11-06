import { createFixture, type Scenario } from '../../../support/fixture.js';
import { one, patch, RAM, type Packet } from './fixture.js';

export function multiplyLiteralScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'multiply and divide literal packets distinguish full products signed ranges paired views and divide errors',
      run: async () => {
        const packets: Packet[] = [
          {
            code: 'f6e4',
            registers: { 0: 0x1122334455660305n },
            writes: { 0: 0x112233445566000fn },
          },
          {
            code: '40f6e4',
            registers: { 0: 0x1122334455660305n },
            writes: { 0: 0x1122334455660055n },
          },
          {
            code: 'f6ec',
            registers: { 0: 0x112233445566fe80n },
            writes: { 0: 0x1122334455660100n },
            outputFlags: 0x803n,
          },
          {
            code: '66f7e1',
            registers: { 0: 0x112233445566ffffn, 1: 2n },
            writes: { 0: 0x112233445566fffen, 2: 0x99aabbccddee0001n },
            outputFlags: 0x803n,
          },
          {
            code: 'f7e1',
            registers: { 0: 0x11223344ffffffffn, 1: 2n },
            writes: { 0: 0xfffffffen, 2: 1n },
            outputFlags: 0x803n,
          },
          {
            code: '48f7e0',
            registers: { 0: 0xffffffffffffffffn },
            writes: { 0: 1n, 2: 0xfffffffffffffffen },
            outputFlags: 0x803n,
          },
          {
            code: '48f7e9',
            registers: { 0: 0xffffffffffffffffn, 1: 2n },
            writes: { 0: 0xfffffffffffffffen, 2: 0xffffffffffffffffn },
          },
          {
            code: '0fafc1',
            registers: { 0: 0x1122334480000000n, 1: 2n },
            writes: { 0: 0n },
            outputFlags: 0x803n,
          },
          {
            code: '66480fafc1',
            registers: { 0: 3n, 1: 0xfffffffffffffffen },
            writes: { 0: 0xfffffffffffffffan },
          },
          {
            code: '486bc1ff',
            registers: { 1: 0x8000000000000000n },
            writes: { 0: 0x8000000000000000n },
            outputFlags: 0x803n,
          },
          { code: '4869c100000080', registers: { 1: 2n }, writes: { 0: 0xffffffff00000000n } },
          {
            code: '6669c1ffff',
            registers: { 1: 0x1122334400008000n },
            writes: { 0: 0x1122334455668000n },
            outputFlags: 0x803n,
          },
          {
            code: 'f6f1',
            registers: { 0: 0x11223344556600ffn, 1: 2n },
            writes: { 0: 0x112233445566017fn },
            flagMask: 2n,
          },
          { code: 'f6f1', registers: { 0: 0x1122334455660100n, 1: 1n }, divideError: true },
          {
            code: 'f6f9',
            registers: { 0: 0x112233445566fff9n, 1: 3n },
            writes: { 0: 0x112233445566fffen },
            flagMask: 2n,
          },
          {
            code: 'f6fc',
            registers: { 0: 0x112233445566fffen },
            writes: { 0: 0x1122334455660002n },
            flagMask: 2n,
          },
          {
            code: '40f6f4',
            registers: { 0: 0x1122334455660208n, 4: 0xaabbccddeeff0008n },
            writes: { 0: 0x1122334455660041n },
            flagMask: 2n,
          },
          {
            code: '66f7f1',
            registers: { 0: 0x1122334455660000n, 2: 0x99aabbccddee0001n, 1: 2n },
            writes: { 0: 0x1122334455668000n, 2: 0x99aabbccddee0000n },
            flagMask: 2n,
          },
          {
            code: 'f7f9',
            registers: { 0: 0x1122334480000000n, 2: 0x99aabbcc00000000n, 1: 0xffffffffn },
            writes: { 0: 0x80000000n, 2: 0n },
            flagMask: 2n,
          },
          {
            code: '48f7f1',
            registers: { 0: 0n, 2: 1n, 1: 2n },
            writes: { 0: 0x8000000000000000n, 2: 0n },
            flagMask: 2n,
          },
          {
            code: '48f7f1',
            registers: { 0: 0xffffffffffffffffn, 2: 0xfffffffffffffffen, 1: 0xffffffffffffffffn },
            writes: { 0: 0xffffffffffffffffn, 2: 0xfffffffffffffffen },
            flagMask: 2n,
          },
          { code: '48f7f1', registers: { 0: 0n, 2: 2n, 1: 2n }, divideError: true },
          {
            code: '48f7f9',
            registers: { 0: 0n, 2: 1n, 1: 3n },
            writes: { 0: 0x5555555555555555n, 2: 1n },
            flagMask: 2n,
          },
          {
            code: '48f7f9',
            registers: { 0: 0x8000000000000000n, 2: 0n, 1: 0xffffffffffffffffn },
            writes: { 0: 0x8000000000000000n, 2: 0n },
            flagMask: 2n,
          },
          {
            code: '48f7f9',
            registers: { 0: 0x8000000000000000n, 2: 0n, 1: 1n },
            divideError: true,
          },
          {
            code: '48f7f9',
            registers: { 0: 0x8000000000000000n, 2: 0xffffffffffffffffn, 1: 0xffffffffffffffffn },
            divideError: true,
          },
          {
            code: '48f7f9',
            registers: { 0: 0n, 2: 0x8000000000000000n, 1: 0xffffffffffffffffn },
            divideError: true,
          },
          {
            code: '48f7f9',
            registers: { 0: 0xffffffffffffffffn, 2: 0xffffffffffffffffn, 1: 0x8000000000000000n },
            writes: { 0: 0n, 2: 0xffffffffffffffffn },
            flagMask: 2n,
          },
          { code: '48f7f1', registers: { 1: 0n }, divideError: true },
          { code: '48f7f9', registers: { 1: 0n }, divideError: true },
          {
            code: '48f720',
            registers: { 0: 0x4010n },
            writes: { 0: 0xc030n, 2: 0n },
            ram: patch(RAM, 16, 3n, 8),
          },
          {
            code: '48f732',
            registers: { 0: 0n, 2: 0x4010n },
            writes: { 0: 0x8020n, 2: 0n },
            ram: patch(RAM, 16, 0x8000000000000000n, 8),
            flagMask: 2n,
          },
        ];
        for (const packet of packets) await one(using, packet);
      },
    },
  ];
}
