import {
  R,
  W,
  RX,
  map,
  mapped,
  transition,
  input,
  changed,
  outcome,
  stack,
  seed,
  banks,
  xmm,
  x87,
  memory,
  bytes,
  hex,
  equal,
  fault,
  noFault,
  type Scenario,
} from './fixture.js';

export function adversarialScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'failed NT stores preserve dirty predecessors and backing owners then retry fresh cached middle inputs',
      async run() {
        for (const [store, width, source] of [
          ['0fe70b', 8, 'mmx'],
          ['480fc30b', 8, 'gp'],
          ['660fe70b', 16, 'xmm'],
        ] as const)
          for (const permission of [false, true]) {
            const code = '660f6fca' + store; // MOVDQA XMM1,XMM2, then the NT store.
            const initial = 'a5a590' + 'a5'.repeat(width + 1);
            await mapped(
              compiler,
              code,
              [{ id: 'data', bytes: hex(initial) }],
              [
                map(0x2000n, 'data', 1, RX, 2),
                map(0x6000n, 'data', width - 1, W, 2),
                ...(permission ? [map(0x6000n + BigInt(width - 1), 'data', 1, R, width + 1)] : []),
                map(0x8000n, 'data', width + 4, R),
              ],
              async (cpu) => {
                const before = input(0x1000n, { 3: 0x6000n, 1: 0xfeedbeef01234567n }, 0xcd7n);
                const numeric = stack({}, 5),
                  vector = banks();
                numeric.registers[1] = 0xabcd8877665544332211n;
                vector[2] = 0x7ff00000000000018000000000000001n;
                cpu.setState(changed(before, 0x2000n));
                seed(cpu, numeric);
                cpu.setXmmState(vector);
                const primed = await cpu.run({ budget: 1n });
                outcome(primed, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x2001n));
                noFault(primed);
                x87(cpu, numeric);
                xmm(cpu, vector);

                cpu.setState(before);
                const failed = await cpu.run({ budget: 2n, repeatBudget: 17n });
                outcome(failed, 'data-fault', 2n, 1n, 17n, 0n, changed(before, 0x1004n));
                fault(failed, {
                  instructionPc: 0x1004n,
                  address: 0x6000n,
                  width,
                  access: 'write',
                  cause: permission ? 'permission' : 'unmapped',
                  failingAddress: 0x6000n + BigInt(width - 1),
                  segment: 'ds',
                });
                for (const key of [
                  'segmentFault',
                  'alignmentFault',
                  'generalProtectionFault',
                  'simdException',
                  'x87Exception',
                ] as const)
                  equal(failed[key], undefined, key);
                vector[1] = vector[2]!;
                xmm(cpu, vector);
                x87(cpu, numeric);
                equal(cpu.readMxcsr(), 0xffc5, 'failed raw store leaves MXCSR');
                memory(cpu, 0x8000n, initial);
                equal(
                  failed.resources.cachedArtifacts,
                  2,
                  'late failure retains watched backing owner',
                );

                cpu.setMappings([
                  map(0x1000n, 'code', code.length / 2, RX),
                  map(0x2000n, 'data', 1, RX, 2),
                  map(0x6000n, 'data', width, W, 2),
                  map(0x8000n, 'data', width + 4, R),
                ]);
                const repaired = stack({}, 6);
                repaired.registers[1] = 0x43211122334455667788n;
                vector[1] = 0xfff00000000000010000000000000001n;
                const next = changed(before, 0x1004n, { 1: 0x76543210fedcba98n });
                cpu.setState(next);
                cpu.setX87State(repaired);
                cpu.setXmmState(vector);
                const result = await cpu.run({ budget: 1n, repeatBudget: 19n });
                outcome(
                  result,
                  'budget',
                  1n,
                  1n,
                  19n,
                  0n,
                  changed(next, 0x1000n + BigInt(code.length / 2)),
                );
                noFault(result);
                x87(cpu, source === 'mmx' ? transition(repaired) : repaired);
                xmm(cpu, vector);
                equal(cpu.readMxcsr(), 0xffc5, 'repaired raw store leaves MXCSR');
                const value =
                  source === 'mmx'
                    ? 0x1122334455667788n
                    : source === 'gp'
                      ? next.registers[1]!
                      : vector[1]!;
                memory(cpu, 0x8000n, 'a5a5' + bytes(value, width) + 'a5a5');
                equal(
                  result.resources.compilations,
                  0,
                  'repair enters retained store without producer replay',
                );
                equal(
                  result.resources.cachedArtifacts,
                  1,
                  'successful write invalidates watched backing owner',
                );
                equal(
                  result.resources.dispatches,
                  0,
                  'another owner is invalidated without active-source dispatch',
                );
              },
            );
          }
      },
    },
  ];
}
