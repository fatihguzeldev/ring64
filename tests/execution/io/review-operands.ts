import { createCpu } from '../../../host/index.js';
import { LIMITS, equal, hex, initial, type Scenario } from '../../support/fixture.js';
import { snapshot, same } from '../far-control/fixture.js';
import { usingPaged, little, PC } from '../paging/fixture.js';

export function ioOperandReviewScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'INS admits a complete address16 element before index wrap and commits no partial failed store',
      async run() {
        for (const kind of ['success', 'descending', 'segment-denied', 'private-tail'] as const) {
          const context = snapshot('protected', 0, false, false);
          context.segments.es.base = 0x30000n;
          context.segments.es.limit = kind === 'segment-denied' ? 0xffff : 0x10000;
          const descending = kind === 'descending',
            base = descending ? 0x30000n : 0x3ffffn;
          let calls = 0;
          const ram = new Uint8Array(kind === 'private-tail' ? 1 : 2).fill(0xa5);
          const cpu = await createCpu({
            compiler,
            limits: LIMITS,
            context,
            code: { base: 0x1000n, bytes: hex('f36d') },
            ram: { base, bytes: ram },
            io: {
              read(port, width) {
                equal(port, 0x80, 'DX');
                equal(width, 16, 'word input');
                calls++;
                return 0xbeef;
              },
              write() {
                throw Error('no output');
              },
            },
          });
          try {
            const before = initial(
              0x1000n,
              {
                1: 0xaabbccdd12340001n,
                2: 0x80n,
                7: descending ? 0x99aabbccddee0000n : 0x99aabbccddeeffffn,
              },
              descending ? 0x10402n : 0x10002n,
            );
            cpu.setState(before);
            if (kind === 'private-tail')
              cpu.setDebugState({ addresses: [base, 0n, 0n, 0n], dr6: 0n, dr7: 0x10401n });
            const result = await cpu.run({ budget: 1n, repeatBudget: 1n });
            if (kind === 'success' || descending) {
              equal(result.reason, 'budget', 'complete element');
              equal(calls, 1, 'one input');
              equal(result.retired, 1n, 'one REP');
              equal(result.repeatIterations, 1n, 'one completed element');
              equal(
                result.state.registers[7],
                descending ? 0x99aabbccddeefffen : 0x99aabbccddee0001n,
                'address16 wrapping preserves upper bank',
              );
              equal(result.state.registers[1], 0xaabbccdd12340000n, 'CX-only decrement');
              same(
                Array.from(cpu.readMemory(base, 2)),
                [0xef, 0xbe],
                'full word crosses offset FFFF without byte wrapping',
              );
            } else {
              equal(
                result.reason,
                kind === 'segment-denied' ? 'segment-fault' : 'data-fault',
                'geometry versus late private refusal',
              );
              equal(
                calls,
                kind === 'segment-denied' ? 0 : 1,
                'segment admission precedes input; private store follows it',
              );
              equal(result.retired, 0n, 'failed element never retires');
              equal(result.repeatIterations, 0n, 'failed consumed read is not completed work');
              same(result.state.registers, before.registers, 'no failed index/count update');
              same(
                Array.from(cpu.readMemory(base, ram.length)),
                Array(ram.length).fill(0xa5),
                'no partial failed write',
              );
              if (kind === 'segment-denied') {
                equal(result.segmentFault?.failingOffset, 0x10000n, 'full-span segment limit');
                equal(result.segmentFault?.segment, 'es', 'fixed destination');
              } else {
                equal(result.fault?.width, 2, 'full word width');
                equal(result.fault?.failingAddress, 0x40000n, 'late missing byte');
                equal(cpu.readDebugState().dr6 & 15n, 0n, 'uncommitted write has no data hit');
              }
            }
            equal(
              result.state.flags,
              descending ? 0x402n : 2n,
              'RF cleared after element begins; DF preserved',
            );
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'INS address32 writes zero-extend actual index and count while address64 wraps at u64',
      async run() {
        for (const [code, start, count, base, width, descending, expected] of [
          ['67f36d', 0x1122334400005000n, 0x1122334400000001n, 0x5000n, 32, false, 0x5004n],
          ['67f36d', 0x1122334400000000n, 0x1122334400000001n, 0n, 32, true, 0xfffffffcn],
          ['f36c', 0xffffffffffffffffn, 1n, 0xffffffffffffffffn, 8, false, 0n],
          ['f36c', 0n, 1n, 0n, 8, true, 0xffffffffffffffffn],
        ] as const) {
          let calls = 0;
          const cpu = await createCpu({
            compiler,
            limits: LIMITS,
            code: { base: 0x1000n, bytes: hex(code) },
            ram: { base, bytes: new Uint8Array(width / 8) },
            io: {
              read(_port, bits) {
                equal(bits, width, 'selected element width');
                calls++;
                return width === 32 ? 0x89abcdef : 0x7b;
              },
              write() {},
            },
          });
          try {
            cpu.setState(
              initial(0x1000n, { 1: count, 2: 0x80n, 7: start }, descending ? 0x402n : 2n),
            );
            const result = await cpu.run({ budget: 1n, repeatBudget: 1n });
            equal(result.reason, 'budget', 'full element');
            equal(result.state.registers[7], expected, 'selected-width index arithmetic');
            equal(result.state.registers[1], 0n, 'actual selected-width count publication');
            equal(calls, 1, 'exactly one input');
            same(
              Array.from(cpu.readMemory(base, width / 8)),
              width === 32 ? [0xef, 0xcd, 0xab, 0x89] : [0x7b],
              'literal payload',
            );
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'OUTS honors live FS GS source bases while INS ignores overrides and Long64 ES base',
      async run() {
        const context = snapshot();
        context.segments.fs.base = 0x4000n;
        context.segments.gs.base = 0x6000n;
        context.segments.es.base = 0x8000n;
        const ram = new Uint8Array(0x3000).fill(0xa5);
        ram[0x10] = 0xa1;
        ram[0x2011] = 0xb2;
        const trace: string[] = [];
        const cpu = await createCpu({
          compiler,
          limits: LIMITS,
          context,
          code: { base: 0x1000n, bytes: hex('646e656e646c') },
          ram: { base: 0x4000n, bytes: ram },
          io: {
            read(port, width) {
              trace.push(`r:${port}:${width}`);
              return 0x7b;
            },
            write(port, width, value) {
              trace.push(`w:${port}:${width}:${value}`);
            },
          },
        });
        try {
          const before = initial(0x1000n, { 1: 0x11223344n, 2: 0x80n, 6: 0x10n, 7: 0x5000n });
          cpu.setState(before);
          const result = await cpu.run({ budget: 3n, repeatBudget: 0n });
          equal(result.retired, 3n, 'three bare forms');
          same(
            trace,
            ['w:128:8:161', 'w:128:8:178', 'r:128:8'],
            'ordered source/output/input transactions',
          );
          equal(result.state.registers[6], 0x12n, 'only OUTS advances source');
          equal(result.state.registers[7], 0x5001n, 'fixed ES input advances destination');
          equal(result.state.registers[1], before.registers[1], 'bare count untouched');
          equal(
            cpu.readMemory(0x5000n, 1)[0],
            0x7b,
            'destination is5000 rather than FS/ES rebased address',
          );
        } finally {
          cpu.dispose();
        }
      },
    },
    {
      name: 'paged OUTS emits no failed-source output and guest-memory repair resumes only remaining elements',
      async run() {
        const first = new Uint8Array(0x1000);
        first.set(hex('78563412'), 0xffc);
        const next = new Uint8Array(0x1000);
        next.set(hex('efbeadde'));
        const trace: number[] = [];
        await usingPaged(
          compiler,
          {
            code: 'f36f',
            words: [
              [0x3000n, 0x4007n],
              [0x4020n, 0xa007n],
              [0x4028n, 0xb006n],
            ],
            spans: [
              { physical: 0xa000n, bytes: first },
              { physical: 0xb000n, bytes: next },
            ],
            io: {
              read() {
                throw Error('no input');
              },
              write(port, width, value) {
                equal(port, 0x81, 'DX');
                equal(width, 32, 'dword output');
                trace.push(value);
              },
            },
          },
          async (cpu) => {
            cpu.setState(initial(PC, { 1: 2n, 2: 0x81n, 6: 0x4ffcn }));
            const fault = await cpu.run({ budget: 1n, repeatBudget: 2n });
            equal(fault.reason, 'page-fault', 'late source PF');
            equal(fault.pageFault?.errorCode, 0, 'supervisor source read');
            equal(fault.pageFault?.address, 0x5000n, 'source fault');
            same(trace, [0x12345678], 'failed second source emits nothing');
            equal(fault.state.registers[6], 0x5000n, 'completed SI');
            equal(fault.state.registers[1], 1n, 'failed source count retained');
            equal(fault.repeatIterations, 1n, 'one completed output');
            equal(fault.retired, 0n, 'unfinished REP');
            cpu.writePhysicalMemory(0x4028n, little([0xb007n]));
            const last = await cpu.run({ budget: 1n, repeatBudget: 1n });
            equal(last.retired, 1n, 'completed REP');
            same(trace, [0x12345678, 0xdeadbeef], 'only repaired source output follows');
            equal(last.state.registers[6], 0x5004n, 'final SI');
            equal(last.state.registers[1], 0n, 'count exhausted');
          },
        );
      },
    },
  ];
}
