import type { Cpu, ExecutionContextSnapshot, FastSystemState } from '../../../host/index.js';
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
  word,
  type PagedSetup,
  type Scenario,
} from '../paging/fixture.js';

const HANDLER = 0x401000n;
const TOP = 0x405000n;
const FAST: FastSystemState = {
  star: 0x0020000800000000n,
  lstar: HANDLER,
  fmask: 0x700n,
  sysenterCs: 8n,
  sysenterEip: HANDLER,
  sysenterEsp: TOP,
  kernelGsBase: 0xffff80000000a000n,
};

function context(cpl = 0, compatibility = false): ExecutionContextSnapshot {
  const result = longSnapshot(0x1234n, 0x5678n);
  result.mode = compatibility ? 'compatibility' : 'long64';
  result.cpl = cpl;
  result.segments.cs.default32 = compatibility;
  result.segments.cs.long = !compatibility;
  result.segments.cs.dpl = cpl;
  result.segments.ss.dpl = cpl;
  result.segments.cs.selector = cpl === 3 ? 0x33 : 8;
  result.segments.ss.selector = cpl === 3 ? 0x2b : 16;
  return result;
}

function eventSetup(code: string, handler: string, cpl = 0): PagedSetup {
  const execution = context(cpl);
  execution.gdtr = { base: 0x402000n, limit: 0x3f };
  execution.idtr = { base: 0x403000n, limit: 0xfff };
  execution.tr = { selector: 0x38, valid: true, base: 0x409000n, limit: 0x67, attributes: 0x8b };
  const gdt = new Uint8Array(0x1000);
  gdt.set(little([0x00af9b000000ffffn, 0x00cf93000000ffffn]), 8);
  gdt.set(little([0x00cff3000000ffffn, 0x00affb000000ffffn]), 0x28);
  const idt = new Uint8Array(0x1000);
  for (const vector of [6, 13, 14]) idt.set(hex(gate(64, 8, HANDLER, 3)), vector * 16);
  const tss = new Uint8Array(0x1000);
  tss.set(little([TOP]), 4);
  const handlerBytes = new Uint8Array(0x1000).fill(0x82);
  handlerBytes.set(hex(handler));
  return {
    code,
    context: execution,
    bank: { ...BANK, cr2: 0xdeadn, efer: 0xd01n },
    words: [
      [0x4008n, 0xa007n],
      [0x4010n, 0xb007n],
      [0x4018n, 0xc007n],
      [0x4020n, 0xd007n],
      [0x4048n, 0xe007n],
    ],
    spans: [
      { physical: 0xa000n, bytes: handlerBytes, execute: true },
      { physical: 0xb000n, bytes: gdt },
      { physical: 0xc000n, bytes: idt },
      { physical: 0xd000n, bytes: new Uint8Array(0x1000).fill(0xa5) },
      { physical: 0xe000n, bytes: tss },
    ],
  };
}

function arm(cpu: Cpu, state: Partial<FastSystemState> = {}): void {
  cpu.setFastSystemState({ ...FAST, ...state });
}

