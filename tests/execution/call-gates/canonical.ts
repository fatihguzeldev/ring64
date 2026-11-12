import {
  usingGate,
  initial,
  equal,
  check,
  same,
  scalar,
  put,
  hex,
  SOURCE,
  GDT,
  RAM_SIZE,
  type Scenario,
} from './fixture.js';

const HOLE = 0x800000000000n;
const RWX = { read: true, write: true, execute: true };

export function gateCanonicalScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'call gate canonical descriptor reports retain full diagnostics while captured and delivered GP names the resolved selector',
      async run() {
        for (const phase of [
          'gdt-low',
          'ldt-low',
          'gdt-tail',
          'ldt-tail',
          'target-ldt',
          'target-gdt',
        ] as const)
          await usingGate(
            compiler,
            {
              mode: 'long64',
              gateSelector: phase.startsWith('ldt') || phase === 'target-gdt' ? 0x3f : 0x3b,
              prepare(memory, context) {
                memory.copyWithin(0xb038, Number(GDT) + 0x38, Number(GDT) + 0x48);
                context.ldtr = {
                  selector: 0x50,
                  valid: true,
                  base: 0xb000n,
                  limit: 0xffff,
                  attributes: 0x82,
                };
                if (phase === 'gdt-low') context.gdtr.base = HOLE - 0x3cn;
                else if (phase === 'ldt-low') context.ldtr.base = HOLE - 0x3cn;
                else if (phase === 'gdt-tail') context.gdtr.base = HOLE - 0x40n;
                else if (phase === 'ldt-tail') context.ldtr.base = HOLE - 0x40n;
                else if (phase === 'target-ldt') {
                  context.ldtr = {
                    selector: 0x50,
                    valid: true,
                    base: HOLE - 4n,
                    limit: 0xffff,
                    attributes: 0x82,
                  };
                  put(memory, Number(GDT) + 0x3a, 7n, 2);
                } else context.gdtr.base = HOLE - 0xcn;
                context.idtr = { base: 0xa000n, limit: 0xfff };
                memory.set(hex('00300800008e00000000000000000000'), 0xa0d0);
                memory[0x3000] = 0x90;
              },
            },
            async (cpu) => {
              if (phase.endsWith('tail'))
                cpu.setMappings([
                  { base: 0n, backing: 'ram', offset: 0, length: RAM_SIZE, permissions: RWX },
                  {
                    base: HOLE - 8n,
                    backing: 'ram',
                    offset: Number(GDT) + 0x38,
                    length: 8,
                    permissions: { read: true, write: false, execute: false },
                  },
                ]);
              const context = cpu.readContext();
              const before = initial(SOURCE, { 3: 0x5000n, 4: 0x4000n }, 0x10202n);
              cpu.setState(before);
              const zero = await cpu.run({ budget: 0n, eventDelivery: { budget: 0n } });
              equal(zero.reason, 'budget', 'zero instruction gate precedes descriptor work');
              equal(zero.systemMemoryFault, undefined, 'no speculative descriptor failure');
              const report = await cpu.run({ budget: 1n });
              equal(
                report.reason,
                'system-memory-fault',
                'report transport stays private diagnostic',
              );
              equal(report.retired, 0n, 'failed CALL');
              equal(
                report.systemMemoryFault?.address,
                phase.endsWith('tail') ? HOLE : HOLE - 4n,
                'complete selected span start',
              );
              equal(report.systemMemoryFault?.width, 8, 'selected descriptor slice width');
              equal(report.systemMemoryFault?.failingAddress, HOLE, 'first noncanonical byte');
              equal(
                report.systemMemoryFault?.cause,
                'noncanonical',
                'architectural geometry cause retained',
              );
              equal(report.systemMemoryFault?.phase, 'descriptor-read', 'original system phase');
              equal(
                report.systemMemoryFault?.table,
                phase.startsWith('ldt') || phase === 'target-ldt' ? 'ldt' : 'gdt',
                'selected table',
              );
              check(
                report.systemMemoryFault && 'selector' in report.systemMemoryFault,
                'selector-bearing table fault',
              );
              equal(
                report.systemMemoryFault?.selector,
                phase === 'target-ldt'
                  ? 7
                  : phase === 'target-gdt'
                    ? 8
                    : phase.startsWith('ldt')
                      ? 0x3f
                      : 0x3b,
                'original reference including RPL',
              );
              same(report.state.event, { kind: 'ready' }, 'report does not stage source');
              cpu.setState(before);
              const pending = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              equal(pending.reason, 'event-budget', 'opt-in captures producer source');
              const code =
                phase === 'target-ldt'
                  ? 4
                  : phase === 'target-gdt'
                    ? 8
                    : phase.startsWith('ldt')
                      ? 0x3c
                      : 0x38;
              same(
                pending.state.event,
                {
                  kind: 'pending',
                  exception: {
                    vector: 13,
                    instructionPc: SOURCE,
                    returnPc: SOURCE,
                    savedFlags: 0x10202n,
                    errorCode: code,
                  },
                },
                'captured selector source',
              );
              const repair = {
                ...context,
                gdtr: { base: GDT, limit: 0x7f },
                ldtr: { ...context.ldtr, base: 0xb000n },
              };
              cpu.setContext({
                ...repair,
                gdtr: { base: 0x300000n, limit: 0x7f },
                ldtr: { ...repair.ldtr, base: 0x300000n },
              });
              cpu.setState(before);
              const unrelated = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              equal(
                unrelated.reason,
                'system-memory-fault',
                'later unmapped descriptor remains private',
              );
              same(unrelated.state.event, { kind: 'ready' }, 'earlier GP source cannot leak');
              cpu.setContext(repair);
              cpu.setState(pending.state);
              const delivered = await cpu.run({
                budget: 1n,
                stop: 0x3000n,
                eventDelivery: { budget: 1n },
              });
              equal(delivered.reason, 'stop', 'retained event delivered after context repair');
              equal(delivered.retired, 0n, 'event entry is not a guest retirement');
              equal(delivered.deliveryAttempts, 1n, 'exactly one selected source');
              equal(delivered.state.rip, 0x3000n, 'handler entry');
              equal(delivered.state.registers[4], 0x8fd0n, 'complete outer exception frame');
              for (const [i, value] of [
                BigInt(code),
                SOURCE,
                0x1bn,
                0x10202n,
                0x4000n,
                0x23n,
              ].entries())
                equal(
                  scalar(cpu, 0x8fd0n + BigInt(i * 8), 8),
                  value,
                  `literal delivered frame ${i}`,
                );
            },
          );
      },
    },
    {
      name: 'call gate canonical producer refinement includes forward ordinary-code CALL JMP and leaves LTR RETF sources unchanged',
      async run() {
        for (const kind of ['call', 'jump', 'ltr', 'retf'] as const)
          await usingGate(
            compiler,
            {
              mode: 'long64',
              cpl: 0,
              code:
                kind === 'call'
                  ? 'ff1b'
                  : kind === 'jump'
                    ? 'ff2b'
                    : kind === 'ltr'
                      ? '0f00d8'
                      : '48cb',
              prepare(memory, context) {
                context.gdtr.base = HOLE - 0xcn;
                put(memory, 0x5004, 8n, 2);
                put(memory, 0x4000, 0x2000n, 8);
                put(memory, 0x4008, 8n, 8);
              },
            },
            async (cpu) => {
              cpu.setState(initial(SOURCE, { 0: 8n, 3: 0x5000n, 4: 0x4000n }, 0x10202n));
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              equal(result.reason, 'event-budget', 'selected canonical descriptor source');
              check(result.state.event.kind === 'pending', 'pending processor event');
              equal(result.state.event.exception.vector, 13, 'descriptor canonicality GP');
              equal(
                result.state.event.exception.errorCode,
                kind === 'call' || kind === 'jump' ? 8 : 0,
                'only the forward far consumer names the resolved selector',
              );
            },
          );
      },
    },
    {
      name: 'call gate widened descriptor domain overflow remains private and cannot become stale selector GP',
      async run() {
        await usingGate(
          compiler,
          {
            mode: 'long64',
            prepare(_memory, context) {
              context.gdtr.base = 0xffffffffffffffc5n;
            },
          },
          async (cpu) => {
            cpu.setState(initial(SOURCE, { 3: 0x5000n, 4: 0x4000n }));
            const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
            equal(result.reason, 'system-memory-fault', 'overflow remains private');
            equal(result.systemMemoryFault?.cause, 'address-range', 'full span overflows u64');
            equal(
              result.systemMemoryFault?.failingAddress,
              1n << 64n,
              'widened first illegal byte',
            );
            same(
              result.state.event,
              { kind: 'ready' },
              'no architectural source for private domain failure',
            );
          },
        );
      },
    },
  ];
}
