import {
  changed,
  check,
  equal,
  image,
  initial,
  linear,
  noCompilation,
  preserveNumeric,
  same,
  type Factory,
  type Scenario,
} from './fixture.js';
import { eventSetup } from './writers.js';

export function reviewBoundaryScenarios(compiler: WebAssembly.Module, make: Factory): Scenario[] {
  return [
    {
      name: 'context reuse review admitted warm IRET unblocks NMI before a private stack refusal',
      async run() {
        const setup = eventSetup('cf');
        const a = setup.execution;
        const b = {
          ...a,
          segments: { ...a.segments, fs: { ...a.segments.fs, base: 0x5000n } },
        };
        setup.ram.set(image([0x1000n, 8n, 0x202n], 4), 0x3000);
        await linear(
          compiler,
          make,
          setup.code,
          a,
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            for (const context of [a, b]) {
              cpu.setContext(context);
              cpu.setState(initial(0x1000n, { 4: 0x7000n }, 0x202n));
              equal((await cpu.run({ budget: 1n })).reason, 'budget', 'prime valid return');
            }
            cpu.setContext(a);
            const input = {
              ...initial(0x1000n, { 4: 0x9000n }, 0x202n),
              interrupts: { irq: null, nmiPending: true, nmiBlocked: true },
            };
            cpu.setState(input);
            const guarded = cpu.readMemory(0x4000n, setup.ram.length);
            await noCompilation(async () => {
              const result = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              equal(
                result.reason,
                'data-fault',
                'private frame read refuses before selector checks',
              );
              equal(result.retired, 0n, 'failed return never retires');
              equal(result.deliveryAttempts, 0n, 'private refusal does not stage a source');
              equal(result.resources.compilations, 0, 'restored A uses its retained IRET');
              equal(result.resources.cacheHits, 1, 'one actual admitted native return');
              equal(result.fault?.address, 0x9000n, 'first required frame byte');
              equal(result.fault?.access, 'read', 'ordinary stack access domain');
              same(
                result.state,
                { ...input, interrupts: { ...input.interrupts, nmiBlocked: false } },
                'commenced IRET changes only the independent NMI block',
              );
            });
            same(cpu.readContext(), a, 'no destination context was published');
            same(cpu.readMemory(0x4000n, guarded.length), guarded, 'all frame and table guards');
            numeric();
          },
          { bytes: setup.ram },
        );
      },
    },
    ...(['stop', 'quota'] as const).map((frontier): Scenario => ({
      name: `context reuse review committed IRQ frame survives target ${frontier} without replay`,
      async run() {
        // STI; JMP 1010, then an independently warm plain NOP. The handler is cold.
        const setup = eventSetup('fbeb0d' + '82'.repeat(13) + '9082');
        const a = setup.execution;
        const b = {
          ...a,
          segments: { ...a.segments, fs: { ...a.segments.fs, base: 0x5000n } },
        };
        await linear(
          compiler,
          make,
          setup.code,
          a,
          async (cpu) => {
            const numeric = preserveNumeric(cpu);
            for (const context of [a, b]) {
              cpu.setContext(context);
              cpu.setState(initial(0x1010n, { 4: 0x7000n }, 0x202n));
              equal((await cpu.run({ budget: 1n })).reason, 'budget', 'warm return successor');
              if (frontier === 'quota') {
                cpu.setState({
                  ...initial(0x1001n, { 4: 0x7000n }, 0x202n),
                  interruptibility: { sti: true, ss: false },
                });
                equal(
                  (await cpu.run({ budget: 1n })).reason,
                  'budget',
                  'warm observed shadow consumer',
                );
              }
            }
            cpu.setContext(a);
            const input = initial(
              frontier === 'stop' ? 0x1010n : 0x1000n,
              { 4: 0x7000n },
              frontier === 'stop' ? 0x202n : 2n,
            );
            cpu.setState({
              ...input,
              interrupts: { irq: 0x20, nmiPending: false, nmiBlocked: false },
            });
            const guarded = cpu.readMemory(0x4000n, setup.ram.length);
            cpu.setTimeState({ tsc: 100n, tscAux: 7 });
            const result = await cpu.run({
              budget: frontier === 'stop' ? 1n : 3n,
              ...(frontier === 'stop' ? { stop: 0x2000n } : {}),
              eventDelivery: { budget: 1n },
            });
            equal(
              result.reason,
              frontier === 'stop' ? 'stop' : 'resource-limit',
              'cold handler private frontier',
            );
            equal(
              result.retired,
              frontier === 'stop' ? 0n : 2n,
              'only completed source instructions retire',
            );
            equal(result.deliveryAttempts, 1n, 'one automatic entry');
            equal(
              cpu.readTimeState().tsc,
              frontier === 'stop' ? 100n : 102n,
              'target resource refusal preserves only independently completed source ticks',
            );
            equal(
              result.resources.compilations,
              frontier === 'stop' ? 0 : 1,
              'probe-before-quota preserves committed entry',
            );
            equal(result.state.rip, 0x2000n, 'suspended at handler start');
            equal(result.state.registers[4], 0x6ff4n, 'exact one-frame stack decrement');
            equal(result.state.flags, 2n, 'interrupt gate clears IF');
            same(
              result.state.interrupts,
              { irq: null, nmiPending: false, nmiBlocked: false },
              'accepted slot consumed once',
            );
            const handler = {
              ...a,
              segments: { ...a.segments, cs: { ...a.segments.cs, selector: 0x18 } },
            };
            same(cpu.readContext(), handler, 'complete destination caches committed');
            guarded.set(image([0x1010n, 8n, 0x202n], 4), 0x2ff4);
            same(
              cpu.readMemory(0x4000n, guarded.length),
              guarded,
              'one literal committed frame and all guards',
            );

            // A consumed gate must never be read again when this handler resumes.
            cpu.writeMemory(0x8100n, new Uint8Array(8));
            guarded.fill(0, 0x4100, 0x4108);
            const before = cpu.readState();
            const returned = await cpu.run({ budget: 1n, eventDelivery: { budget: 1n } });
            equal(returned.reason, 'budget', 'resume executes the actual IRET');
            equal(returned.retired, 1n, 'automatic entry is not replayed');
            equal(
              cpu.readTimeState().tsc,
              frontier === 'stop' ? 101n : 103n,
              'resumed IRET ticks once after committed entry',
            );
            equal(returned.deliveryAttempts, 0n, 'consumed event has no second attempt');
            same(
              returned.state,
              changed(before, 0x1010n, { 4: 0x7000n }, 0x202n),
              'literal resumed return state',
            );
            same(cpu.readContext(), a, 'return restores original loaded facts');
            same(
              cpu.readMemory(0x4000n, guarded.length),
              guarded,
              'no duplicated frame after poisoned gate',
            );
            check(
              cpu.inspectTranslations().length >= 3,
              'dormant A B and handler remain independently owned',
            );
            await noCompilation(async () => {
              const resumed = await cpu.run({ budget: 1n });
              equal(
                resumed.resources.compilations,
                0,
                'original warm A successor survives event entry and return',
              );
              same(
                resumed.state,
                changed(returned.state, 0x1011n),
                'one independent successor NOP',
              );
            });
            numeric();
          },
          { bytes: setup.ram, limits: { maxTranslationsPerRun: 1 } },
        );
      },
    })),
  ];
}
