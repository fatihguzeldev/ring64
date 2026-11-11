import {
  changed,
  check,
  equal,
  hex,
  initial,
  noCompilation,
  preserveNumeric,
  same,
  type Factory,
  type Scenario,
} from './fixture.js';
import { fastSetup, FAST_FORMS, FAST, KERNEL, USER } from './warm.js';

export function boundaryScenarios(compiler: WebAssembly.Module, make: Factory): Scenario[] {
  return [
    {
      name: 'context reuse completes a warmed context writer before SS-deferred DB and restored-TF IRQ arbitration',
      async run() {
        for (const returning of [false, true]) {
          const setup = fastSetup(compiler, FAST_FORMS[0]);
          setup.ram.set(hex(returning ? '480f0782' : '0f3482'), returning ? 0xa000 : 0x9000);
          const context = returning ? setup.kernel : setup.user,
            source = returning ? KERNEL : USER,
            target = returning ? USER : KERNEL;
          const cpu = await make({ ...setup.options, context });
          try {
            const numeric = preserveNumeric(cpu),
              input = initial(source, { 1: USER, 11: returning ? 0x302n : 2n }, 2n);
            cpu.setState(
              returning
                ? {
                    ...input,
                    registers: input.registers.map((value, index) =>
                      index === 11 ? 0x202n : value,
                    ),
                  }
                : input,
            );
            equal((await cpu.run({ budget: 1n })).reason, 'budget', 'source-context prime');
            cpu.setContext(context);
            cpu.setState({
              ...input,
              interruptibility: { sti: false, ss: !returning },
              ...(returning
                ? {}
                : { debugContinuation: { breakpoints: 1, originPc: source - 0x10n } }),
              interrupts: {
                irq: returning ? 0x20 : null,
                nmiPending: !returning,
                nmiBlocked: false,
              },
            });
            await noCompilation(async () => {
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              equal(result.reason, 'event-budget', 'completed writer DB precedes exhausted budget');
              equal(result.retired, 1n, 'writer retires exactly once');
              equal(result.resources.compilations, 0, 'source artifact is retained');
              equal(result.deliveryAttempts, 0n, 'selected source has no attempted frame');
              equal(result.state.rip, target, 'destination committed before DB');
              equal(cpu.readContext().cpl, returning ? 3 : 0, 'new privilege committed');
              check(result.state.event.kind === 'pending', 'DB wins over external source');
              equal(result.state.event.exception.vector, 1, 'typed DB');
              equal(
                result.state.event.exception.returnPc,
                target,
                'trap observes completed new context',
              );
              if (returning) {
                equal(cpu.readDebugState().dr6 & 0x4000n, 0x4000n, 'restored TF supplies BS');
                equal(
                  result.state.interrupts.irq,
                  0x20,
                  'newly eligible IRQ not consumed behind DB',
                );
              } else {
                equal(
                  cpu.readDebugState().dr6 & 1n,
                  1n,
                  'old deferred data cause survives inactive DR7',
                );
                const debug = result.state.event.exception.debug;
                check(debug?.class === 'trap', 'deferred source is a completion trap');
                equal(debug.deferredOriginPc, source - 0x10n, 'old source origin preserved');
                equal(
                  result.state.interrupts.nmiPending,
                  true,
                  'NMI not consumed behind deferred DB',
                );
              }
              same(
                result.state.interruptibility,
                { sti: false, ss: false },
                'destination has no synthetic suppression',
              );
            });
            numeric();
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'context reuse target private-X refusal retains a committed transfer and resume consumes neither old source nor changed LSTAR',
      async run() {
        const setup = fastSetup(compiler, FAST_FORMS[0]);
        const whole = setup.options.memory.mappings[0]!;
        const denied = [
          { ...whole, length: 0xa000 },
          {
            ...whole,
            base: 0xa000n,
            offset: 0xa000,
            length: 0x1000,
            permissions: { read: true, write: true, execute: false },
          },
          { ...whole, base: 0xb000n, offset: 0xb000, length: setup.ram.length - 0xb000 },
        ];
        const cpu = await make({
          ...setup.options,
          memory: { ...setup.options.memory, mappings: denied },
          memoryLimits: { ...setup.options.memoryLimits, maxMappings: 3 },
        });
        try {
          const numeric = preserveNumeric(cpu),
            input = initial(USER, { 8: 1n }, 0x202n);
          cpu.setState(input);
          const blocked = await cpu.run({ budget: 2n });
          equal(blocked.reason, 'physical-memory-fault', 'private target X refusal');
          equal(blocked.retired, 1n, 'entry already retired');
          equal(blocked.state.rip, KERNEL, 'committed target preserved');
          equal(cpu.readContext().cpl, 0, 'committed kernel context survives host lookup');
          equal(blocked.state.registers[1], USER + 2n, 'saved return PC once');
          cpu.setFastSystemState({ ...FAST, lstar: 0x402000n });
          cpu.setMappings([whole]);
          const before = cpu.readState(),
            resumed = await cpu.run({ budget: 1n });
          equal(resumed.reason, 'budget', 'one actual return completes');
          equal(resumed.retired, 1n, 'no replayed entry');
          same(
            resumed.state,
            changed(before, USER + 2n, {}, 0x202n),
            'resume begins from completed destination',
          );
          equal(
            cpu.readFastSystemState().lstar,
            0x402000n,
            'changed next-entry input remains unconsumed',
          );
          same(cpu.readContext(), setup.user, 'complete original user caches restored');
          cpu.setState(initial(USER, {}, 0x202n));
          const next = await cpu.run({ budget: 1n });
          equal(next.resources.compilations, 0, 'source retained through target permission repair');
          equal(next.state.rip, 0x402000n, 'next real entry consumes latest LSTAR');
          numeric();
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
