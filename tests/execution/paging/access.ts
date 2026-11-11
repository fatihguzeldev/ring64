import {
  BANK,
  PC,
  usingPaged,
  word,
  little,
  equal,
  same,
  hex,
  initial,
  type Scenario,
} from './fixture.js';
import { integer, stack } from '../x87/fixture.js';
import { pagingVectorAccessScenarios } from './vector-access.js';

function page(): Uint8Array {
  return new Uint8Array(0x1000).fill(0xa5);
}

export function pagingAccessScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    ...pagingVectorAccessScenarios(compiler),
    {
      name: 'paging access noncanonical numeric physical addresses remain ordinary sparse RAM under canonical linear operands',
      async run() {
        for (const physical of [0x800000000000n, 1n << 51n])
          await usingPaged(
            compiler,
            {
              code: '488b07',
              words: [[0x4800n, physical | 7n]],
              spans: [{ physical, bytes: little([0x8877665544332211n]) }],
            },
            async (cpu) => {
              const before = initial(PC, { 7: 0x500000n }, 0x8d7n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              equal(result.reason, 'budget', 'high physical read');
              equal(result.retired, 1n, 'one load');
              same(
                result.state.registers,
                before.registers.map((value, i) => (i === 0 ? 0x8877665544332211n : value)),
                'full load bank',
              );
              equal(result.state.flags, 0x8d7n, 'flags retained');
              equal(cpu.readPagingState().cr2, 0n, 'no fictitious PF');
              same(
                cpu.readPhysicalMemory(physical, 8),
                little([0x8877665544332211n]),
                'physical administration shares selected domain',
              );
            },
          );
      },
    },
    {
      name: 'paging access scalar cross-page failure publishes no partial store and reports an earlier physical refusal before later absent PTE',
      async run() {
        for (const privateWrite of [false, true])
          await usingPaged(
            compiler,
            {
              code: '8907',
              words: [[0x4800n, 0xa007n]],
              spans: [
                { physical: 0xa000n, bytes: page(), write: privateWrite },
                { physical: 0xc000n, bytes: page() },
              ],
            },
            async (cpu) => {
              const before = initial(PC, { 0: 0xaabbccddn, 7: 0x500ffen }, 2n);
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              equal(
                result.reason,
                privateWrite ? 'page-fault' : 'physical-memory-fault',
                'ordered first refusal',
              );
              equal(result.retired, 0n, 'no partial scalar retirement');
              same(result.state.registers, before.registers, 'all source banks unchanged');
              same(cpu.readPhysicalMemory(0xaffen, 2), hex('a5a5'), 'first fragment guarded');
              same(cpu.readPhysicalMemory(0xc000n, 2), hex('a5a5'), 'second backing guarded');
              equal(
                cpu.readPagingState().cr2,
                privateWrite ? 0x501000n : 0n,
                'only architectural PF publishes CR2',
              );
              equal(word(cpu, 0x4800n), 0xa027n, 'first page A without D');
              equal(word(cpu, 0x4808n), 0n, 'absent successor remains untouched');
              if (privateWrite) {
                cpu.writePhysicalMemory(0x4808n, little([0xc007n]));
                const retry = await cpu.run({ budget: 1n });
                equal(retry.reason, 'budget', 'repaired retry');
                equal(retry.retired, 1n, 'one completed store');
                same(cpu.readPhysicalMemory(0xaffen, 2), hex('ddcc'), 'first physical fragment');
                same(
                  cpu.readPhysicalMemory(0xc000n, 2),
                  hex('bbaa'),
                  'nonadjacent second fragment',
                );
                equal(word(cpu, 0x4800n), 0xa067n, 'first participating leaf D');
                equal(word(cpu, 0x4808n), 0xc067n, 'second participating leaf D');
              }
            },
          );
      },
    },
    {
      name: 'paging access LOCK CMPXCHG captures nonadjacent read-for-write fragments and dirties failed identity writes',
      async run() {
        for (const succeeds of [true, false])
          await usingPaged(
            compiler,
            {
              code: 'f00fb10f',
              words: [
                [0x4800n, 0xa007n],
                [0x4808n, 0xc007n],
              ],
              spans: [
                { physical: 0xa000n, bytes: page() },
                { physical: 0xc000n, bytes: page() },
              ],
            },
            async (cpu) => {
              cpu.setState(
                initial(PC, { 0: succeeds ? 0xa5a5a5a5n : 0n, 1: 0x11223344n, 7: 0x500ffen }, 2n),
              );
              const result = await cpu.run({ budget: 1n });
              equal(result.reason, 'budget', 'LOCK operation completes');
              equal(result.retired, 1n, 'one retirement');
              equal(result.state.flags, succeeds ? 0x46n : 0x13n, 'literal subtraction FLAGS');
              equal(result.state.registers[0], 0xa5a5a5a5n, 'accumulator readback');
              same(
                cpu.readPhysicalMemory(0xaffen, 2),
                hex(succeeds ? '4433' : 'a5a5'),
                'first fragment payload',
              );
              same(
                cpu.readPhysicalMemory(0xc000n, 2),
                hex(succeeds ? '2211' : 'a5a5'),
                'second fragment payload',
              );
              equal(word(cpu, 0x4800n), 0xa067n, 'first leaf dirty even for identity');
              equal(word(cpu, 0x4808n), 0xc067n, 'second leaf dirty even for identity');
            },
          );
      },
    },
    {
      name: 'paging access MASKMOV checks the full nominal span but dirties only selected byte pages',
      async run() {
        for (const zero of [false, true])
          await usingPaged(
            compiler,
            {
              code: '660ff7c1',
              bank: { ...BANK, cr0: 0x80010033n },
              words: [
                [0x4800n, 0xa007n],
                [0x4808n, zero ? 0xc005n : 0xc027n],
              ],
              spans: [
                { physical: 0xa000n, bytes: page() },
                { physical: 0xc000n, bytes: page() },
              ],
              ...(zero
                ? {}
                : {
                    tableWindows: [
                      { physical: 0x1000n, offset: 0, length: 0x3808, write: true },
                      { physical: 0x4808n, offset: 0x3808, length: 8, write: false },
                      { physical: 0x4810n, offset: 0x3810, length: 0x7f0, write: true },
                    ],
                  }),
            },
            async (cpu) => {
              cpu.setState(initial(PC, { 7: 0x500ff8n }, 0x8d7n));
              const xmm = Array<bigint>(16).fill(0n);
              xmm[0] = 0x1f1e1d1c1b1a19181716151413121110n;
              xmm[1] = zero ? 0n : 0x80n;
              cpu.setXmmState(xmm);
              const result = await cpu.run({ budget: 1n });
              equal(result.reason, zero ? 'page-fault' : 'budget', 'nominal write admission');
              equal(result.retired, zero ? 0n : 1n, 'selected retirement');
              same(cpu.readXmmState(), xmm, 'source vectors unchanged');
              same(
                cpu.readPhysicalMemory(0xaff8n, 8),
                hex(zero ? 'a5'.repeat(8) : '10' + 'a5'.repeat(7)),
                'only first selected byte',
              );
              same(
                cpu.readPhysicalMemory(0xc000n, 8),
                new Uint8Array(8).fill(0xa5),
                'unselected second page untouched',
              );
              equal(
                word(cpu, 0x4800n),
                zero ? 0xa027n : 0xa067n,
                'only actual first-page payload D',
              );
              equal(
                word(cpu, 0x4808n),
                zero ? 0xc025n : 0xc027n,
                'no second-page D or private D write',
              );
            },
          );
      },
    },
    {
      name: 'paging access sparse FXSAVE admits its 512-byte image but leaves a padding-only page clean and guarded',
      async run() {
        await usingPaged(
          compiler,
          {
            code: '480fae07',
            words: [
              [0x4800n, 0xa007n],
              [0x4808n, 0xc027n],
            ],
            spans: [
              { physical: 0xa000n, bytes: page() },
              { physical: 0xc000n, bytes: page() },
            ],
            tableWindows: [
              { physical: 0x1000n, offset: 0, length: 0x3808, write: true },
              { physical: 0x4808n, offset: 0x3808, length: 8, write: false },
              { physical: 0x4810n, offset: 0x3810, length: 0x7f0, write: true },
            ],
          },
          async (cpu) => {
            cpu.setState(initial(PC, { 7: 0x500e60n }, 2n));
            const numeric = cpu.readX87State();
            const xmm = Array.from({ length: 16 }, (_, i) => BigInt(i + 1));
            cpu.setXmmState(xmm);
            cpu.setMxcsr(0x1f80);
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'budget', 'sparse image completes');
            equal(result.retired, 1n, 'one save');
            same(cpu.readX87State(), numeric, 'save does not mutate x87 bank');
            same(cpu.readXmmState(), xmm, 'save leaves vectors');
            same(cpu.readPhysicalMemory(0xae60n, 4), hex('7f030000'), 'literal CW/SW prefix');
            same(cpu.readPhysicalMemory(0xae78n, 8), hex('801f0000ffff0000'), 'literal MXCSR/mask');
            same(
              cpu.readPhysicalMemory(0xaff0n, 16),
              little([16n, 0n]),
              'last XMM fits exactly to page edge',
            );
            same(
              cpu.readPhysicalMemory(0xc000n, 96),
              new Uint8Array(96).fill(0xa5),
              'padding-only page fully guarded',
            );
            equal(word(cpu, 0x4800n), 0xa067n, 'selected fields dirty first page');
            equal(word(cpu, 0x4808n), 0xc027n, 'nominal padding page A without D');
          },
        );
      },
    },
    {
      name: 'paging access unmasked x87 integer store suppresses payload and D while later waiting MF precedes a new absent operand page',
      async run() {
        await usingPaged(
          compiler,
          {
            code: 'df1fdf1f',
            words: [[0x4800n, 0xa007n]],
            spans: [{ physical: 0xa000n, bytes: page() }],
          },
          async (cpu) => {
            const numeric = stack({ 0: integer(32768n) }, 0, 0x37e);
            cpu.setX87State(numeric);
            cpu.setState(initial(PC, { 7: 0x500000n }, 0x8d7n));
            const suppressed = await cpu.run({ budget: 1n });
            equal(suppressed.reason, 'budget', 'new unmasked x87 exception defers MF');
            equal(suppressed.retired, 1n, 'store instruction completes');
            same(
              cpu.readPhysicalMemory(0xa000n, 4),
              hex('a5a5a5a5'),
              'suppressed store has no bytes',
            );
            equal(word(cpu, 0x4800n), 0xa027n, 'nominal W probe only A');
            const after = cpu.readX87State();
            equal(after.statusWord, 0x8081, 'literal unmasked invalid status');
            equal(after.tagWord, numeric.tagWord, 'no suppressed pop');
            same(after.registers, numeric.registers, 'physical registers retained');
            cpu.setState({
              ...suppressed.state,
              registers: suppressed.state.registers.map((value, i) =>
                i === 7 ? 0x580000n : value,
              ),
            });
            const waiting = await cpu.run({ budget: 1n });
            equal(waiting.reason, 'x87-exception', 'old MF beats absent operand translation');
            equal(waiting.retired, 0n, 'waiting fault does not retire');
            equal(cpu.readPagingState().cr2, 0n, 'no fake operand PF');
            equal(word(cpu, 0x4c00n), 0n, 'absent operand page untouched');
          },
        );
      },
    },
    {
      name: 'paging access REP MOVSB preserves completed elements at a source PF and resumes only the remaining work after repair',
      async run() {
        const source = page();
        source.set(hex('1122'), 0xffe);
        const next = page();
        next[0] = 0x33;
        await usingPaged(
          compiler,
          {
            code: 'f3a4',
            words: [
              [0x4800n, 0xa007n],
              [0x4c00n, 0xd007n],
            ],
            spans: [
              { physical: 0xa000n, bytes: source },
              { physical: 0xc000n, bytes: next },
              { physical: 0xd000n, bytes: page() },
            ],
          },
          async (cpu) => {
            cpu.setState(initial(PC, { 1: 3n, 6: 0x500ffen, 7: 0x580000n }, 2n));
            const fault = await cpu.run({ budget: 1n, repeatBudget: 3n });
            equal(fault.reason, 'page-fault', 'third source byte absent');
            equal(fault.retired, 0n, 'unfinished REP');
            equal(fault.repeatIterations, 2n, 'exact completed elements');
            equal(fault.state.registers[1], 1n, 'remaining count');
            equal(fault.state.registers[6], 0x501000n, 'source fault boundary');
            equal(fault.state.registers[7], 0x580002n, 'completed destination progress');
            equal(cpu.readPagingState().cr2, 0x501000n, 'first failing source byte');
            same(cpu.readPhysicalMemory(0xd000n, 4), hex('1122a5a5'), 'no third element leak');
            cpu.writePhysicalMemory(0x4808n, little([0xc007n]));
            const done = await cpu.run({ budget: 1n, repeatBudget: 1n });
            equal(done.reason, 'budget', 'remaining REP completes');
            equal(done.retired, 1n, 'single REP retirement');
            equal(done.repeatIterations, 1n, 'only outstanding element');
            equal(done.state.rip, PC + 2n, 'completed successor');
            equal(done.state.registers[1], 0n, 'count exhausted');
            same(
              cpu.readPhysicalMemory(0xd000n, 4),
              hex('112233a5'),
              'literal aggregate stream without replay',
            );
          },
        );
      },
    },
  ];
}
