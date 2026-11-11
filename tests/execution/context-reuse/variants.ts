import {
  changed,
  check,
  equal,
  initial,
  importedProfiles,
  linear,
  little,
  longSnapshot,
  noCompilation,
  preserveNumeric,
  same,
  type Factory,
  type Scenario,
} from './fixture.js';

export function variantScenarios(compiler: WebAssembly.Module, make: Factory): Scenario[] {
  return [
    {
      name: 'context reuse equal host imports cancel history while preserving compatible code and queued sources',
      async run() {
        const execution = longSnapshot();
        await linear(compiler, make, '9082', execution, async (cpu) => {
          const input = initial(0x1000n, {}, 0x202n),
            numeric = preserveNumeric(cpu);
          cpu.setState(input);
          await cpu.run({ budget: 1n });
          cpu.setState({
            ...input,
            interruptibility: { sti: false, ss: true },
            debugContinuation: { breakpoints: 1, originPc: 0xff0n },
            interrupts: { irq: 0x20, nmiPending: true, nmiBlocked: true },
          });
          cpu.setContext(execution);
          same(
            cpu.readState(),
            { ...input, interrupts: { irq: 0x20, nmiPending: true, nmiBlocked: false } },
            'equal import cancels suppression continuation and NMI block without restoring cached history',
          );
          cpu.setState(input);
          await noCompilation(async () => {
            const result = await cpu.run({ budget: 1n });
            equal(result.resources.compilations, 0, 'equal import keeps valid code');
            same(result.state, changed(input, 0x1001n), 'same compatible instruction executes');
          });
          numeric();
        });
      },
    },
    {
      name: 'context reuse keeps dormant FS variants at one RIP and returns to the original owner',
      async run() {
        const a = longSnapshot(0x4000n),
          b = longSnapshot(0x5000n),
          ram = new Uint8Array(0x2000).fill(0xa5);
        ram.set(little(0x1111222233334444n), 0);
        ram.set(little(0x5555666677778888n), 0x1000);
        await linear(
          compiler,
          make,
          '64488b0382',
          a,
          async (cpu) => {
            const numeric = preserveNumeric(cpu),
              input = initial(0x1000n, { 3: 0n });
            cpu.setState(input);
            const first = await cpu.run({ budget: 1n });
            same(
              first.state,
              changed(input, 0x1004n, { 0: 0x1111222233334444n }),
              'literal first FS load',
            );
            const owner = cpu.inspectTranslations()[0]!.owner;
            cpu.setContext(b);
            cpu.setState(input);
            const second = await cpu.run({ budget: 1n });
            same(
              second.state,
              changed(input, 0x1004n, { 0: 0x5555666677778888n }),
              'literal second FS load',
            );
            check(
              cpu.inspectTranslations().some((entry) => entry.owner === owner),
              'A remains retained while B is current',
            );
            cpu.setContext(a);
            cpu.setState(input);
            await noCompilation(async () => {
              const last = await cpu.run({ budget: 1n });
              equal(last.reason, 'budget', 'return to A completes');
              equal(last.resources.compilations, 0, 'return does not translate again');
              equal(last.resources.generatedBytes, 0, 'return generates no bytes');
              same(
                last.state,
                changed(input, 0x1004n, { 0: 0x1111222233334444n }),
                'literal returned FS value',
              );
            });
            same(cpu.readContext(), a, 'complete imported A restored');
            same(cpu.readMemory(0x4000n, ram.length), ram, 'all source and data bytes guarded');
            numeric();
          },
          { bytes: ram },
        );
      },
    },
    {
      name: 'context reuse separates all fourteen literal imported decode and stack profiles at one PC',
      async run() {
        const contexts = importedProfiles();
        await linear(compiler, make, 'b83412785682', contexts[0]!, async (cpu) => {
          const numeric = preserveNumeric(cpu),
            input = initial(0x1000n);
          const visit = async (warm: boolean) => {
            for (const execution of contexts) {
              cpu.setContext(execution);
              cpu.setState(input);
              const result = await cpu.run({ budget: 1n });
              const wide = execution.mode === 'long64' || execution.segments.cs.default32;
              const value =
                execution.mode === 'long64'
                  ? 0x56781234n
                  : wide
                    ? 0x1122334456781234n
                    : 0x1122334400001234n;
              same(
                result.state,
                changed(input, wide ? 0x1005n : 0x1003n, { 0: value }),
                'literal mode-dependent immediate and upper bits',
              );
              same(cpu.readContext(), execution, 'complete imported facts');
              if (warm)
                equal(result.resources.compilations, 0, 'every previously visited profile is warm');
            }
          };
          await visit(false);
          await noCompilation(() => visit(true));
          numeric();
        });
      },
    },
    {
      name: 'context reuse does not restore registers flags numeric values or debug activity from a capsule',
      async run() {
        const a = longSnapshot(),
          b = longSnapshot(0x5000n);
        await linear(compiler, make, '4889d89082', a, async (cpu) => {
          cpu.setState(initial(0x1000n, { 3: 0x1234n }));
          await cpu.run({ budget: 2n });
          cpu.setContext(b);
          cpu.setState(initial(0x1000n, { 3: 0x5678n }));
          await cpu.run({ budget: 2n });
          cpu.setContext(a);
          const input = initial(0x1000n, { 3: 0x8877665544332211n }, 0xcd7n),
            numeric = preserveNumeric(cpu);
          cpu.setState(input);
          await noCompilation(async () => {
            const result = await cpu.run({ budget: 2n });
            same(
              result.state,
              changed(input, 0x1004n, { 0: 0x8877665544332211n }),
              'new runtime registers and flags',
            );
            equal(result.resources.compilations, 0, 'dynamic scalar values are not contexts');
          });
          cpu.setDebugState({
            ...cpu.readDebugState(),
            addresses: [0x1000n, 0n, 0n, 0n],
            dr7: 0x401n,
          });
          cpu.setState(input);
          const hit = await cpu.run({ budget: 1n });
          equal(hit.reason, 'debug-exception', 'live execute breakpoint is not restored away');
          equal(hit.retired, 0n, 'execute fault precedes the move');
          cpu.setDebugState({ ...cpu.readDebugState(), dr7: 0x400n });
          cpu.setState(input);
          const resumed = await cpu.run({ budget: 1n });
          same(
            resumed.state,
            changed(input, 0x1003n, { 0: 0x8877665544332211n }),
            'plain owner remains usable after observed execution',
          );
          equal(resumed.resources.compilations, 0, 'existing plain variant survived observation');
          numeric();
        });
      },
    },
  ];
}