export function fastSystemFaultScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'fast-system guest MSR views retain selected widths and one loaded FS GS authority across both submodes',
      async run() {
        for (const compatibility of [false, true])
          await usingPaged(
            compiler,
            {
              code: '0f320f3090',
              context: context(0, compatibility),
              bank: { ...BANK, efer: 0xd00n },
            },
            async (cpu) => {
              arm(cpu);
              for (const [index, value, expected] of [
                [0xc0000080n, 0xd01n, 0xd01n],
                [0xc0000081n, 0xfffc000700000000n, 0xfffc000700000000n],
                [0xc0000082n, 0xffff800000004000n, 0xffff800000004000n],
                [0xc0000084n, 0xffffffffn, 0xffffffffn],
                [0x174n, 0xfeedbeef12340008n, 0x12340008n],
                [0x175n, 0xffffffffffffffffn, 0xffffffffffffffffn],
                [0x176n, 0x7fffffffffffn, 0x7fffffffffffn],
                [0xc0000100n, 0xffff800000001000n, 0xffff800000001000n],
                [0xc0000101n, 0xffff800000002000n, 0xffff800000002000n],
                [0xc0000102n, 0xffff800000003000n, 0xffff800000003000n],
              ] as const) {
                const before = cpu.readContext();
                cpu.setState(
                  initial(
                    PC + 2n,
                    {
                      0: 0xaaaaaaaa00000000n | (value & 0xffffffffn),
                      2: 0xbbbbbbbb00000000n | (value >> 32n),
                      1: 0xcccccccc00000000n | index,
                    },
                    0x10202n,
                  ),
                );
                const written = await cpu.run({ budget: 1n });
                equal(written.reason, 'budget', `MSR ${index.toString(16)} write`);
                equal(written.retired, 1n, 'one WRMSR');
                equal(written.state.rip, PC + 4n, 'no fictitious operand bytes');
                equal(written.state.flags, 0x202n, 'WRMSR begins and clears RF');
                cpu.setState(
                  initial(
                    PC,
                    {
                      0: 0xffffffffffffffffn,
                      2: 0xffffffffffffffffn,
                      1: 0xcccccccc00000000n | index,
                    },
                    0x202n,
                  ),
                );
                const read = await cpu.run({ budget: 1n });
                equal(read.reason, 'budget', `MSR ${index.toString(16)} read`);
                equal(
                  read.state.registers[0],
                  expected & 0xffffffffn,
                  'EAX read zero-extends in both modes',
                );
                equal(
                  read.state.registers[2],
                  expected >> 32n,
                  'EDX read zero-extends in both modes',
                );
                equal(
                  read.state.registers[1],
                  0xcccccccc00000000n | index,
                  'ECX index ignores high bits without modifying RCX',
                );
                const after = cpu.readContext();
                if (index === 0xc0000100n || index === 0xc0000101n) {
                  const segment = index === 0xc0000100n ? 'fs' : 'gs';
                  same(
                    after,
                    {
                      ...before,
                      segments: {
                        ...before.segments,
                        [segment]: { ...before.segments[segment], base: expected },
                      },
                    },
                    'base write preserves every other loaded fact',
                  );
                } else same(after, before, 'non-base MSR preserves context');
              }
            },
          );
      },
    },
    {
      name: 'fast-system MSR privilege precedes unknown indices and value faults while reserved writes remain atomic',
      async run() {
        for (const compatibility of [false, true])
          await usingPaged(
            compiler,
            {
              code: '0f320f30',
              context: context(0, compatibility),
              bank: { ...BANK, cr2: 0xdeadn, efer: 0xd01n },
            },
            async (cpu) => {
              arm(cpu);
              for (const cpl of [1, 2, 3]) {
                cpu.setContext(context(cpl, compatibility));
                for (const index of [
                  0xc0000080n,
                  0xc0000081n,
                  0xc0000100n,
                  0xc0000083n,
                  0xffffffffn,
                ])
                  for (const offset of [0n, 2n]) {
                    const bank = cpu.readFastSystemState();
                    const execution = cpu.readContext();
                    cpu.setState(
                      initial(PC + offset, { 1: index, 0: 0xffffffffn, 2: 0xffffffffn }, 0x10202n),
                    );
                    const denied = await cpu.run({ budget: 1n });
                    equal(
                      denied.reason,
                      'protection-fault',
                      'CPL denial is architectural even for unknown MSRs',
                    );
                    equal(denied.retired, 0n, 'denied instruction does not retire');
                    equal(denied.protectionFault?.vector, 13, 'CPL fault vector');
                    equal(denied.protectionFault?.errorCode, 0, 'CPL hard-zero code');
                    equal(denied.protectionFault?.phase, 'privilege', 'privilege precedes index');
                    equal(denied.state.flags, 0x202n, 'runtime denial is after begin');
                    same(cpu.readFastSystemState(), bank, 'denied write bank unchanged');
                    same(cpu.readContext(), execution, 'denied write cache unchanged');
                  }
              }
              cpu.setContext(context(0, compatibility));
              for (const [index, value] of [
                [0xc0000081n, 0x0020000800000001n],
                [0xc0000084n, 0x100000000n],
                [0xc0000082n, 0x800000000000n],
                [0x175n, 0xffff7fffffffffffn],
                [0x176n, 0x800000000000n],
                [0xc0000100n, 0x800000000000n],
                [0xc0000101n, 0xffff7fffffffffffn],
                [0xc0000102n, 0x800000000000n],
              ] as const) {
                const bank = cpu.readFastSystemState();
                const execution = cpu.readContext();
                cpu.setState(
                  initial(PC + 2n, { 1: index, 0: value & 0xffffffffn, 2: value >> 32n }, 0x10202n),
                );
                const denied = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
                equal(denied.reason, 'event-budget', 'selected value fault can await delivery');
                check(denied.state.event.kind === 'pending', 'missing frozen value fault');
                equal(denied.state.event.exception.vector, 13, 'reserved or noncanonical MSR #GP');
                equal(denied.state.event.exception.errorCode, 0, 'value fault hard-zero');
                equal(denied.state.event.exception.returnPc, PC + 2n, 'write retry boundary');
                equal(denied.state.event.exception.savedFlags, 0x10202n, 'fault RF frame');
                same(cpu.readFastSystemState(), bank, 'failed write changes no bank word');
                same(cpu.readContext(), execution, 'failed write changes no context word');
                equal(cpu.readPagingState().cr2, 0xdeadn, 'nonmemory failure cannot change CR2');
              }
              for (const index of [0xc0000083n, 0xffffffffn]) {
                cpu.setState(initial(PC, { 1: index }, 0x10202n));
                const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
                equal(result.reason, 'unsupported', 'unknown MSR is private frontier');
                equal(result.retired, 0n, 'unknown read does not retire');
                same(
                  result.state.event,
                  { kind: 'ready' },
                  'unknown index is not a fabricated #GP',
                );
              }
            },
          );
      },
    },
    {
      name: 'fast-system own faults preserve source CPL and publish frozen UD GP with exact retry RF',
      async run() {
        for (const packet of [
          { code: '0f05', cpl: 3, sce: false, vector: 6 },
          { code: '480f07', cpl: 3, sce: false, vector: 6 },
          { code: '0f05', cpl: 3, sce: true, compatibility: true, vector: 6 },
          { code: '0f07', cpl: 0, sce: true, compatibility: true, vector: 6 },
          { code: '0f01f8', cpl: 0, sce: true, compatibility: true, vector: 6 },
          { code: '480f07', cpl: 3, sce: true, vector: 13 },
          { code: '480f35', cpl: 2, sce: false, vector: 13 },
          { code: '0f01f8', cpl: 1, sce: false, vector: 13 },
          { code: '480f07', cpl: 0, sce: true, vector: 13, rcx: 0x800000000000n },
          { code: '480f35', cpl: 0, sce: false, vector: 13, rdx: 0x800000000000n },
          { code: '0f34', cpl: 0, sce: false, vector: 13, cs: 0x12340000n },
          { code: 'f00f05', cpl: 3, sce: true, vector: 6 },
          { code: 'f00f01f8', cpl: 0, sce: false, vector: 6 },
        ])
          await usingPaged(
            compiler,
            {
              code: packet.code,
              context: context(packet.cpl, packet.compatibility),
              bank: { ...BANK, cr2: 0xdeadn, efer: packet.sce ? 0xd01n : 0xd00n },
            },
            async (cpu) => {
              arm(cpu, packet.cs === undefined ? {} : { sysenterCs: packet.cs });
              const bank = cpu.readFastSystemState();
              const execution = cpu.readContext();
              cpu.setState(
                initial(
                  PC,
                  {
                    1: packet.rcx ?? 0x400010n,
                    2: packet.rdx ?? 0x400010n,
                    4: 0x406000n,
                    11: 0x202n,
                  },
                  0x10202n,
                ),
              );
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              equal(result.reason, 'event-budget', `${packet.code} selected source fault`);
              equal(result.retired, 0n, 'fault did not retire');
              equal(result.deliveryAttempts, 0n, 'zero allowance did not enter');
              equal(result.state.rip, PC, 'source remains current');
              equal(result.state.flags, 0x202n, 'begun fault clears live RF');
              check(result.state.event.kind === 'pending', 'missing pending transfer fault');
              equal(result.state.event.exception.vector, packet.vector, 'source fault class');
              equal(
                result.state.event.exception.errorCode,
                packet.vector === 6 ? undefined : 0,
                'source error slot class',
              );
              equal(result.state.event.exception.savedFlags, 0x10202n, 'saved fault RF');
              same(cpu.readFastSystemState(), bank, 'fault bank atomicity');
              same(cpu.readContext(), execution, 'fault context atomicity');
              equal(cpu.readPagingState().cr2, 0xdeadn, 'transfer fault has no memory CR2');
            },
          );
      },
    },
    {
      name: 'fast-system guest GP handler repairs SYSRET RCX then IRET retries once before user fetch',
      async run() {
        await usingPaged(
          compiler,
          eventSetup('480f07' + '82'.repeat(13) + '90', '48b910004000000000004883c40848cf'),
          async (cpu) => {
            arm(cpu);
            cpu.setState(initial(PC, { 1: 0x800000000000n, 4: TOP, 11: 0x202n }, 0x202n));
            const first = await cpu.run({
              budget: 16n,
              stop: HANDLER,
              eventDelivery: { budget: 1n },
            });
            equal(first.reason, 'stop', 'GP handler entered');
            equal(first.retired, 0n, 'bad SYSRET did not commit');
            equal(first.deliveryAttempts, 1n, 'one #GP entry');
            equal(cpu.readContext().cpl, 0, 'Intel SYSRET fault stays in kernel');
            same(
              cpu.readPhysicalMemory(0xdfd0n, 48),
              little([0n, PC, 8n, 0x10202n, TOP, 16n]),
              'literal kernel hard-zero error frame',
            );
            const repaired = await cpu.run({
              budget: 16n,
              stop: PC + 16n,
              eventDelivery: { budget: 0n },
            });
            equal(repaired.reason, 'stop', 'repaired SYSRET reached user boundary');
            equal(repaired.retired, 4n, 'three handler instructions and one successful SYSRET');
            equal(repaired.deliveryAttempts, 0n, 'retry makes no new fault');
            equal(repaired.state.registers[4], TOP, 'IRET frame removed and SYSRET preserves RSP');
            equal(repaired.state.flags, 0x202n, 'SYSRET restores user flags after retry');
            equal(cpu.readContext().cpl, 3, 'return committed user privilege');
            equal(cpu.readContext().segments.cs.selector, 0x33, 'literal user CS');
            equal(cpu.readContext().segments.ss.selector, 0x2b, 'literal user SS');
          },
        );
      },
    },
    {
      name: 'fast-system user UD handler programs EFER SCE with guest RDMSR WRMSR and retries SYSCALL after IRET',
      async run() {
        const setup = eventSetup('0f05', 'b9800000c00f320d010000000f3048cf', 3);
        setup.bank = { ...BANK, cr2: 0xdeadn, efer: 0xd00n };
        await usingPaged(compiler, setup, async (cpu) => {
          arm(cpu, { lstar: HANDLER + 0x100n });
          cpu.setState(initial(PC, { 4: 0x406000n }, 0x202n));
          const first = await cpu.run({
            budget: 16n,
            stop: HANDLER,
            eventDelivery: { budget: 1n },
          });
          equal(first.reason, 'stop', 'SCE-disabled source entered #UD handler');
          equal(first.retired, 0n, 'disabled source did not retire');
          equal(first.deliveryAttempts, 1n, 'one #UD delivery');
          same(
            cpu.readPhysicalMemory(0xdfd8n, 40),
            little([PC, 0x33n, 0x10202n, 0x406000n, 0x2bn]),
            'literal user fault frame has no error slot',
          );
          const repaired = await cpu.run({
            budget: 16n,
            stop: HANDLER + 0x100n,
            eventDelivery: { budget: 0n },
          });
          equal(repaired.reason, 'stop', 'guest-enabled SYSCALL reached kernel');
          equal(repaired.retired, 6n, 'five handler instructions then SYSCALL');
          equal(cpu.readPagingState().efer, 0xd01n, 'guest repair set only SCE');
          equal(cpu.readPagingState().cr2, 0xdeadn, 'nonmemory repair retains CR2');
          equal(repaired.state.registers[1], PC + 2n, 'retried SYSCALL saves actual next PC');
          equal(
            repaired.state.registers[11],
            0x202n,
            'retried SYSCALL captures RF cleared before R11',
          );
          equal(repaired.state.registers[4], 0x406000n, 'SYSCALL still does not switch user stack');
          equal(cpu.readContext().cpl, 0, 'kernel entry committed');
        });
      },
    },
    {
      name: 'fast-system target PF and private X refusal retain each committed entry return and retry only the fetch',
      async run() {
        for (const [code, entry, length] of [
          ['0f05', true, 2],
          ['0f34', true, 2],
          ['480f07', false, 3],
          ['480f35', false, 3],
        ] as const)
          for (const failure of ['absent', 'nx', 'private'] as const)
            await usingPaged(
              compiler,
              {
                code,
                context: context(entry ? 3 : 0),
                bank: { ...BANK, cr2: 0xdeadn, efer: 0xd01n },
                words: [
                  [
                    0x4008n,
                    failure === 'absent' ? 0n : failure === 'nx' ? 0x800000000000a007n : 0xa007n,
                  ],
                ],
                spans: [{ physical: 0xa000n, bytes: hex('90'), execute: failure !== 'private' }],
              },
              async (cpu) => {
                arm(cpu);
                cpu.setState(
                  initial(
                    PC,
                    { 1: code === '480f35' ? TOP : HANDLER, 2: HANDLER, 4: 0x406000n, 11: 0x202n },
                    0x202n,
                  ),
                );
                const first = await cpu.run({ budget: 2n });
                equal(
                  first.reason,
                  failure === 'private' ? 'physical-memory-fault' : 'page-fault',
                  `${code} target ${failure}`,
                );
                equal(first.retired, 1n, 'only transfer retired before target refusal');
                equal(first.state.rip, HANDLER, 'committed destination remains current');
                equal(cpu.readContext().cpl, entry ? 0 : 3, 'target uses destination privilege');
                if (failure === 'private') {
                  equal(
                    first.physicalMemoryFault?.instructionPc,
                    HANDLER,
                    'private fetch source is destination',
                  );
                  equal(
                    first.physicalMemoryFault?.physicalAddress,
                    0xa000n,
                    'target physical address',
                  );
                  equal(first.physicalMemoryFault?.phase, 'final-access', 'not a page walk fault');
                  equal(first.pageFault, undefined, 'private refusal has no #PF');
                  equal(cpu.readPagingState().cr2, 0xdeadn, 'private refusal retains CR2');
                } else {
                  equal(first.pageFault?.instructionPc, HANDLER, 'PF source is destination fetch');
                  equal(
                    first.pageFault?.errorCode,
                    (entry ? 16 : 20) + (failure === 'nx' ? 1 : 0),
                    'PF code uses destination CPL and fetch class',
                  );
                  equal(cpu.readPagingState().cr2, HANDLER, 'target PF publishes CR2');
                }
                const committed = first.state;
                arm(cpu, { lstar: HANDLER + 0x100n, sysenterEip: HANDLER + 0x100n });
                if (failure === 'private')
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
                else cpu.writePhysicalMemory(0x4008n, little([0xa007n]));
                const resumed = await cpu.run({ budget: 1n });
                equal(resumed.reason, 'budget', 'repaired destination NOP completed');
                equal(resumed.retired, 1n, 'resume did not replay transfer');
                equal(resumed.state.rip, HANDLER + 1n, 'repair does not reread changed entry MSR');
                same(
                  resumed.state.registers,
                  committed.registers,
                  'NOP preserves committed transfer registers',
                );
                equal(
                  resumed.state.registers[4],
                  code === '0f34' || code === '480f35' ? TOP : 0x406000n,
                  'stack handover is retained',
                );
                if (code === '0f05')
                  equal(
                    resumed.state.registers[1],
                    PC + BigInt(length),
                    'SYSCALL saved next is retained',
                  );
              },
            );
      },
    },
    {
      name: 'fast-system final canonical SYSCALL captures a noncanonical next RCX and only SYSRET rejects it',
      async run() {
        const code = new Uint8Array(0x1000).fill(0x82);
        code.set(hex('0f05'), 0xffe);
        await usingPaged(
          compiler,
          {
            context: context(3),
            bank: { ...BANK, efer: 0xd01n },
            words: [
              [0x17f8n, 0x2007n],
              [0x2ff8n, 0x3007n],
              [0x3ff8n, 0x4007n],
              [0x4ff8n, 0xb007n],
              [0x4008n, 0xa007n],
            ],
            spans: [
              { physical: 0xa000n, bytes: hex('480f07'), execute: true },
              { physical: 0xb000n, bytes: code, execute: true },
            ],
          },
          async (cpu) => {
            arm(cpu);
            cpu.setState(initial(0x7ffffffffffen, { 4: TOP }, 0x202n));
            const entered = await cpu.run({ budget: 1n });
            equal(entered.reason, 'budget', 'entry succeeds at canonical edge');
            equal(entered.retired, 1n, 'SYSCALL completed');
            equal(entered.state.rip, HANDLER, 'canonical entry target');
            equal(entered.state.registers[1], 0x800000000000n, 'saved next may be noncanonical');
            equal(cpu.readContext().cpl, 0, 'entry committed kernel context');
            const returned = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(returned.reason, 'event-budget', 'SYSRET detects saved invalid return');
            equal(returned.retired, 0n, 'bad return does not commit');
            equal(returned.state.rip, HANDLER, 'fault is the kernel SYSRET');
            equal(cpu.readContext().cpl, 0, 'source kernel CPL retained');
            check(returned.state.event.kind === 'pending', 'missing selected SYSRET fault');
            equal(returned.state.event.exception.vector, 13, 'noncanonical SYSRET #GP');
            equal(returned.state.event.exception.errorCode, 0, 'noncanonical hard-zero code');
            equal(word(cpu, 0x4ff8n), 0xb027n, 'only reached source fetch acquired A');
          },
        );
      },
    },
  ];
}
