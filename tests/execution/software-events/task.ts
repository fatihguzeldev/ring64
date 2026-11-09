import {
  using,
  snapshot,
  initial,
  outcome,
  same,
  equal,
  throws,
  hex,
  CODE64,
  CODE32,
  tssDescriptor,
  preserveNumeric,
  type Scenario,
} from './fixture.js';

export function taskScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'software task register LTR captures busy cache and STR ignores later descriptor edits',
      async run() {
        for (const mode of ['protected', 'compatibility', 'long64'] as const)
          for (const type of mode === 'protected' ? [1, 9] : [9]) {
            const execution = snapshot(mode);
            const wide = mode !== 'protected';
            const descriptor = tssDescriptor(0x5000n, 0x67, type, wide);
            await using(
              compiler,
              '0f00d80f00c90f000b',
              execution,
              async (cpu) => {
                const numeric = preserveNumeric(cpu);
                const before = initial(
                  0x1000n,
                  { 0: 0x28n, 1: 0x1122334455667788n, 3: 0x6001n },
                  0x403n,
                );
                cpu.setState(before);
                const loaded = await cpu.run({ budget: 1n, repeatBudget: 9n });
                outcome(loaded, 'budget', 1n, 1n, 9n);
                same(
                  cpu.readContext(),
                  {
                    ...execution,
                    tr: {
                      selector: 0x28,
                      valid: true,
                      base: 0x5000n,
                      limit: 0x67,
                      attributes: 0x80 | type | 2,
                    },
                  },
                  'captured post-busy TR',
                );
                const busy = hex(descriptor);
                busy[5]! |= 2;
                same(cpu.readMemory(0x4028n, busy.length), busy, 'only busy bit written');
                cpu.writeMemory(0x4028n, new Uint8Array(busy.length));
                const stored = await cpu.run({ budget: 2n, repeatBudget: 9n });
                outcome(stored, 'budget', 2n, 2n, 9n);
                const expected = [...before.registers];
                expected[1] =
                  mode === 'long64' ? 0x28n : (before.registers[1]! & 0xffffffff00000000n) | 0x28n;
                same(
                  stored.state.registers,
                  expected,
                  'STR selected width and inherited raw high-bit preservation',
                );
                equal(stored.state.flags, before.flags, 'STR preserves live flags');
                same(
                  cpu.readMemory(0x6000n, 4),
                  Uint8Array.of(0xa5, 0x28, 0, 0xa5),
                  'STR exact m16 and guards',
                );
                equal(cpu.readContext().tr.base, 0x5000n, 'cached TR survives GDT overwrite');
                numeric();
              },
              {
                data: [
                  { base: 0x4008n, bytes: mode === 'long64' ? CODE64 : CODE32 },
                  { base: 0x4028n, bytes: descriptor },
                  { base: 0x6000n, bytes: 'a5'.repeat(4) },
                ],
              },
            );
          }
      },
    },
    {
      name: 'software task snapshot retains raw imported facts without table or TSS reads and old input clears them',
      async run() {
        const execution = snapshot();
        execution.tr = {
          selector: 0xffff,
          valid: false,
          base: 0xffffffffffffffffn,
          limit: 0xffffffff,
          attributes: 0xfff,
        };
        await using(compiler, '90', execution, async (cpu) => {
          const numeric = preserveNumeric(cpu);
          const before = initial();
          cpu.setState(before);
          const observed = cpu.readContext();
          same(observed, execution, 'raw imported TR');
          observed.tr.base = 0n;
          same(cpu.readContext(), execution, 'detached TR output');
          const run = await cpu.run({ budget: 1n });
          outcome(run, 'budget', 1n, 1n);
          const older = { ...execution };
          Reflect.deleteProperty(older, 'tr');
          cpu.setContext(older);
          same(
            cpu.readContext().tr,
            { selector: 0, valid: false, base: 0n, limit: 0, attributes: 0 },
            'omission is fresh invalid TR',
          );
          numeric();
        });
      },
    },
    {
      name: 'software TR input getters preserve context-local completed-run ordering and reject pending or disposed publication',
      async run() {
        for (const action of ['warm', 'cold', 'dispose'] as const)
          await using(compiler, '90ebfd', snapshot(), async (cpu) => {
            const numeric = preserveNumeric(cpu);
            const before = initial();
            cpu.setState(before);
            if (action === 'warm') {
              const warm = await cpu.run({ budget: 2n });
              outcome(warm, 'budget', 2n, 2n);
              same(warm.state, before, 'warm NOP/backedge state');
            }
            const execution = cpu.readContext();
            let pending: ReturnType<typeof cpu.run> | undefined;
            let reads = 0;
            const input = {
              ...execution,
              tr: {
                selector: 0xffff,
                valid: false,
                get base() {
                  reads++;
                  if (action === 'dispose') cpu.dispose();
                  else {
                    pending = cpu.run({ budget: 1n });
                    if (action === 'warm')
                      equal(
                        cpu.readState().rip,
                        0x1001n,
                        'nested cached run finished before getter returns',
                      );
                  }
                  return 0xffffffffffffffffn;
                },
                limit: 0xffffffff,
                attributes: 0xfff,
              },
            };
            try {
              if (action === 'warm') cpu.setContext(input);
              else
                throws(() => cpu.setContext(input), 'overlapping or disposed TR capture rejects');
              equal(reads, 1, 'TR base getter read once');
              if (action === 'dispose') {
                throws(() => cpu.readContext(), 'disposed CPU cannot be resurrected');
                return;
              }
              const nested = await pending!;
              outcome(nested, 'budget', 1n, 1n);
              equal(
                nested.resources.compilations,
                action === 'warm' ? 0 : 1,
                'actual cached versus pending path',
              );
              same(cpu.readState(), { ...before, rip: 0x1001n }, 'nested raw State preserved');
              same(
                cpu.readContext(),
                action === 'warm'
                  ? {
                      ...execution,
                      tr: {
                        selector: 0xffff,
                        valid: false,
                        base: 0xffffffffffffffffn,
                        limit: 0xffffffff,
                        attributes: 0xfff,
                      },
                    }
                  : execution,
                'outer projection publication follows context contract',
              );
              if (action === 'warm')
                same(cpu.inspectTranslations(), [], 'changed context retires old owners');
              numeric();
            } finally {
              await pending;
            }
          });
      },
    },
  ];
}
