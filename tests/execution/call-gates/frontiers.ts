import {
  usingGate,
  initial,
  complete,
  equal,
  same,
  read,
  scalar,
  hex,
  SOURCE,
  TARGET,
  type Scenario,
} from './fixture.js';

export function gateFrontierScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'call gate64 JMP handles same and conforming targets without TSS or stack traffic and rejects an inner target',
      async run() {
        for (const mode of ['compatibility', 'long64'] as const)
          for (const kind of ['same', 'conforming', 'inner'] as const)
            await usingGate(
              compiler,
              {
                mode,
                gateWidth: 64,
                count: 255,
                targetCpl: kind === 'same' ? 3 : 0,
                conforming: kind === 'conforming',
                code: mode === 'long64' ? '48ff2b' : 'eaffffffff3b00',
                pointerWidth: 64,
                prepare(_memory, context) {
                  context.tr.valid = false;
                },
              },
              async (cpu) => {
                const before = initial(SOURCE, { 3: 0x5000n, 4: 0x123400009003n }, 0x602n);
                cpu.setState(before);
                const context = cpu.readContext();
                const guard = read(cpu, 0x8fc0n, 64);
                const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
                if (kind === 'inner') {
                  equal(
                    result.reason,
                    'protection-fault',
                    'JMP cannot enter an inner nonconforming target',
                  );
                  equal(result.protectionFault?.vector, 13, 'inner JMP #GP before invalid TR');
                  equal(result.protectionFault?.errorCode, 8, 'embedded target selector');
                  equal(result.retired, 0n, 'invalid JMP does not retire');
                  equal(result.state.rip, SOURCE, 'source boundary retained');
                  same(cpu.readContext(), context, 'no partial inner publication');
                } else {
                  complete(result);
                  equal(result.state.rip, TARGET, 'gate64 embedded RIP');
                  equal(cpu.readContext().mode, 'long64', 'JMP selects the 64-bit target mode');
                  equal(cpu.readContext().cpl, 3, 'same or conforming JMP retains CPL');
                  equal(
                    cpu.readContext().segments.cs.selector,
                    0x0b,
                    'target selector gets retained RPL',
                  );
                  same(
                    cpu.readContext().segments.ss,
                    context.segments.ss,
                    'entire SS cache retained',
                  );
                }
                equal(
                  result.state.registers[4],
                  before.registers[4],
                  'complete raw pointer is unused',
                );
                same(
                  result.state.registers,
                  before.registers,
                  'JMP does not alter raw register banks',
                );
                equal(result.state.flags, 0x602n, 'JMP preserves flags');
                same(read(cpu, 0x8fc0n, 64), guard, 'no stack frame payload');
              },
            );
      },
    },
    {
      name: 'call gate clears SS inhibition then captures an unblocked NMI at the completed privilege boundary before IRQ',
      async run() {
        await usingGate(
          compiler,
          {
            prepare(memory, context) {
              context.idtr = { base: 0xa000n, limit: 0x7ff };
              memory.set(hex('00300800008e0000'), 0xa010);
              memory.set(hex('00400800008e0000'), 0xa100);
            },
          },
          async (cpu) => {
            cpu.setState({
              ...initial(SOURCE, { 4: 0x4000n }, 0x202n),
              interruptibility: { sti: false, ss: true },
              interrupts: { irq: 32, nmiPending: true, nmiBlocked: false },
            });
            const captured = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(
              captured.reason,
              'event-budget',
              'newly eligible NMI precedes final instruction budget',
            );
            equal(captured.retired, 1n, 'gate completes before NMI acceptance');
            equal(captured.deliveryAttempts, 0n, 'zero allowance freezes the selected source');
            equal(captured.state.rip, TARGET, 'source uses completed callee boundary');
            equal(captured.state.registers[4], 0x8ff0n, 'gate frame committed once');
            equal(cpu.readContext().cpl, 0, 'privilege publication precedes NMI selection');
            same(
              captured.state.interruptibility,
              { sti: false, ss: false },
              'gate consumes the incoming SS interval',
            );
            same(
              captured.state.interrupts,
              { irq: 32, nmiPending: false, nmiBlocked: true },
              'NMI wins priority and IRQ remains queued',
            );
            same(
              captured.state.event,
              {
                kind: 'pending-interrupt',
                interrupt: { source: { kind: 'nmi' }, returnPc: TARGET, savedFlags: 0x202n },
              },
              'frozen NMI stores the completed gate source',
            );
            const frame = read(cpu, 0x8ff0n, 16);
            const entered = await cpu.run({
              budget: 1n,
              stop: 0x3000n,
              eventDelivery: { budget: 1n },
            });
            equal(entered.reason, 'stop', 'NMI reaches handler before callee bytes');
            equal(entered.retired, 0n, 'neither callee nor handler instruction executes');
            equal(entered.deliveryAttempts, 1n, 'one selected NMI entry');
            equal(entered.state.registers[4], 0x8fe4n, 'same-CPL NMI adds three dword slots');
            for (const [index, value] of [TARGET, 8n, 0x202n].entries())
              equal(scalar(cpu, 0x8fe4n + BigInt(index * 4), 4), value, `NMI slot ${index}`);
            same(read(cpu, 0x8ff0n, 16), frame, 'NMI does not replay or overwrite the gate frame');
            same(
              entered.state.interrupts,
              { irq: 32, nmiPending: false, nmiBlocked: true },
              'NMI remains blocked and queued IRQ is not consumed',
            );
          },
        );
      },
    },
  ];
}
