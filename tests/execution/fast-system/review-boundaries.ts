import type { FastSystemState } from '../../../host/index.js';
import { longSnapshot } from '../../support/context.js';
import { gate } from '../software-events/fixture.js';
import {
  BANK,
  PC,
  check,
  equal,
  hex,
  initial,
  little,
  same,
  usingPaged,
  type Scenario,
} from '../paging/fixture.js';

function bank(): FastSystemState {
  return {
    star: 0x0020000800000000n,
    lstar: 0x401000n,
    fmask: 0n,
    sysenterCs: 8n,
    sysenterEip: 0n,
    sysenterEsp: 0n,
    kernelGsBase: 0x402000n,
  };
}

export function fastSystemReviewBoundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'fast-system review split SWAPGS private tail refusal preserves RF SS history until one repaired completion',
      async run() {
        const source = PC + 4094n;
        await usingPaged(
          compiler,
          {
            code: '82'.repeat(4094) + '0f01',
            bank: { ...BANK, efer: 0x501n },
            words: [[0x4008n, 0xa007n]],
            spans: [{ physical: 0xa000n, bytes: hex('f8'), execute: false }],
          },
          async (cpu) => {
            cpu.setFastSystemState(bank());
            cpu.setState({
              ...initial(source, {}, 0x10202n),
              interruptibility: { sti: false, ss: true },
              debugContinuation: { breakpoints: 1, originPc: source - 4n },
              interrupts: { irq: null, nmiPending: true, nmiBlocked: false },
            });
            const first = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(first.reason, 'physical-memory-fault', 'required ModRM private refusal');
            equal(first.retired, 0n, 'no partial fast instruction');
            equal(first.state.rip, source, 'prefix remains the retry boundary');
            equal(first.state.flags, 0x10202n, 'required fetch precedes RF clearing');
            same(
              first.state.interruptibility,
              { sti: false, ss: true },
              'SS survives private refusal',
            );
            same(
              first.state.debugContinuation,
              { breakpoints: 1, originPc: source - 4n },
              'historical data hit survives private refusal',
            );
            equal(first.state.interrupts.nmiPending, true, 'SS still suppresses NMI');
            equal(cpu.readContext().segments.gs.base, 0n, 'failed fetch did not swap');
            equal(
              cpu.readFastSystemState().kernelGsBase,
              0x402000n,
              'failed fetch preserves hidden partner',
            );
            equal(
              first.physicalMemoryFault?.address,
              0x401000n,
              'required third byte linear address',
            );
            equal(
              first.physicalMemoryFault?.physicalAddress,
              0xa000n,
              'required third byte physical address',
            );
            cpu.setMappings([
              {
                base: 0x1000n,
                backing: 'tables',
                offset: 0,
                length: 0x4000,
                permissions: { read: true, write: true, execute: false },
              },
              {
                base: 0x9000n,
                backing: 'span0',
                offset: 0,
                length: 0x1000,
                permissions: { read: true, write: true, execute: true },
              },
              {
                base: 0xa000n,
                backing: 'span1',
                offset: 0,
                length: 1,
                permissions: { read: true, write: true, execute: true },
              },
            ]);
            const second = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(second.reason, 'event-budget', 'repaired completion selects historical DB');
            equal(second.retired, 1n, 'SWAPGS completed once');
            equal(second.state.rip, PC + 4097n, 'literal post-instruction boundary');
            equal(second.state.flags, 0x202n, 'only actual begin clears RF');
            check(second.state.event.kind === 'pending', 'DB selected before NMI');
            equal(second.state.event.exception.vector, 1, 'historical source');
            const debug = second.state.event.exception.debug;
            check(debug?.class === 'trap', 'completed data trap');
            equal(debug.deferredOriginPc, source - 4n, 'oldest history retained');
            equal(second.state.interrupts.nmiPending, true, 'NMI remains queued behind DB');
            equal(cpu.readContext().segments.gs.base, 0x402000n, 'one repaired swap');
            equal(cpu.readFastSystemState().kernelGsBase, 0n, 'old live GS becomes hidden');
          },
        );
      },
    },
    {
      name: 'fast-system review SYSRET restored TF delivers a literal user frame on the TSS stack before target fetch',
      async run() {
        const context = longSnapshot();
        context.gdtr = { base: 0x404000n, limit: 0x3f };
        context.idtr = { base: 0x403000n, limit: 0xfff };
        context.tr = {
          selector: 0x38,
          valid: true,
          base: 0x405000n,
          limit: 0x67,
          attributes: 0x8b,
        };
        const gdt = new Uint8Array(0x1000);
        gdt.set(little([0x00af9b000000ffffn, 0x00cf93000000ffffn]), 8);
        const idt = new Uint8Array(0x1000);
        idt.set(hex(gate(64, 8, 0x402000n)), 16);
        const tss = new Uint8Array(0x1000);
        tss.set(little([0x407000n]), 4);
        await usingPaged(
          compiler,
          {
            code: '480f07',
            context,
            bank: { ...BANK, efer: 0x501n },
            words: [
              [0x4010n, 0xb007n],
              [0x4018n, 0xc007n],
              [0x4020n, 0xd007n],
              [0x4028n, 0xe007n],
              [0x4030n, 0xf007n],
            ],
            spans: [
              { physical: 0xb000n, bytes: hex('90'), execute: true },
              { physical: 0xc000n, bytes: idt },
              { physical: 0xd000n, bytes: gdt },
              { physical: 0xe000n, bytes: tss },
              { physical: 0xf000n, bytes: new Uint8Array(0x1000).fill(0xa5) },
            ],
          },
          async (cpu) => {
            cpu.setFastSystemState(bank());
            cpu.setState({
              ...initial(PC, { 1: 0x401000n, 4: 0x800000000000n, 11: 0x302n }, 2n),
              interrupts: { irq: null, nmiPending: true, nmiBlocked: true },
            });
            const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
            equal(result.reason, 'budget', 'last-budget trap delivery completed');
            equal(result.retired, 1n, 'SYSRET completed exactly once');
            equal(result.deliveryAttempts, 1n, 'one processor DB entry');
            equal(result.state.rip, 0x402000n, 'DB destination precedes handler execution');
            equal(result.state.registers[4], 0x406fd8n, 'CPL3 trap selected supervisor RSP0');
            same(
              cpu.readPhysicalMemory(0xffd8n, 40),
              little([0x401000n, 0x33n, 0x302n, 0x800000000000n, 0x2bn]),
              'literal post-SYSRET user frame without error slot or RF',
            );
            same(
              cpu.readPhysicalMemory(0xffc8n, 16),
              new Uint8Array(16).fill(0xa5),
              'no hidden stack reads or extra frame slots',
            );
            equal(cpu.readPagingState().cr2, 0n, 'missing user target was never fetched');
            equal(result.state.interrupts.nmiPending, true, 'NMI remains queued');
            equal(result.state.interrupts.nmiBlocked, true, 'fast return did not unblock NMI');
            same(result.state.event, { kind: 'ready' }, 'DB delivery completed');
          },
        );
      },
    },
    {
      name: 'fast-system review repeated handler artifact refusal retains committed entry until a code repair',
      async run() {
        await usingPaged(
          compiler,
          {
            code: '0f05',
            bank: { ...BANK, efer: 0x501n },
            limits: { maxArtifactBytes: 2000 },
            words: [[0x4008n, 0xa007n]],
            spans: [{ physical: 0xa000n, bytes: new Uint8Array(128).fill(0x90), execute: true }],
          },
          async (cpu) => {
            cpu.setFastSystemState(bank());
            cpu.setState(initial(PC, {}, 0x202n));
            const first = await cpu.run({ budget: 2n });
            equal(first.reason, 'resource-limit', 'large handler artifact refused');
            equal(first.retired, 1n, 'fast source completed before private compile refusal');
            equal(first.state.rip, 0x401000n, 'committed handler remains current');
            equal(first.state.registers[1], PC + 2n, 'saved return already committed');
            cpu.setFastSystemState({ ...bank(), lstar: 0x402000n });
            const second = await cpu.run({ budget: 2n });
            equal(second.reason, 'resource-limit', 'same target still refuses');
            equal(second.retired, 0n, 'completed entry was not replayed');
            equal(second.state.rip, 0x401000n, 'retry did not reread changed LSTAR');
            same(
              second.state.registers,
              first.state.registers,
              'private refusal preserves committed GPRs',
            );
            cpu.writePhysicalMemory(0xa000n, hex('900f0b'));
            const repaired = await cpu.run({ budget: 1n });
            equal(repaired.reason, 'budget', 'smaller destination artifact admitted');
            equal(repaired.retired, 1n, 'only destination NOP completes');
            equal(repaired.state.rip, 0x401001n, 'repair resumes at original destination');
            same(
              repaired.state.registers,
              first.state.registers,
              'code repair cannot repeat entry effects',
            );
          },
        );
      },
    },
  ];
}
