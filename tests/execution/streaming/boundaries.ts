import {
  LONG,
  DATA,
  MASK64,
  R,
  W,
  RX,
  map,
  mapped,
  transition,
  using,
  input,
  changed,
  outcome,
  stack,
  seed,
  banks,
  xmm,
  x87,
  other,
  bytes,
  memory,
  equal,
  fault,
  pending,
  noFault,
  hex,
  type Scenario,
} from './fixture.js';

export function boundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'zero and sparse masks admit every nominal byte before publication and repaired faults reuse fresh operands',
      async run() {
        for (const width of [8, 16])
          for (const zero of [false, true])
            for (const permission of [false, true]) {
              const code = width === 8 ? '0ff7c1' : '660ff7c1';
              const mappings = [
                map(0x6000n, 'data', width - 1, W, 2),
                map(0x8000n, 'data', width + 4, R),
                ...(permission ? [map(0x6000n + BigInt(width - 1), 'data', 1, R, width + 1)] : []),
              ];
              await mapped(
                compiler,
                code,
                [{ id: 'data', bytes: hex('a5'.repeat(width + 4)) }],
                mappings,
                async (cpu) => {
                  const before = input(0x1000n, { 7: 0x6000n }),
                    numeric = stack({}, 5),
                    vector = banks();
                  numeric.registers[0] = (0x1234n << 64n) | (DATA & MASK64);
                  numeric.registers[1] = zero ? 0n : 0x80n;
                  vector[0] = DATA;
                  vector[1] = zero ? 0n : 0x80n;
                  cpu.setState(before);
                  seed(cpu, numeric);
                  cpu.setXmmState(vector);
                  const failed = await cpu.run({ budget: 1n, repeatBudget: 13n });
                  outcome(failed, 'data-fault', 1n, 0n, 13n, 0n, before);
                  fault(failed, {
                    instructionPc: 0x1000n,
                    address: 0x6000n,
                    width,
                    access: 'write',
                    cause: permission ? 'permission' : 'unmapped',
                    failingAddress: 0x6000n + BigInt(width - 1),
                    segment: 'ds',
                  });
                  x87(cpu, numeric);
                  xmm(cpu, vector);
                  memory(cpu, 0x8000n, 'a5'.repeat(width + 4));
                  equal(failed.resources.cachedArtifacts, 1, 'fault preserves source owner');
                  cpu.setMappings([
                    map(0x1000n, 'code', code.length / 2, RX),
                    map(0x6000n, 'data', width, W, 2),
                    map(0x8000n, 'data', width + 4, R),
                  ]);
                  numeric.registers[0] = 0x4321ccccccccccccccccn;
                  numeric.registers[1] = MASK64;
                  vector[0] = 0xccccccccccccccccccccccccccccccccn;
                  vector[1] = (1n << 128n) - 1n;
                  cpu.setX87State(numeric);
                  cpu.setXmmState(vector);
                  const repaired = await cpu.run({ budget: 1n });
                  outcome(
                    repaired,
                    'budget',
                    1n,
                    1n,
                    1n,
                    0n,
                    changed(before, 0x1000n + BigInt(code.length / 2)),
                  );
                  equal(
                    repaired.resources.compilations,
                    0,
                    'mapping and raw source repair keeps code',
                  );
                  noFault(repaired);
                  x87(cpu, width === 8 ? transition(numeric) : numeric);
                  xmm(cpu, vector);
                  memory(cpu, 0x8000n, 'a5a5' + 'cc'.repeat(width) + 'a5a5');
                },
              );
            }
      },
    },
    {
      name: 'masked aliased backing writes follow ascending guest positions and invalidate inactive-address code owners',
      async run() {
        for (const both of [false, true]) {
          const code = '660ff7c190909090';
          await mapped(
            compiler,
            code,
            [],
            [map(0x6000n, 'code', 8, W), map(0x6008n, 'code', 8, W), map(0x8000n, 'code', 8, R)],
            async (cpu) => {
              const before = input(0x1000n, { 7: 0x6000n }),
                numeric = stack({}, 5),
                vector = banks();
              vector[0] = both ? (0xbbn << 64n) | 0xaan : 0x5an << 64n;
              vector[1] = (0x80n << 64n) | (both ? 0x80n : 0n);
              cpu.setState(before);
              seed(cpu, numeric);
              cpu.setXmmState(vector);
              const result = await cpu.run({ budget: 1n });
              outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1004n));
              noFault(result);
              x87(cpu, numeric);
              xmm(cpu, vector);
              memory(cpu, 0x8000n, (both ? 'bb' : '5a') + '0ff7c190909090');
              equal(
                result.resources.cachedArtifacts,
                0,
                'inactive guest position still aliases written code byte',
              );
            },
          );
        }
      },
    },
    {
      name: 'masked inactive unaliased source bytes retain owners while a selected identity write invalidates',
      async run() {
        for (const identity of [false, true]) {
          const code = '660ff7c190909090';
          await mapped(
            compiler,
            code,
            [{ id: 'data', bytes: hex('a5'.repeat(8)) }],
            [map(0x6000n, 'data', 8, W), map(0x6008n, 'code', 8, W), map(0x8000n, 'data', 8, R)],
            async (cpu) => {
              const before = input(0x1000n, { 7: 0x6000n }),
                numeric = stack({}, 5),
                vector = banks();
              vector[0] = (0x66n << 64n) | 0x5an;
              vector[1] = identity ? 0x80n << 64n : 0x80n;
              cpu.setState(before);
              seed(cpu, numeric);
              cpu.setXmmState(vector);
              const result = await cpu.run({ budget: 1n });
              outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1004n));
              noFault(result);
              x87(cpu, numeric);
              xmm(cpu, vector);
              memory(cpu, 0x1000n, code);
              memory(cpu, 0x8000n, (identity ? 'a5' : '5a') + 'a5'.repeat(7));
              equal(
                result.resources.cachedArtifacts,
                identity ? 0 : 1,
                'only actual backing writes invalidate',
              );
            },
          );
        }
      },
    },
    {
      name: 'masked and NT SMC stores finish numeric effects once before budget stop and changed-successor dispatch',
      async run() {
        for (const [operation, width, q, gp] of [
          ['0ff7c1', 8, true, false],
          ['660ff7c1', 16, false, false],
          ['0fe703', 8, true, false],
          ['660fe703', 16, false, false],
          ['480fc303', 8, false, true],
        ] as const)
          for (const [budget, stop] of [
            [1n, false],
            [2n, false],
            [2n, true],
          ] as const) {
            const length = operation.length / 2,
              tail = '90'.repeat(width - 5);
            const original = operation + 'b811000000' + tail,
              rewritten = operation + 'b82a000000' + tail;
            await mapped(
              compiler,
              original,
              [],
              [map(0x6000n, 'code', width, W, length)],
              async (cpu) => {
                const value =
                  width === 8 ? 0x9090900000002ab8n : 0x90909090909090909090900000002ab8n;
                const before = input(0x1000n, {
                  3: 0x6000n,
                  7: 0x6000n,
                  ...(gp ? { 0: value } : {}),
                });
                const numeric = stack({}, 5),
                  vector = banks();
                numeric.registers[0] = (0x1234n << 64n) | (value & MASK64);
                numeric.registers[1] = MASK64;
                vector[0] = value;
                vector[1] = (1n << 128n) - 1n;
                cpu.setState(before);
                seed(cpu, numeric);
                cpu.setXmmState(vector);
                const result = await cpu.run({
                  budget,
                  repeatBudget: 13n,
                  ...(stop ? { stop: 0x1000n + BigInt(length) } : {}),
                });
                const successor = budget === 2n && !stop;
                outcome(
                  result,
                  stop ? 'stop' : 'budget',
                  budget,
                  successor ? 2n : 1n,
                  13n,
                  0n,
                  changed(
                    before,
                    0x1000n + BigInt(length + (successor ? 5 : 0)),
                    successor ? { 0: 42n } : {},
                  ),
                );
                noFault(result);
                x87(cpu, q ? transition(numeric) : numeric);
                xmm(cpu, vector);
                memory(cpu, 0x1000n, rewritten);
                equal(
                  result.resources.dispatches,
                  successor ? 1 : 0,
                  'retirement gates precede modified successor',
                );
                equal(
                  result.resources.nativeEntries,
                  successor ? 2 : 1,
                  'changed bytes require new native entry',
                );
                equal(
                  result.resources.compilations,
                  successor ? 2 : 1,
                  'changed successor is recompiled',
                );
                if (!successor) {
                  const resumed = await cpu.run({ budget: 1n });
                  outcome(
                    resumed,
                    'budget',
                    1n,
                    1n,
                    1n,
                    0n,
                    changed(before, 0x1000n + BigInt(length + 5), { 0: 42n }),
                  );
                  x87(cpu, q ? transition(numeric) : numeric);
                  memory(cpu, 0x1000n, rewritten);
                }
              },
            );
          }
      },
    },
    {
      name: 'masked and streaming zero-budget and stop-current gates suppress pending checks and memory effects',
      async run() {
        for (const code of ['0ff7c1', '660ff7c1', '0fe703', '660fe703', '0fc303'])
          await using(compiler, code, LONG, async (cpu) => {
            const before = input(0x1000n, { 7: 0x6000n, 3: 0x6000n }),
              numeric = stack({}, 5, 0x37b, 0x8084);
            cpu.setState(before);
            seed(cpu, numeric);
            for (const stop of [false, true]) {
              const result = await cpu.run({
                budget: stop ? 1n : 0n,
                repeatBudget: 0n,
                ...(stop ? { stop: 0x1000n } : {}),
              });
              outcome(result, stop ? 'stop' : 'budget', stop ? 1n : 0n, 0n, 0n, 0n, before);
              x87(cpu, numeric);
              other(cpu);
              noFault(result);
              equal(result.resources.nativeEntries, 0, 'gate precedes generated effects');
            }
          });
      },
    },
    {
      name: 'masked and streaming exact spans ending at u64 MAX do not wrap or overread transport bytes',
      async run() {
        for (const [code, width, q] of [
          ['0ff7c1', 8, true],
          ['660ff7c1', 16, false],
          ['0fe703', 8, true],
          ['660fe703', 16, false],
          ['480fc303', 8, false],
          ['0fc303', 4, false],
        ] as const) {
          const at = (1n << 64n) - BigInt(width);
          await mapped(
            compiler,
            code,
            [{ id: 'data', bytes: hex('a5'.repeat(width + 2)) }],
            [map(at, 'data', width, W, 1), map(0x8000n, 'data', width + 2, R)],
            async (cpu) => {
              const before = input(0x1000n, { 7: at, 3: at, 0: DATA & MASK64 }),
                numeric = stack({}, 5),
                vector = banks();
              numeric.registers[0] = (0x1234n << 64n) | (DATA & MASK64);
              numeric.registers[1] = MASK64;
              vector[0] = DATA;
              vector[1] = (1n << 128n) - 1n;
              cpu.setState(before);
              seed(cpu, numeric);
              cpu.setXmmState(vector);
              const result = await cpu.run({ budget: 1n });
              outcome(
                result,
                'budget',
                1n,
                1n,
                1n,
                0n,
                changed(before, 0x1000n + BigInt(code.length / 2)),
              );
              noFault(result);
              x87(cpu, q ? transition(numeric) : numeric);
              xmm(cpu, vector);
              memory(cpu, 0x8000n, 'a5' + bytes(DATA, width) + 'a5');
            },
          );
        }
      },
    },
    {
      name: 'masked MMX zero masks check old pending x87 before nominal address admission',
      async run() {
        await using(compiler, '0ff7c1', LONG, async (cpu) => {
          const before = input(0x1000n, { 7: 0x800000000000n }),
            numeric = stack({}, 5, 0x37b, 0x8084);
          numeric.registers[1] = 0n;
          cpu.setState(before);
          seed(cpu, numeric);
          const result = await cpu.run({ budget: 1n });
          outcome(result, 'x87-exception', 1n, 0n, 1n, 0n, before);
          pending(result, numeric, 0x1000n);
          x87(cpu, numeric);
          other(cpu);
        });
      },
    },
  ];
}
