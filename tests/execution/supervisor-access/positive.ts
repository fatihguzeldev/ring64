import { createCpu } from '../../../host/index.js';
import { ONE, banks, clone, pop, slot, stack } from '../x87/fixture.js';
import {
  AC,
  AUX,
  DATA,
  PC,
  SMAP,
  families,
  fixture,
  memory,
  put,
  same,
  state,
  using,
  type Scenario,
} from './fixture.js';

export function supervisorPositiveScenarios(compiler: WebAssembly.Module): Scenario[] {
  const side = { createCpu, compiler };
  return [
    {
      name: 'supervisor x87 and MMX memory helpers admit explicit user operands only with live AC',
      async run() {
        for (const family of families)
          for (const [code, mmx, write] of [
            ['d903', false, false],
            ['d91b', false, true],
            ['0f6f03', true, false],
            ['0f7f03', true, true],
          ] as const)
            for (const ac of [false, true]) {
              const f = fixture(side, family, code);
              f.paging.cr4 |= SMAP;
              f.leaf(Number(DATA), 0xa067n);
              put(f.bytes, 0xa000, mmx ? 0x8877665544332211n : 0x3f800000n, mmx ? 8 : 4);
              await using(side, f, async (cpu) => {
                const before = state(2n | (ac ? AC : 0n)),
                  numeric = stack({ 0: ONE }, 5),
                  vector = banks(),
                  expectedNumeric = clone(numeric),
                  expectedRam = f.bytes.slice();
                cpu.setState(before);
                cpu.setX87State(numeric);
                cpu.setXmmState(vector);
                cpu.setMxcsr(0x3f80);
                cpu.setTimeState({ tsc: 100n, tscAux: AUX });
                const context = cpu.readContext(),
                  result = await cpu.run({ budget: 1n });
                if (ac) {
                  if (mmx) {
                    expectedNumeric.statusWord &= ~0x3800;
                    expectedNumeric.tagWord = 0;
                    if (!write) expectedNumeric.registers[0] = 0xffff8877665544332211n;
                    else put(expectedRam, 0xa000, numeric.registers[0]!, 8);
                  } else {
                    if (write) {
                      pop(expectedNumeric);
                      put(expectedRam, 0xa000, 0x3f800000n, 4);
                    } else {
                      slot(expectedNumeric, 4, ONE);
                      expectedNumeric.statusWord = 4 << 11;
                    }
                    expectedNumeric.instructionPointer = PC;
                    expectedNumeric.dataPointer = DATA;
                  }
                }
                same(
                  result.reason,
                  ac ? 'budget' : 'page-fault',
                  'same numeric helper AC0/AC1 verdict',
                );
                same(result.retired, ac ? 1n : 0n, 'numeric explicit operand retirement');
                same(
                  result.state,
                  { ...before, rip: ac ? PC + BigInt(code.length / 2) : PC },
                  'numeric explicit full scalar',
                );
                same(
                  result.pageFault,
                  ac
                    ? undefined
                    : {
                        vector: 14,
                        address: DATA,
                        access: write ? 'write' : 'read',
                        errorCode: write ? 3 : 1,
                        instructionPc: PC,
                      },
                  'numeric explicit exact PF',
                );
                same(
                  cpu.readPagingState(),
                  { ...f.paging, cr2: ac ? 0xdeadn : DATA },
                  'numeric explicit CR2',
                );
                same(
                  cpu.readX87State(),
                  expectedNumeric,
                  'numeric admitted state or exact denied preservation',
                );
                same(cpu.readXmmState(), vector, 'numeric independent XMM bank');
                same(cpu.readMxcsr(), 0x3f80, 'numeric independent MXCSR');
                same(cpu.readContext(), context, 'numeric execution context');
                same(
                  cpu.readTimeState(),
                  { tsc: ac ? 101n : 100n, tscAux: AUX },
                  'numeric exact time',
                );
                memory(cpu, expectedRam, 'numeric exact payload and all guard bytes');
              });
            }
      },
    },
  ];
}
