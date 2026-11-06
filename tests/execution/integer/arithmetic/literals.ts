import { createFixture, type Scenario } from '../../../support/fixture.js';
import { one, patch, RAM, type Packet } from './fixture.js';
import { oracleChecks } from './oracle.js';

export function arithmeticLiteralScenarios(core: WebAssembly.Module): Scenario[] {
  const using = createFixture(core);
  return [
    {
      name: 'integer arithmetic literal packets pin carry count index flag and register-view distinctions',
      run: async () => {
        oracleChecks();
        const packets: Packet[] = [
          {
            code: '10c8',
            registers: { 0: 0x1122334455667700n, 1: 0xffn },
            writes: { 0: 0x1122334455667700n },
            outputFlags: 0x57n,
          },
          {
            code: '18c8',
            registers: { 0: 0x1122334455667700n, 1: 0xffn },
            writes: { 0: 0x1122334455667700n },
            outputFlags: 0x57n,
          },
          {
            code: '4819c8',
            registers: { 0: 0n, 1: 0xffffffffffffffffn },
            writes: { 0: 0n },
            outputFlags: 0x57n,
          },
          {
            code: '10c8',
            registers: { 0: 0x112233445566777fn, 1: 0n },
            writes: { 0: 0x1122334455667780n },
            outputFlags: 0x892n,
          },
          {
            code: '18c8',
            registers: { 0: 0x1122334455667780n, 1: 0n },
            writes: { 0: 0x112233445566777fn },
            outputFlags: 0x812n,
          },
          {
            code: 'fec4',
            registers: { 0: 0x112233445566ff88n },
            writes: { 0: 0x1122334455660088n },
            outputFlags: 0x57n,
          },
          {
            code: '66ffc8',
            registers: { 0: 0x1122334455668000n },
            flags: 2n,
            writes: { 0: 0x1122334455667fffn },
            outputFlags: 0x816n,
          },
          { code: 'f6d4', writes: { 0: 0x1122334455668888n } },
          { code: 'f6d8', registers: { 0: 0x1122334455667780n }, outputFlags: 0x883n },
          { code: 'f8', outputFlags: 0x8d6n },
          { code: 'f9', outputFlags: 0x8d7n },
          { code: 'f5', outputFlags: 0x8d6n },
          { code: '4f9f', writes: { 0: 0x112233445566d788n } },
          { code: '4f9e', registers: { 0: 0x1122334455660088n }, outputFlags: 0x802n },
          { code: 'c1e020', writes: { 0: 0x55667788n } },
          {
            code: 'c0e001',
            registers: { 0: 0x1122334455667780n },
            writes: { 0: 0x1122334455667700n },
            outputFlags: 0x847n,
            flagMask: 0x8c7n,
          },
          {
            code: 'c0e801',
            registers: { 0: 0x1122334455667780n },
            writes: { 0: 0x1122334455667740n },
            outputFlags: 0x802n,
            flagMask: 0x8c7n,
          },
          {
            code: 'c0f801',
            registers: { 0: 0x1122334455667781n },
            writes: { 0: 0x11223344556677c0n },
            outputFlags: 0x87n,
            flagMask: 0x8c7n,
          },
          {
            code: 'c0e008',
            registers: { 0: 0x1122334455667780n },
            writes: { 0: 0x1122334455667700n },
            outputFlags: 0x46n,
            flagMask: 0xc6n,
          },
          {
            code: 'c0c008',
            registers: { 0: 0x1122334455667780n },
            outputFlags: 0xd6n,
            flagMask: 0xd7n,
          },
          { code: 'c0d009', outputFlags: 0xd7n, flagMask: 0xd7n },
          {
            code: 'c0d00a',
            writes: { 0: 0x1122334455667711n },
            outputFlags: 0xd7n,
            flagMask: 0xd7n,
          },
          { code: 'c1d021', writes: { 0: 0xaaccef11n }, outputFlags: 0x8d6n },
          { code: '48c1d041', writes: { 0: 0x22446688aaccef11n }, outputFlags: 0xd6n },
          {
            code: '660fa4c810',
            registers: { 0: 0x1122334455660001n, 1: 0x1234n },
            writes: { 0: 0x1122334455661234n },
            outputFlags: 3n,
            flagMask: 0xc7n,
          },
          {
            code: '660facc810',
            registers: { 0: 0x1122334455660001n, 1: 0x1234n },
            writes: { 0: 0x1122334455661234n },
            outputFlags: 2n,
            flagMask: 0xc7n,
          },
          {
            code: '0fa5c9',
            registers: { 1: 0x1122334480000001n },
            writes: { 1: 3n },
            outputFlags: 0x807n,
            flagMask: 0x8c7n,
          },
          {
            code: '0fadc9',
            registers: { 1: 0x1122334480000001n },
            writes: { 1: 0xc0000000n },
            outputFlags: 0x87n,
            flagMask: 0x8c7n,
          },
          { code: '0fbae020', outputFlags: 0x42n, flagMask: 0x43n },
          { code: '0fbae803', writes: { 0: 0x55667788n }, outputFlags: 0x43n, flagMask: 0x43n },
          {
            code: '660fa30b',
            registers: { 1: 0xffffn },
            ram: patch(RAM, 14, 0x8000n, 2),
            outputFlags: 0x43n,
            flagMask: 0x43n,
          },
          { code: '660fba2310', ram: patch(RAM, 16, 1n, 2), outputFlags: 0x43n, flagMask: 0x43n },
          { code: '0fbcc1', registers: { 1: 0n }, outputFlags: 0x46n },
          { code: '0fbdc1', registers: { 1: 0n }, outputFlags: 0x46n },
          { code: '0fbcc1', registers: { 1: 0x100n }, writes: { 0: 8n }, outputFlags: 2n },
          { code: '0fbdc1', registers: { 1: 0x100n }, writes: { 0: 8n }, outputFlags: 2n },
          { code: '0fbcc1', registers: { 1: 0x180n }, writes: { 0: 7n }, outputFlags: 6n },
          { code: '0fbdc1', registers: { 1: 0x180n }, writes: { 0: 8n }, outputFlags: 6n },
          { code: '0fbcc0', registers: { 0: 0x100000000n }, outputFlags: 0x46n },
          { code: '0fc8', writes: { 0: 0x88776655n } },
          { code: '480fc8', writes: { 0: 0x8877665544332211n } },
        ];
        for (const packet of packets) await one(using, packet);
      },
    },
  ];
}
