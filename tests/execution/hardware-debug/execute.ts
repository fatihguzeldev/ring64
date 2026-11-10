import {
  using,
  snapshot,
  initial,
  equal,
  same,
  type Scenario,
} from '../exception-delivery/fixture.js';
export function executeScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'hardware debug execute source wins before cold decode without forcing saved RF',
      async run() {
        for (const code of ['82', '0f0b', '66'.repeat(15), '90'])
          await using(
            compiler,
            code,
            snapshot(),
            async (cpu) => {
              cpu.setDebugState({ addresses: [0x1000n, 0n, 0n, 0n], dr6: 0n, dr7: 0x401n });
              cpu.setState(initial(0x1000n, {}, 0x202n));
              const report = await cpu.run({ budget: 1n });
              equal(report.reason, 'debug-exception', 'execute before opcode/decode');
              equal(report.retired, 0n, 'execute is fault');
              equal(report.debugException?.class, 'fault', 'fault provenance');
              equal(report.debugException?.resumeFlags, 0x202n, 'execute saved RF0');
              const r = await cpu.run({ budget: 1n, eventDelivery: { budget: 0n } });
              same(
                r.state.event,
                {
                  kind: 'pending',
                  exception: {
                    vector: 1,
                    instructionPc: 0x1000n,
                    returnPc: 0x1000n,
                    savedFlags: 0x202n,
                    debug: { class: 'fault', cause: 'execution-breakpoint', breakpoints: 1 },
                  },
                },
                'pending execute image',
              );
            },
            { limits: { maxArtifactBytes: 1 } },
          );
      },
    },
  ];
}
