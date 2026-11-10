import { Core } from '../../../host/core.js';
import {
  using,
  snapshot,
  initial,
  loadedCode,
  loadedData,
  withGate,
  gate,
  CODE32,
  DATA32,
  STACK,
  FILL,
  image,
  same,
  equal,
  check,
  throws,
  type Scenario,
} from './fixture.js';
import { rejects } from '../../support/fixture.js';

export function lifecycleScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'handler compilation rejection follows one committed exception frame and retains the fatal engine lifecycle',
      async run() {
        const execution = snapshot('protected');
        execution.segments.cs = loadedCode(32, 0x18);
        execution.segments.ss = loadedData(32);
        const address = withGate(execution, 6);
        const create = Core.create;
        const compile = WebAssembly.compile;
        const rejection = new WebAssembly.CompileError('injected handler compilation rejection');
        let observed: Core | undefined;
        Core.create = async (...args) => {
          observed = await create(...args);
          return observed;
        };
        try {
          await using(
            compiler,
            '900f0b',
            execution,
            async (cpu) => {
              cpu.setState(initial(0x1000n, { 4: 0x8000n }, 0x202n));
              let compilations = 0;
              let inspected = false;
              let failed = false;
              const frame = image([0x1001n, 0x18n, 0x10202n], 4);
              WebAssembly.compile = async (bytes) => {
                if (++compilations === 1) return compile(bytes);
                check(observed, 'real core instance observed for publication check');
                const committed = observed.snapshot();
                same(
                  committed.event,
                  { kind: 'ready' },
                  'entry completed before handler compilation',
                );
                equal(committed.rip, 0x2000n, 'handler PC was published');
                equal(committed.registers[4], 0x7ff4n, 'exactly one frame was pushed');
                same(observed.readMemory(0x7ff4n, 12), frame, 'literal committed source frame');
                throws(
                  () => cpu.readState(),
                  'public inspection still rejects pending compilation',
                );
                inspected = true;
                await Promise.resolve();
                throw rejection;
              };
              try {
                await cpu.run({ budget: 2n, exceptionDelivery: { budget: 1n } });
              } catch (error) {
                check(error instanceof Error, 'engine failure is an Error');
                equal(error.message, 'cpu engine failed', 'fatal engine failure envelope');
                equal(error.cause, rejection, 'original asynchronous compilation cause');
                failed = true;
              } finally {
                WebAssembly.compile = compile;
              }
              check(
                failed && inspected,
                'rejection occurred after the committed-entry observation',
              );
              equal(compilations, 2, 'source compiled once before handler rejection');
              check(observed, 'core observation remains available to test the committed bytes');
              same(
                observed.readMemory(0x7ff4n, 12),
                frame,
                'failure does not replay or roll back the frame',
              );
              equal(
                observed.snapshot().registers[4],
                0x7ff4n,
                'failed host cannot have re-entered delivery',
              );
              throws(() => cpu.readState(), 'failed CPU rejects scalar reads');
              throws(() => cpu.readMemory(0x7ff4n, 12), 'failed CPU rejects memory reads');
              throws(() => cpu.setState(initial()), 'failed CPU rejects state replacement');
              await rejects(() => cpu.run({ budget: 0n }), 'failed CPU cannot resume');
            },
            {
              data: [
                { base: 0x4008n, bytes: CODE32 + DATA32 + CODE32 },
                { base: address, bytes: gate(32, 8, 0x2000n, 0) },
                { base: 0x2000n, bytes: '90', execute: true },
                { base: STACK, bytes: FILL },
              ],
            },
          );
        } finally {
          Core.create = create;
          WebAssembly.compile = compile;
        }
      },
    },
  ];
}
