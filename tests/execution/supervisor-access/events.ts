import { createCpu } from '../../../host/index.js';
import { longSnapshot } from '../../support/context.js';
import { execution, input, using as usingProfile } from '../identity-time/oracle.js';
import {
  AC,
  AUX,
  DATA,
  PC,
  SMEP,
  SMAP,
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

export function supervisorEventScenarios(compiler: WebAssembly.Module): Scenario[] {
  const side = { createCpu, compiler };
  return [
    {
      name: 'supervisor real PG0 INT clears AC and its word IRET cannot restore an unsaved upper bit',
      async run() {
        const profile = { mode: 'real', bits: 16, stack: 16, family: 'pg0' } as const;
        await usingProfile(side, 'cd4090', profile, async (cpu) => {
          const bank = cpu.readPagingState();
          cpu.setPagingState({ ...bank, cr4: bank.cr4 | SMEP | SMAP });
          cpu.writePhysicalMemory(0x7100n, hex('00200000'));
          cpu.writePhysicalMemory(0x2000n, hex('cf'));
          const before = input(profile);
          before.flags = 0x202n | AC;
          cpu.setState(before);
          cpu.setTimeState({ tsc: 100n, tscAux: AUX });
          const numeric = preserved(cpu),
            context = cpu.readContext(),
            expectedMemory = cpu.readPhysicalMemory(0n, 0x50000);
          // Real-mode entry saves FLAGS/CS/IP as words even though AC was set.
          for (const [at, value] of [
            [0x8ffa, PC + 2n],
            [0x8ffc, 0n],
            [0x8ffe, 0x202n],
          ] as const)
            put(expectedMemory, at, value, 2);
          const entered = await cpu.run({ budget: 1n });
          const handler = structuredClone(before);
          handler.rip = 0x2000n;
          handler.flags = 2n;
          handler.registers[4] = 0x8ffan;
          same(entered.reason, 'budget', 'real INT completes');
          same(entered.retired, 1n, 'one real INT retirement');
          same(entered.state, handler, 'real entry clears AC and IF with exact word frame');
          same(cpu.readTimeState(), { tsc: 101n, tscAux: AUX }, 'real entry tick');
          memory(cpu, expectedMemory, 'real entry complete physical image');
          const returned = await cpu.run({ budget: 1n });
          same(returned.reason, 'budget', 'word IRET completes');
          same(returned.retired, 1n, 'one word IRET retirement');
          same(
            returned.state,
            { ...before, rip: PC + 2n, flags: 0x202n },
            'word IRET leaves AC clear',
          );
          same(cpu.readContext(), context, 'real IRET restores the exact context');
          same(cpu.readTimeState(), { tsc: 102n, tscAux: AUX }, 'real entry and return two ticks');
          memory(cpu, expectedMemory, 'word IRET retains its truncated saved frame');
          numeric();
        });
      },
    },
    {
      name: 'supervisor SYSCALL SFMASK AC clear and keep select the following real SMAP load',
      async run() {
        for (const family of ['ia32e', 'fixed'] as const)
          for (const clearAc of [false, true]) {
            const f = fixture(side, family, '0f05', { cpl: 3 });
            f.paging.cr4 |= SMEP | SMAP;
            f.paging.efer |= 1n;
            f.leaf(Number(DATA), 0xa067n);
            f.bytes.set(hex('8b03'), 0x9000);
            await using(side, f, async (cpu) => {
              const fast = {
                ...cpu.readFastSystemState(),
                star: 0x0020000800000000n,
                lstar: 0x4000n,
                fmask: 0x200n | (clearAc ? AC : 0n),
              };
              cpu.setFastSystemState(fast);
              const before = state(0x202n | AC);
              cpu.setState(before);
              cpu.setTimeState({ tsc: 100n, tscAux: AUX });
              const numeric = preserved(cpu),
                sourceContext = cpu.readContext(),
                kernelSegments = longSnapshot().segments;
              const entered = await cpu.run({ budget: 1n });
              const kernel = structuredClone(before);
              kernel.registers[1] = PC + 2n;
              kernel.registers[11] = 0x202n | AC;
              kernel.flags = 2n | (clearAc ? 0n : AC);
              kernel.rip = 0x4000n;
              const kernelContext = {
                ...sourceContext,
                cpl: 0,
                segments: {
                  ...sourceContext.segments,
                  cs: kernelSegments.cs,
                  ss: kernelSegments.ss,
                },
              };
              same(entered.reason, 'budget', 'SYSCALL completes before operand acquisition');
              same(entered.retired, 1n, 'SYSCALL retirement');
              same(entered.state, kernel, 'SYSCALL complete GPR and SFMASK packet');
              same(
                cpu.readContext(),
                kernelContext,
                'synthetic kernel context and preserved segments',
              );
              same(cpu.readTimeState(), { tsc: 101n, tscAux: AUX }, 'SYSCALL tick');
              const loaded = await cpu.run({ budget: 1n });
              const expected = structuredClone(kernel);
              if (!clearAc) {
                expected.registers[0] = 0x78563412n;
                expected.rip = 0x4002n;
              }
              same(
                loaded.reason,
                clearAc ? 'page-fault' : 'budget',
                'destination observes SFMASK AC',
              );
              same(loaded.retired, clearAc ? 0n : 1n, 'only permitted destination load retires');
              same(loaded.state, expected, 'destination complete scalar packet');
              same(
                loaded.pageFault,
                clearAc
                  ? {
                      instructionPc: 0x4000n,
                      vector: 14,
                      address: DATA,
                      access: 'read',
                      errorCode: 1,
                    }
                  : undefined,
                'destination exact SMAP source',
              );
              same(
                cpu.readTimeState(),
                { tsc: clearAc ? 101n : 102n, tscAux: AUX },
                'destination exact ticks',
              );
              same(cpu.readContext(), kernelContext, 'destination keeps installed kernel context');
              same(cpu.readFastSystemState(), fast, 'SYSCALL preserves the fast-system bank');
              same(
                cpu.readPagingState(),
                { ...f.paging, cr2: clearAc ? DATA : f.paging.cr2 },
                'destination paging bank',
              );
              memory(cpu, f.bytes, 'SYSCALL and load preserve the full physical image');
              numeric();
            });
          }
      },
    },
    {
      name: 'supervisor active v86 traffic stays user under SMEP SMAP and AC cannot override effective supervisor pages',
      async run() {
        for (const upperUser of [false, true])
          for (const sourceUser of [false, true])
            for (const dataUser of [false, true])
              for (const ac of [false, true]) {
                const f = fixture(side, 'non-pae', '66678b03', { bits: 16, cpl: 3 });
                f.options.context = execution({ mode: 'virtual8086', bits: 16, stack: 16, cpl: 3 });
                f.paging.cr4 |= SMEP | SMAP;
                put(f.bytes, f.upper, upperUser ? 0x2027n : 0x2023n, 4);
                f.leaf(Number(PC), 0x8063n | (sourceUser ? 4n : 0n));
                f.leaf(Number(DATA), 0xa063n | (dataUser ? 4n : 0n));
                await using(side, f, async (cpu) => {
                  const before = state(0x3002n | (ac ? AC : 0n));
                  cpu.setState(before);
                  cpu.setTimeState({ tsc: 100n, tscAux: AUX });
                  const numeric = preserved(cpu),
                    context = cpu.readContext();
                  const result = await cpu.run({ budget: 1n });
                  const fetchAllowed = upperUser && sourceUser,
                    allowed = fetchAllowed && dataUser,
                    expected = structuredClone(before);
                  if (allowed) {
                    expected.registers[0] = 0x1122334478563412n;
                    expected.rip = PC + 4n;
                  }
                  same(
                    result.reason,
                    allowed ? 'budget' : 'page-fault',
                    'v86 effective user permission',
                  );
                  same(result.retired, allowed ? 1n : 0n, 'v86 exact retirement');
                  same(result.state, expected, 'v86 complete raw flags and scalar packet');
                  same(
                    result.pageFault,
                    allowed
                      ? undefined
                      : {
                          instructionPc: PC,
                          vector: 14,
                          address: fetchAllowed ? DATA : PC,
                          access: fetchAllowed ? 'read' : 'execute',
                          errorCode: fetchAllowed ? 5 : 0x15,
                        },
                    'v86 requester PFEC and SMEP fetch I/D',
                  );
                  same(
                    cpu.readTimeState(),
                    { tsc: allowed ? 101n : 100n, tscAux: AUX },
                    'v86 tick ledger',
                  );
                  same(
                    cpu.readPagingState(),
                    { ...f.paging, cr2: allowed ? f.paging.cr2 : fetchAllowed ? DATA : PC },
                    'v86 controls and CR2',
                  );
                  same(cpu.readContext(), context, 'v86 context remains active');
                  memory(cpu, f.bytes, 'v86 no page or payload mutation');
                  numeric();
                });
              }
      },
    },
    {
      name: 'supervisor runtime AC privilege UD discards old SS history after one RF begin on cold warm and middle entries',
      async run() {
        for (const cpl of [1, 2, 3])
          for (const opcode of ['0f01ca', '0f01cb'])
            for (const middle of [false, true]) {
              const f = fixture(side, 'non-pae', (middle ? '90' : '') + opcode, { cpl });
              await using(side, f, async (cpu) => {
                if (middle) {
                  cpu.setState(state());
                  const warmup = await cpu.run({ budget: 1n });
                  same(warmup.reason, 'budget', 'warm prefix reaches retained opcode entry');
                  same(warmup.retired, 1n, 'only warm prefix retires');
                  same(warmup.state.rip, PC + 1n, 'retained middle PC');
                }
                const pc = PC + (middle ? 1n : 0n);
                const before = state(0x10202n | (opcode === '0f01ca' ? AC : 0n), pc);
                before.interruptibility = { sti: false, ss: true };
                before.debugContinuation = { breakpoints: 8, originPc: PC - 1n };
                cpu.setTimeState({ tsc: 100n, tscAux: AUX });
                const numeric = preserved(cpu),
                  debug = cpu.readDebugState(),
                  context = cpu.readContext();
                for (const delivery of [false, true]) {
                  cpu.setState(before);
                  const result = await cpu.run({
                    budget: 1n,
                    ...(delivery ? { eventDelivery: { budget: 0n } } : {}),
                  });
                  const expected = {
                    ...before,
                    flags: before.flags & ~0x10000n,
                    debugContinuation: undefined,
                    event: delivery
                      ? {
                          kind: 'pending',
                          exception: {
                            vector: 6,
                            instructionPc: pc,
                            returnPc: pc,
                            savedFlags: before.flags,
                          },
                        }
                      : before.event,
                  };
                  same(
                    result.reason,
                    delivery ? 'event-budget' : 'invalid-encoding',
                    'runtime UD reporting boundary',
                  );
                  same(result.retired, 0n, 'runtime UD no retirement');
                  same(result.remaining, 1n, 'runtime UD no budget consumption');
                  same(result.state, expected, 'runtime UD RF AC SS history and no-error source');
                  same(
                    result.resources.compilations,
                    middle || delivery ? 0 : 1,
                    'cold warm and middle owner reuse',
                  );
                  same(result.resources.nativeEntries, 1, 'one reached generated attempt');
                  same(cpu.readTimeState(), { tsc: 100n, tscAux: AUX }, 'runtime UD no tick');
                  same(cpu.readDebugState(), debug, 'old deferred slots do not publish DR6');
                  same(cpu.readContext(), context, 'runtime UD has no context publication');
                  memory(cpu, f.bytes, 'runtime UD no operand or source writes');
                  numeric();
                }
              });
            }
      },
    },
    {
      name: 'supervisor protected IRET replaces handler STAC with saved AC before the following user load',
      async run() {
        for (const savedAc of [false, true]) {
          const f = fixture(side, 'non-pae', 'cd408b03');
          f.paging.cr4 |= SMAP;
          f.leaf(Number(DATA), 0xa067n);
          f.bytes.set(hex('00400800008e0000'), 0xc200);
          f.bytes.set(hex('0f01cbcf'), 0x9000);
          await using(side, f, async (cpu) => {
            const before = state(0x202n | (savedAc ? AC : 0n));
            cpu.setState(before);
            cpu.setTimeState({ tsc: 100n, tscAux: AUX });
            const numeric = preserved(cpu),
              context = cpu.readContext();
            const expectedMemory = f.bytes.slice();
            for (const [at, value] of [
              [0xdfe4, PC + 2n],
              [0xdfe8, 8n],
              [0xdfec, before.flags],
            ] as const)
              put(expectedMemory, at, value, 4);
            const entered = await cpu.run({ budget: 1n });
            const handler = structuredClone(before);
            handler.rip = 0x4000n;
            handler.flags = 2n | (savedAc ? AC : 0n);
            handler.registers[4] = 0x9fe4n;
            same(entered.reason, 'budget', 'protected INT completes');
            same(entered.retired, 1n, 'one protected INT retirement');
            same(entered.state, handler, 'protected INT preserves incoming AC');
            const set = await cpu.run({ budget: 1n });
            same(set.reason, 'budget', 'handler STAC completes');
            same(set.retired, 1n, 'one handler STAC retirement');
            same(
              set.state,
              { ...handler, rip: 0x4003n, flags: 2n | AC },
              'handler has live AC1 before return',
            );
            const returned = await cpu.run({ budget: 1n });
            const resumed = { ...before, rip: PC + 2n };
            same(returned.reason, 'budget', 'protected IRETD completes');
            same(returned.retired, 1n, 'one protected IRET retirement');
            same(returned.state, resumed, 'wide IRET restores saved AC rather than handler AC');
            same(cpu.readContext(), context, 'protected IRET exact context');
            same(cpu.readTimeState(), { tsc: 103n, tscAux: AUX }, 'INT STAC IRET ledger');
            const loaded = await cpu.run({ budget: 1n });
            const expected = structuredClone(resumed);
            if (savedAc) {
              expected.registers[0] = 0x1122334478563412n;
              expected.rip = PC + 4n;
            }
            same(
              loaded.reason,
              savedAc ? 'budget' : 'page-fault',
              'post-IRET actual helper AC policy',
            );
            same(loaded.retired, savedAc ? 1n : 0n, 'post-IRET load retirement');
            same(loaded.state, expected, 'post-IRET full scalar packet');
            same(
              loaded.pageFault,
              savedAc
                ? undefined
                : {
                    instructionPc: PC + 2n,
                    vector: 14,
                    address: DATA,
                    access: 'read',
                    errorCode: 1,
                  },
              'post-IRET exact SMAP source',
            );
            same(
              cpu.readTimeState(),
              { tsc: savedAc ? 104n : 103n, tscAux: AUX },
              'post-IRET tick ledger',
            );
            memory(cpu, expectedMemory, 'post-IRET payload and saved frame image');
            numeric();
          });
        }
      },
    },
  ];
}
