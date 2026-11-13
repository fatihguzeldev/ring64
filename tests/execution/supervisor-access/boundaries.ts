import { createCpu } from '../../../host/index.js';
import { banks, stack } from '../x87/fixture.js';
import {
  AC,
  AUX,
  DATA,
  PC,
  SMAP,
  families,
  fixture,
  hex,
  memory,
  preserved,
  put,
  same,
  state,
  using,
  type Scenario,
} from './fixture.js';

export function supervisorBoundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  const side = { createCpu, compiler };
  return [
    {
      name: 'supervisor scalar and vector accesses cross every interior byte with atomic denied writes and full live AC',
      async run() {
        for (const family of families)
          for (const [width, load, store] of [
            [4, '8b03', '8903'],
            [16, '0f1003', '0f1103'],
          ] as const)
            for (let split = 1; split < width; split++)
              for (const write of [false, true])
                for (const ac of [false, true]) {
                  const f = fixture(side, family, write ? store : load);
                  f.paging.cr4 |= SMAP;
                  f.leaf(0x7000, 0xb067n);
                  const address = 0x7000 - split,
                    physical = 0xb000 - split;
                  for (let i = 0; i < width; i++) f.bytes[physical + i] = i + 1;
                  await using(side, f, async (cpu) => {
                    const before = state(2n | (ac ? AC : 0n));
                    before.registers[3] = BigInt(address);
                    cpu.setState(before);
                    const vector = banks(),
                      numeric = stack();
                    cpu.setXmmState(vector);
                    cpu.setX87State(numeric);
                    cpu.setMxcsr(0x1f80);
                    const result = await cpu.run({ budget: 1n }),
                      expected = structuredClone(before),
                      expectedRam = f.bytes.slice(),
                      expectedVector = vector.slice();
                    if (ac) {
                      expected.rip = PC + BigInt((write ? store : load).length / 2);
                      if (write)
                        put(
                          expectedRam,
                          physical,
                          width === 4 ? before.registers[0]! : vector[0]!,
                          width,
                        );
                      else if (width === 4)
                        expected.registers[0] =
                          family === 'ia32e' || family === 'fixed'
                            ? 0x04030201n
                            : 0x1122334404030201n;
                      else expectedVector[0] = 0x100f0e0d0c0b0a090807060504030201n;
                    }
                    same(result.reason, ac ? 'budget' : 'page-fault', 'every byte span permission');
                    same(result.retired, ac ? 1n : 0n, 'cross-page retirement');
                    same(result.state, expected, 'cross-page full scalar');
                    same(
                      result.pageFault,
                      ac
                        ? undefined
                        : {
                            vector: 14,
                            address: 0x7000n,
                            access: write ? 'write' : 'read',
                            errorCode: write ? 3 : 1,
                            instructionPc: PC,
                          },
                      'cross-page exact failing translation',
                    );
                    same(cpu.readXmmState(), expectedVector, 'cross-page vector publication');
                    same(cpu.readX87State(), numeric, 'cross-page independent x87');
                    same(cpu.readMxcsr(), 0x1f80, 'cross-page MXCSR');
                    memory(cpu, expectedRam, 'cross-page full atomic payload');
                  });
                }
      },
    },
    {
      name: 'supervisor CMPXCHG failed comparison and LOCK RMW still require write admission before any output',
      async run() {
        for (const family of families)
          for (const code of ['0fb10b', 'f00fb10b', '0fc10b', 'f00fc10b'])
            for (const wp of [false, true]) {
              const f = fixture(side, family, code);
              f.paging.cr4 |= SMAP;
              f.paging.cr0 |= wp ? 0x10000n : 0n;
              f.leaf(Number(DATA), 0xa065n);
              await using(side, f, async (cpu) => {
                const before = state();
                cpu.setState(before);
                const numeric = preserved(cpu);
                cpu.setTimeState({ tsc: 100n, tscAux: AUX });
                cpu.setDebugState({ addresses: [DATA, 0n, 0n, 0n], dr6: 0n, dr7: 0xf0401n });
                const result = await cpu.run({ budget: 1n });
                same(result.reason, 'page-fault', 'RMW write admission even when comparison fails');
                same(result.retired, 0n, 'denied RMW no retirement');
                same(result.state, before, 'denied RMW preserves flags operands and accumulator');
                same(
                  result.pageFault,
                  { vector: 14, address: DATA, access: 'write', errorCode: 3, instructionPc: PC },
                  'RMW owns original write permission',
                );
                same(cpu.readDebugState().dr6, 0xffff0ff0n, 'failed RMW no operand DB');
                same(cpu.readTimeState(), { tsc: 100n, tscAux: AUX }, 'failed RMW no tick');
                numeric();
                memory(cpu, f.bytes, 'failed RMW no D or payload');
              });
            }
      },
    },
    {
      name: 'supervisor ordinary PUSH POP stack accesses are explicit and use live AC at the current privilege',
      async run() {
        for (const family of families)
          for (const pop of [false, true])
            for (const ac of [false, true]) {
              const f = fixture(side, family, pop ? '58' : '50');
              f.paging.cr4 |= SMAP;
              f.leaf(0x9000, 0xd067n);
              const width = f.bits === 64 ? 8 : 4;
              f.bytes.set(hex('8877665544332211'), 0xdff0);
              await using(side, f, async (cpu) => {
                const before = state(2n | (ac ? AC : 0n));
                cpu.setState(before);
                const numeric = preserved(cpu),
                  result = await cpu.run({ budget: 1n });
                const expected = structuredClone(before),
                  expectedRam = f.bytes.slice();
                if (ac) {
                  expected.rip = PC + 1n;
                  expected.registers[4] = before.registers[4]! + BigInt(pop ? width : -width);
                  if (pop) expected.registers[0] = 0x1122334455667788n;
                  else put(expectedRam, 0xdff0 - width, before.registers[0]!, width);
                }
                same(
                  result.reason,
                  ac ? 'budget' : 'page-fault',
                  'ordinary explicit stack permission',
                );
                same(result.retired, ac ? 1n : 0n, 'ordinary stack retirement');
                same(result.state, expected, 'ordinary stack full scalar');
                same(
                  result.pageFault,
                  ac
                    ? undefined
                    : {
                        vector: 14,
                        address: pop ? 0x9ff0n : 0x9ff0n - BigInt(width),
                        access: pop ? 'read' : 'write',
                        errorCode: pop ? 1 : 3,
                        instructionPc: PC,
                      },
                  'ordinary stack full PF',
                );
                memory(cpu, expectedRam, 'ordinary stack exact payload');
                numeric();
              });
            }
      },
    },
  ];
}
