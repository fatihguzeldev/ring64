import {
  BANK,
  PC,
  usingPaged,
  equal,
  same,
  initial,
  little,
  word,
  type Scenario,
} from './fixture.js';

export function pagingReviewAccessScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'paging review native code accessed refusal resets successful vector operand segment provenance to CS',
      async run() {
        await usingPaged(
          compiler,
          {
            code: '64f30f6f07e9f60f0000',
            context: { mode: 'long64', fsBase: 0x100000n, gsBase: 0n },
            bank: { ...BANK, cr2: 0x1234n },
            words: [
              [0x1000n, 0x2027n],
              [0x2000n, 0x3027n],
              [0x3010n, 0x4027n],
              [0x4000n, 0x9027n],
              [0x4008n, 0xa007n],
              [0x4800n, 0xb027n],
            ],
            spans: [
              { physical: 0xa000n, bytes: Uint8Array.of(0x90, 0x82), execute: true },
              { physical: 0xb000n, bytes: little([0x1122334455667788n, 0x99aabbccddeeff00n]) },
            ],
            tableWindows: [
              { physical: 0x1000n, offset: 0, length: 0x3008, write: true },
              { physical: 0x4008n, offset: 0x3008, length: 8, write: false },
              { physical: 0x4010n, offset: 0x3010, length: 0xff0, write: true },
            ],
          },
          async (cpu) => {
            cpu.setState(initial(PC, { 7: 0x400000n }, 2n));
            const result = await cpu.run({ budget: 3n });
            equal(result.reason, 'physical-memory-fault', 'native target A write denied');
            equal(result.retired, 2n, 'FS load and JMP committed once');
            equal(result.state.rip, PC + 0x1000n, 'target instruction did not begin');
            equal(result.resources.nativeEntries, 1, 'same generated unit reached target');
            equal(
              result.resources.dispatches,
              0,
              'no intervening host boundary can reset diagnostic state',
            );
            equal(
              cpu.readXmmState()[0],
              0x99aabbccddeeff001122334455667788n,
              'completed explicit FS load remains',
            );
            equal(cpu.readPagingState().cr2, 0x1234n, 'backend failure does not become PF');
            equal(result.physicalMemoryFault?.phase, 'accessed-write', 'A metadata phase');
            equal(result.physicalMemoryFault?.physicalAddress, 0x4008n, 'next code leaf');
            equal(result.physicalMemoryFault?.access, 'execute', 'original code request');
            equal(
              result.physicalMemoryFault?.segment,
              'cs',
              'code fetch cannot inherit successful FS operand provenance',
            );
          },
        );
      },
    },
    {
      name: 'paging review private dirty metadata refusal preserves RMW flags registers payload and deferred SS history',
      async run() {
        for (const code of ['f048830701', 'f0480fc107', 'f0480fb10f'])
          await usingPaged(
            compiler,
            {
              code,
              bank: { ...BANK, cr2: 0x1234n },
              words: [[0x4800n, 0xa027n]],
              spans: [{ physical: 0xa000n, bytes: little([10n]) }],
              tableWindows: [
                { physical: 0x1000n, offset: 0, length: 0x3800, write: true },
                { physical: 0x4800n, offset: 0x3800, length: 8, write: false },
                { physical: 0x4808n, offset: 0x3808, length: 0x7f8, write: true },
              ],
            },
            async (cpu) => {
              const before = {
                ...initial(PC, { 0: 3n, 1: 5n, 7: 0x500000n }, 0x108d7n),
                interruptibility: { sti: false, ss: true },
                debugContinuation: { breakpoints: 2, originPc: PC - 1n },
              };
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              equal(result.reason, 'physical-memory-fault', 'D private frontier');
              equal(result.physicalMemoryFault?.phase, 'dirty-write', 'exact publication phase');
              equal(result.retired, 0n, 'uncommitted RMW');
              equal(result.remaining, 1n, 'retirement allowance retained');
              same(result.state.registers, before.registers, 'no XADD/CMPXCHG result leak');
              equal(result.state.flags, 0x8d7n, 'only instruction-begin RF changes');
              same(
                result.state.interruptibility,
                before.interruptibility,
                'private refusal preserves SS interval',
              );
              same(
                result.state.debugContinuation,
                before.debugContinuation,
                'unselected historical cause retained',
              );
              same(
                result.state.event,
                { kind: 'ready' },
                'private failure is not a processor source',
              );
              same(cpu.readPhysicalMemory(0xa000n, 8), little([10n]), 'no payload publication');
              equal(word(cpu, 0x4800n), 0xa027n, 'no dirty update');
              equal(cpu.readPagingState().cr2, 0x1234n, 'no fabricated PF address');
            },
          );
      },
    },
    {
      name: 'paging review false CMOV still reads while PREFETCH and LEA do not access and CLFLUSH sets A without D or data matching',
      async run() {
        await usingPaged(compiler, { code: '0f4507' }, async (cpu) => {
          const before = initial(PC, { 7: 0x500000n }, 0x46n);
          cpu.setState(before);
          const result = await cpu.run({ budget: 1n });
          equal(result.reason, 'page-fault', 'false NE predicate still admits source');
          equal(result.retired, 0n, 'faulting conditional move');
          same(result.state.registers, before.registers, 'no false-predicate destination write');
          equal(result.state.flags, 0x46n, 'condition flags preserved');
          equal(cpu.readPagingState().cr2, 0x500000n, 'actual source read PF');
        });
        for (const code of ['0f1807', '488d07'])
          await usingPaged(compiler, { code }, async (cpu) => {
            cpu.setState(initial(PC, { 7: 0x800000000000n }, 2n));
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'budget', 'address-only/nonaccessing operation');
            equal(result.retired, 1n, 'one retirement');
            equal(cpu.readPagingState().cr2, 0n, 'no synthetic operand PF');
            equal(word(cpu, 0x4800n), 0n, 'no operand walk');
            if (code === '488d07')
              equal(
                result.state.registers[0],
                0x800000000000n,
                'LEA keeps noncanonical bit pattern',
              );
          });
        await usingPaged(
          compiler,
          {
            code: '0fae3f',
            words: [[0x4800n, 0xa005n]],
            spans: [{ physical: 0xa000n, bytes: Uint8Array.of(0xa5), write: false }],
          },
          async (cpu) => {
            cpu.setState(initial(PC, { 7: 0x500000n }, 2n));
            cpu.setDebugState({ addresses: [0x500000n, 0n, 0n, 0n], dr6: 0n, dr7: 0x30401n });
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'budget', 'CLFLUSH byte-read admission');
            equal(result.retired, 1n, 'one cache operation');
            equal(word(cpu, 0x4800n), 0xa025n, 'read sets A without D');
            equal(
              cpu.readDebugState().dr6,
              0xffff0ff0n,
              'cache maintenance excluded from data matching',
            );
            same(cpu.readPhysicalMemory(0xa000n, 1), Uint8Array.of(0xa5), 'no payload');
          },
        );
      },
    },
  ];
}
