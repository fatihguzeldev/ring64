import { PC, check, equal, initial, usingPaged, type Scenario } from './fixture.js';

export function pagingFaultScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'paging preserves effective stack segment for pre-walk canonical faults and physical diagnostics',
      async run() {
        await usingPaged(compiler, { code: '50' }, async (cpu) => {
          cpu.setState(initial(PC, { 4: 0x800000000008n }));
          const fault = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
          equal(fault.reason, 'event-budget', 'architectural pre-walk fault');
          check(fault.state.event.kind === 'pending', 'selected processor exception');
          equal(fault.state.event.exception.vector, 12, 'noncanonical SS is #SS');
          equal(fault.state.registers[4], 0x800000000008n, 'no stack pointer publication');
          equal(cpu.readPagingState().cr2, 0n, 'no invented paging CR2');
        });
        await usingPaged(
          compiler,
          {
            code: '50',
            words: [[0x4800n, 0xa007n]],
            spans: [{ physical: 0xa000n, bytes: new Uint8Array(8), write: false }],
          },
          async (cpu) => {
            cpu.setState(initial(PC, { 4: 0x500008n }));
            const fault = await cpu.run({ budget: 1n });
            equal(fault.reason, 'physical-memory-fault', 'physical stack permission');
            equal(fault.physicalMemoryFault?.segment, 'ss', 'actual stack provenance');
            equal(fault.physicalMemoryFault?.phase, 'final-access', 'payload admission');
            equal(cpu.readPagingState().cr2, 0n, 'private stack refusal leaves CR2');
          },
        );
      },
    },
  ];
}
