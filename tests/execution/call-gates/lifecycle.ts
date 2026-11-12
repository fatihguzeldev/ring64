import {
  usingGate,
  initial,
  complete,
  equal,
  same,
  read,
  scalar,
  little,
  put,
  hex,
  gateDescriptor,
  codeDescriptor,
  SOURCE,
  TARGET,
  GDT,
  TSS,
  type Scenario,
} from './fixture.js';

export function gateLifecycleScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'call gate callee consumes copied arguments before matched outer byte cleanup',
      async run() {
        await usingGate(
          compiler,
          {
            count: 3,
            targetCode: '8b4424080344240c03442410ca0c00',
            prepare(memory) {
              put(memory, 0x4000, 0xa1n, 4);
              put(memory, 0x4004, 0xb2n, 4);
              put(memory, 0x4008, 0xc3n, 4);
            },
          },
          async (cpu) => {
            cpu.setState(initial(SOURCE, { 4: 0x4000n }));
            complete(await cpu.run({ budget: 1n }));
            const callee = await cpu.run({ budget: 3n });
            complete(callee, 3n);
            equal(
              callee.state.registers[0],
              0x1122334400000216n,
              'callee sums low32 and preserves the protected raw upper bank',
            );
            equal(
              callee.state.registers[4],
              0x8fe4n,
              'callee reads frame without caller stack access',
            );
            const returned = await cpu.run({ budget: 1n });
            complete(returned);
            equal(returned.state.rip, 0x1007n, 'caller resumes after CALL');
            equal(
              returned.state.registers[0],
              0x1122334400000216n,
              'callee result survives redispatch and RETF',
            );
            equal(returned.state.registers[4], 0x400cn, 'argument cleanup on both stacks');
          },
        );
      },
    },
    {
      name: 'call gate retained middle observes dirty live SP based operand and preserves complete raw banks',
      async run() {
        await usingGate(
          compiler,
          {
            code: 'b80440000089c4ff1c24',
            count: 1,
            prepare(memory) {
              put(memory, 0x4004, 0xffffffffn, 4);
              put(memory, 0x4008, 0x3bn, 2);
            },
          },
          async (cpu) => {
            const before = initial(SOURCE, { 4: 0xdeadbeefn }, 0x402n);
            cpu.setState(before);
            const prefix = await cpu.run({ budget: 1n });
            complete(prefix);
            equal(
              prefix.state.registers[0],
              0x1122334400004004n,
              'dirty protected32 predecessor retains the raw upper bank',
            );
            equal(prefix.state.rip, 0x1005n, 'retained middle boundary');
            const entered = await cpu.run({ budget: 2n, repeatBudget: 0n });
            complete(entered, 2n);
            equal(entered.resources.compilations, 0, 'retained middle does not retranslate');
            equal(entered.state.rip, TARGET, 'captured runtime gate');
            equal(
              entered.state.registers[0],
              0x1122334400004004n,
              'live AX bank not overwritten by stale source snapshot',
            );
            equal(
              entered.state.registers[4],
              0x8fecn,
              'new frame uses TSS while operand used live old SP',
            );
            equal(scalar(cpu, 0x8fecn, 4), 0x100an, 'full source completion PC');
            equal(
              scalar(cpu, 0x8ff4n, 4),
              0xffffffffn,
              'captured old parameter is ignored pointer offset value',
            );
            equal(scalar(cpu, 0x8ff8n, 4), 0x4004n, 'saved raw pointer reflects dirty predecessor');
            for (let i = 1; i < 16; i++)
              if (i !== 4)
                equal(entered.state.registers[i], before.registers[i], `unchanged live bank ${i}`);
            equal(entered.state.flags, 0x402n, 'non-numeric gate preserves live flags');
          },
        );
      },
    },
    {
      name: 'call gate runtime selector reclassifies code gate code and context A B A reuse never retains descriptor meaning',
      async run() {
        await usingGate(
          compiler,
          {
            code: '9a003000003b00',
            targetCpl: 3,
            targetCode: 'cb',
            prepare(memory) {
              memory[0x3000] = 0xcb;
            },
          },
          async (cpu) => {
            const a = cpu.readContext();
            const before = initial(SOURCE, { 4: 0x4000n });
            for (const gate of [false, true, false, true]) {
              cpu.writeMemory(GDT + 0x38n, gate ? gateDescriptor(32) : codeDescriptor(32, 3));
              cpu.setContext(a);
              cpu.setState(before);
              const entered = await cpu.run({ budget: 1n });
              complete(entered);
              equal(
                entered.state.rip,
                gate ? TARGET : 0x3000n,
                'current descriptor class determines target',
              );
              equal(
                cpu.readContext().segments.cs.selector,
                gate ? 0x0b : 0x3b,
                'current class determines loaded selector',
              );
              complete(await cpu.run({ budget: 1n }));
              equal(
                cpu.readContext().segments.cs.selector,
                0x1b,
                'return admits original source cache',
              );
            }
            const b = structuredClone(a);
            b.cpl = 2;
            b.segments.cs.dpl = 2;
            b.segments.cs.selector = 0x1a;
            b.segments.ss.dpl = 2;
            b.segments.ss.selector = 0x22;
            cpu.setContext(b);
            cpu.setState(before);
            const denied = await cpu.run({ budget: 1n });
            equal(
              denied.reason,
              'protection-fault',
              'new source CPL cannot call higher nonconforming DPL3',
            );
            equal(denied.protectionFault?.errorCode, 8, 'current target descriptor identity');
            cpu.setContext(a);
            cpu.setState(before);
            const reused = await cpu.run({ budget: 1n });
            complete(reused);
            equal(reused.resources.compilations, 0, 'original context owner is still reusable');
            equal(reused.state.rip, TARGET, 'A context recovers original runtime admission');
          },
        );
      },
    },
    {
      name: 'call gate budget stop artifact refusal and target translation refusal preserve one atomic frame without replay',
      async run() {
        for (const kind of ['zero', 'stop', 'artifact', 'target'] as const)
          await usingGate(
            compiler,
            {
              limit:
                kind === 'artifact'
                  ? { maxArtifactBytes: 1 }
                  : kind === 'target'
                    ? { maxTranslationsPerRun: 1 }
                    : {},
            },
            async (cpu) => {
              const before = initial(SOURCE, { 4: 0x4000n }, 0x10202n);
              const context = cpu.readContext();
              const frame = read(cpu, 0x8ff0n, 16);
              cpu.setState(before);
              const result = await cpu.run({
                budget: kind === 'zero' ? 0n : kind === 'target' ? 2n : 1n,
                ...(kind === 'stop' ? { stop: SOURCE } : {}),
                repeatBudget: 0n,
              });
              equal(
                result.reason,
                kind === 'zero' ? 'budget' : kind === 'stop' ? 'stop' : 'resource-limit',
                'selected lifecycle gate',
              );
              if (kind === 'target') {
                equal(result.retired, 1n, 'gate completed before target resource refusal');
                equal(result.state.rip, TARGET, 'no source replay at target refusal');
                equal(result.state.registers[4], 0x8ff0n, 'single committed frame');
                const committed = read(cpu, 0x8ff0n, 16);
                const returned = await cpu.run({ budget: 1n });
                complete(returned);
                equal(returned.state.rip, 0x1007n, 'resumed target RETF returns once');
                equal(returned.state.registers[4], 0x4000n, 'no duplicate frame');
                same(read(cpu, 0x8ff0n, 16), committed, 'return did not re-execute CALL payload');
              } else {
                equal(result.retired, 0n, 'before-begin admission');
                same(result.state, before, 'no begin or raw bank change');
                same(cpu.readContext(), context, 'no loaded cache change');
                same(read(cpu, 0x8ff0n, 16), frame, 'no speculative frame');
              }
            },
          );
      },
    },
    {
      name: 'call gate fresh TSS fields and parameters are runtime data across checkpoint return and reset lifecycle',
      async run() {
        await usingGate(
          compiler,
          { family: 'pg0', count: 1, targetCode: 'ca0400' },
          async (cpu) => {
            const context = cpu.readContext();
            const paging = cpu.readPagingState();
            for (const [pointer, value] of [
              [0x9000n, 0x11n],
              [0xa000n, 0x22n],
            ] as const) {
              cpu.writePhysicalMemory(TSS + 4n, little(pointer, 4));
              cpu.writePhysicalMemory(0x4000n, little(value, 4));
              cpu.setContext(context);
              cpu.setState(initial(SOURCE, { 4: 0x4000n }));
              complete(await cpu.run({ budget: 1n }));
              equal(cpu.readState().registers[4], pointer - 20n, 'fresh selected TSS ESP');
              equal(scalar(cpu, pointer - 12n, 4, 'pg0'), value, 'fresh captured parameter');
              const entered = cpu.readState();
              cpu.setContext(cpu.readContext());
              cpu.setState(entered);
              complete(await cpu.run({ budget: 1n }));
              equal(
                cpu.readState().registers[4],
                0x4004n,
                'checkpoint retains full outer frame semantics',
              );
            }
            cpu.requestInterrupt(32);
            cpu.requestNmi();
            cpu.reset();
            equal(cpu.inspectTranslations().length, 0, 'reset drops gate and target owners');
            same(
              cpu.readState().interrupts,
              { irq: null, nmiPending: false, nmiBlocked: false },
              'reset has no retained gate event intake',
            );
            const reset = cpu.readContext();
            reset.segments.cs = {
              ...reset.segments.cs,
              selector: 0,
              base: 0n,
              default32: true,
              limit: 0xffffffff,
              type: 'readable-code',
            };
            cpu.setContext(reset);
            cpu.writePhysicalMemory(0x3000n, hex('0f22c0'));
            cpu.setState(initial(0x3000n, { 0: 0x33n, 4: 0x9000n }));
            complete(await cpu.run({ budget: 1n }));
            equal(
              cpu.readContext().mode,
              'protected',
              'guest MOV CR0 restores the protected execution family',
            );
            cpu.setPagingState(paging);
            cpu.setContext(context);
            cpu.setState(initial(SOURCE, { 4: 0x4000n }));
            complete(await cpu.run({ budget: 1n }));
            equal(
              cpu.readState().registers[4],
              0x9fecn,
              'reset retained RAM but rebuilt execution owner',
            );
          },
        );
      },
    },
    {
      name: 'call gate consumes incoming SS shadow without adding a shadow and queued IRQ uses the completed kernel boundary',
      async run() {
        await usingGate(
          compiler,
          {
            prepare(memory, context) {
              context.idtr = { base: 0xa000n, limit: 0x7ff };
              memory.set(hex('00300800008e0000'), 0xa100);
            },
          },
          async (cpu) => {
            cpu.setState({
              ...initial(SOURCE, { 4: 0x4000n }, 0x202n),
              interruptibility: { sti: false, ss: true },
              interrupts: { irq: 32, nmiPending: true, nmiBlocked: true },
            });
            const entered = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(
              entered.reason,
              'event-budget',
              'newly eligible IRQ is selected before the post-work instruction budget',
            );
            equal(entered.retired, 1n, 'gate completed exactly once before IRQ selection');
            equal(
              entered.deliveryAttempts,
              0n,
              'source selection does not attempt an entry with allowance0',
            );
            same(
              entered.state.interruptibility,
              { sti: false, ss: false },
              'CALL creates no MOV SS interval',
            );
            same(
              entered.state.interrupts,
              { irq: null, nmiPending: true, nmiBlocked: true },
              'only IRQ accepted while NMI remains blocked',
            );
            same(
              entered.state.event,
              {
                kind: 'pending-interrupt',
                interrupt: {
                  source: { kind: 'irq', vector: 32 },
                  returnPc: TARGET,
                  savedFlags: 0x202n,
                },
              },
              'frozen IRQ source uses completed gate destination',
            );
            const frame = read(cpu, 0x8ff0n, 16);
            const irq = await cpu.run({ budget: 1n, stop: 0x3000n, eventDelivery: { budget: 1n } });
            equal(irq.reason, 'stop', 'IRQ enters at next eligible destination boundary');
            equal(irq.retired, 0n, 'callee has not run');
            equal(irq.deliveryAttempts, 1n, 'one IRQ acceptance and entry');
            equal(irq.state.registers[4], 0x8fe4n, 'same-CPL IRQ adds exactly three dword slots');
            for (const [i, value] of [TARGET, 8n, 0x202n].entries())
              equal(
                scalar(cpu, 0x8fe4n + BigInt(i * 4), 4),
                value,
                'IRQ source uses kernel destination slot ' + i,
              );
            same(read(cpu, 0x8ff0n, 16), frame, 'gate frame not replayed or overwritten');
            same(
              irq.state.interrupts,
              { irq: null, nmiPending: true, nmiBlocked: true },
              'CALL never unblocks NMI',
            );
          },
        );
      },
    },
  ];
}
