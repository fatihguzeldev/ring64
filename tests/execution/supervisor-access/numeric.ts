import { createCpu } from '../../../host/index.js';
import { banks, clone, ONE, stack } from '../x87/fixture.js';
import {
  AC,
  AUX,
  DATA,
  PC,
  SMAP,
  families,
  fixture,
  memory,
  preserved,
  put,
  same,
  state,
  using,
  word,
  type Scenario,
} from './fixture.js';

export function supervisorNumericScenarios(compiler: WebAssembly.Module): Scenario[] {
  const side = { createCpu, compiler };
  return [
    {
      name: 'supervisor numeric NM waiting MF and mandatory alignment keep priority before SMAP operands',
      async run() {
        for (const family of families)
          for (const [code, selected] of [
            ['d903', 'nm'],
            ['d923', 'mf'],
            ['0f2803', 'align16'],
            ['0fae03', 'align512'],
          ] as const) {
            const f = fixture(side, family, code);
            f.paging.cr4 |= SMAP;
            f.leaf(Number(DATA), 0xa067n);
            if (selected === 'nm') f.paging.cr0 |= 8n;
            await using(side, f, async (cpu) => {
              const before = state();
              if (selected.startsWith('align')) before.registers[3] = DATA + 1n;
              cpu.setState(before);
              if (selected === 'mf') cpu.setX87State(stack({ 0: ONE }, 5, 0x37b, 0x8084));
              const numeric = preserved(cpu),
                result = await cpu.run({ budget: 1n });
              same(
                result.reason,
                selected === 'nm'
                  ? 'device-not-available'
                  : selected === 'mf'
                    ? 'x87-exception'
                    : 'alignment-fault',
                'numeric higher-priority refusal',
              );
              same(result.retired, 0n, 'numeric priority no retirement');
              same(result.state, before, 'numeric priority scalar');
              same(result.pageFault, undefined, 'SMAP never selected');
              if (selected.startsWith('align'))
                same(
                  result.alignmentFault,
                  {
                    segment: 'ds',
                    offset: DATA + 1n,
                    address: DATA + 1n,
                    access: selected === 'align512' ? 'write' : 'read',
                    width: selected === 'align512' ? 512 : 16,
                    alignment: 16,
                    instructionPc: PC,
                  },
                  'literal mandatory alignment',
                );
              numeric();
              memory(cpu, f.bytes, 'numeric priority no RAM effects');
            });
          }
      },
    },
    {
      name: 'supervisor denied SIMD MMX x87 control images and cache hints preserve every numeric and RAM byte',
      async run() {
        for (const family of families)
          for (const [code, width, write, aligned] of [
            ['0f1003', 16, false, false],
            ['0f1103', 16, true, false],
            ['0f6f03', 8, false, false],
            ['0f7f03', 8, true, false],
            ['d903', 4, false, false],
            ['d91b', 4, true, false],
            ['dd03', 8, false, false],
            ['dd1b', 8, true, false],
            ['d923', 28, false, false],
            ['d933', 28, true, false],
            ['dd23', 108, false, false],
            ['dd33', 108, true, false],
            ['0fae03', 512, true, true],
            ['0fae0b', 512, false, true],
            ['0fae13', 4, false, false],
            ['0fae1b', 4, true, false],
            ['0fae3b', 1, false, false],
          ] as const)
            for (const split of [false, true]) {
              const f = fixture(side, family, code);
              f.paging.cr4 |= SMAP;
              const address = split
                ? 0x7000 - (aligned ? 16 : Math.min(width, 2) - 1)
                : Number(DATA);
              if (split) f.leaf(0x7000, 0xb067n);
              else f.leaf(Number(DATA), 0xa067n);
              await using(side, f, async (cpu) => {
                const before = state();
                before.registers[3] = BigInt(address);
                cpu.setState(before);
                cpu.setX87State(stack({ 0: ONE }, 3));
                cpu.setXmmState(banks());
                cpu.setMxcsr(0x1f80);
                cpu.setTimeState({ tsc: 100n, tscAux: AUX });
                const numeric = preserved(cpu),
                  result = await cpu.run({ budget: 1n });
                same(result.reason, 'page-fault', `${family} ${code} ${split} denied`);
                same(result.retired, 0n, 'numeric denied instruction does not retire');
                same(result.state, before, 'numeric denial full scalar');
                same(
                  result.pageFault,
                  {
                    vector: 14,
                    address: BigInt(split ? 0x7000 : address),
                    access: write ? 'write' : 'read',
                    errorCode: write ? 3 : 1,
                    instructionPc: PC,
                  },
                  'numeric full span PF',
                );
                same(cpu.readTimeState(), { tsc: 100n, tscAux: AUX }, 'numeric denial has no tick');
                memory(cpu, f.bytes, 'numeric denial atomic RAM');
                numeric();
              });
            }
      },
    },
    {
      name: 'supervisor FXSAVE full legacy admission includes reserved user tail without dirtying or storing it',
      async run() {
        for (const ac of [false, true]) {
          const f = fixture(side, 'non-pae', '0fae03');
          f.paging.cr4 |= SMAP;
          f.leaf(0, 0x7023n);
          f.leaf(0x1000, 0x8027n);
          f.leaf(0x2000, 0x8023n);
          await using(side, f, async (cpu) => {
            const before = state(2n | (ac ? AC : 0n), 0x2000n);
            before.registers[3] = 0xee0n;
            const numeric = stack({ 0: ONE, 2: 0n }, 5),
              vector = banks();
            cpu.setState(before);
            cpu.setX87State(numeric);
            cpu.setXmmState(vector);
            cpu.setMxcsr(0xffc5);
            const stable = preserved(cpu),
              result = await cpu.run({ budget: 1n });
            same(result.reason, ac ? 'budget' : 'page-fault', 'full reserved tail admission');
            same(result.retired, ac ? 1n : 0n, 'full reserved tail retirement');
            same(result.state, { ...before, rip: ac ? 0x2003n : before.rip }, 'FXSAVE scalar');
            const expected = f.bytes.slice(),
              base = 0x7ee0;
            if (ac) {
              put(expected, f.pt, 0x7063n, 4);
              put(expected, base, BigInt(numeric.controlWord), 2);
              put(expected, base + 2, BigInt(numeric.statusWord), 2);
              put(expected, base + 4, 0xa0n, 1);
              put(expected, base + 6, BigInt(numeric.opcode), 2);
              put(expected, base + 8, numeric.instructionPointer, 4);
              put(expected, base + 12, 0n, 2);
              put(expected, base + 16, numeric.dataPointer, 4);
              put(expected, base + 20, 0n, 2);
              put(expected, base + 24, 0xffc5n, 4);
              put(expected, base + 28, 0xffffn, 4);
              for (let i = 0; i < 8; i++) {
                put(expected, base + 32 + i * 16, numeric.registers[(5 + i) & 7]!, 10);
                put(expected, base + 160 + i * 16, vector[i]!, 16);
              }
            } else
              same(
                result.pageFault,
                {
                  vector: 14,
                  address: 0x1000n,
                  access: 'write',
                  errorCode: 3,
                  instructionPc: 0x2000n,
                },
                'reserved-tail exact PF',
              );
            same(word(cpu, f.pt + 4, 4), 0x8027n, 'reserved tail no payload D');
            memory(cpu, expected, 'FXSAVE selected fields and preserved reserved bytes');
            stable();
          });
        }
      },
    },
    {
      name: 'supervisor zero mask still admits full span before MMX tags and operand debug publication',
      async run() {
        for (const family of families)
          for (const [code, mmx] of [
            ['0ff7c1', true],
            ['660ff7c1', false],
          ] as const)
            for (const ac of [false, true]) {
              const f = fixture(side, family, code);
              f.paging.cr4 |= SMAP;
              f.leaf(Number(DATA), 0xa027n);
              await using(side, f, async (cpu) => {
                const before = state(2n | (ac ? AC : 0n)),
                  numeric = stack({}, 5),
                  vector = banks();
                numeric.registers[0] = 0x12340102030405060708n;
                numeric.registers[1] = 0n;
                vector[1] = 0n;
                cpu.setState(before);
                cpu.setX87State(numeric);
                cpu.setXmmState(vector);
                cpu.setMxcsr(0x1f80);
                cpu.setDebugState({ addresses: [DATA, 0n, 0n, 0n], dr6: 0n, dr7: 0x10401n });
                const result = await cpu.run({ budget: 1n }),
                  expected = clone(numeric);
                if (ac && mmx) {
                  expected.statusWord &= ~0x3800;
                  expected.tagWord = 0;
                }
                same(result.reason, ac ? 'budget' : 'page-fault', 'zero-mask full nominal check');
                same(result.retired, ac ? 1n : 0n, 'zero-mask retirement');
                same(
                  result.state,
                  { ...before, rip: ac ? PC + BigInt(code.length / 2) : PC },
                  'zero-mask scalar',
                );
                same(cpu.readX87State(), expected, 'zero-mask admission before MMX transition');
                same(cpu.readXmmState(), vector, 'zero-mask vectors');
                same(cpu.readMxcsr(), 0x1f80, 'zero-mask MXCSR');
                same(
                  cpu.readDebugState().dr6,
                  0xffff0ff0n,
                  'no selected-byte watchpoint beyond fixed DR6 bits',
                );
                same(word(cpu, f.pt + 6 * f.width, f.width), 0xa027n, 'zero-mask no D');
                memory(cpu, f.bytes, 'zero-mask no payload');
              });
            }
      },
    },
    {
      name: 'supervisor SMAP numeric admission precedes reserved MXCSR and preserves no-wait pending state',
      async run() {
        for (const ac of [false, true]) {
          const f = fixture(side, 'non-pae', '0fae0b');
          f.paging.cr4 |= SMAP;
          f.leaf(Number(DATA), 0xa067n);
          put(f.bytes, 0xa000 + 24, 0x10000n, 4);
          await using(side, f, async (cpu) => {
            const before = state(2n | (ac ? AC : 0n));
            cpu.setState(before);
            const numeric = preserved(cpu),
              result = await cpu.run({ budget: 1n });
            same(
              result.reason,
              ac ? 'general-protection' : 'page-fault',
              'SMAP before image value validation',
            );
            same(result.state, before, 'failed restore scalar');
            same(result.retired, 0n, 'failed restore no retire');
            numeric();
            memory(cpu, f.bytes, 'failed restore RAM');
          });
        }
        for (const code of ['d933', 'dd33']) {
          const f = fixture(side, 'non-pae', code);
          f.paging.cr4 |= SMAP;
          f.leaf(Number(DATA), 0xa067n);
          await using(side, f, async (cpu) => {
            cpu.setState(state());
            cpu.setX87State(stack({ 0: ONE }, 5, 0x37b, 0x8084));
            const numeric = preserved(cpu),
              result = await cpu.run({ budget: 1n });
            same(result.reason, 'page-fault', 'no-wait image reaches SMAP');
            same(result.retired, 0n, 'no-wait denied no retirement');
            numeric();
            memory(cpu, f.bytes, 'denied no-wait image is atomic');
          });
        }
      },
    },
  ];
}
