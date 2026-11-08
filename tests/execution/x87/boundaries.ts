import {
  ONE,
  INDEFINITE,
  NUMERIC_STATUS,
  OTHER_MXCSR,
  LONG,
  raw,
  stack,
  slot,
  clone,
  environment,
  seed,
  other,
  x87,
  noFault,
  pending,
  using,
  input,
  changed,
  outcome,
  equal,
  memory,
  context,
  fault,
  banks,
  xmm,
  type Scenario,
} from './fixture.js';

export function boundaryScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'x87 pending detection follows decode legality and precedes waiting operands while FN stores retain their own failures',
      async run() {
        for (const [code, reason, width] of [
          ['db2b', 'x87-exception', 10],
          ['d93b', 'data-fault', 2],
          ['dd3b', 'data-fault', 2],
          ['d9f8', 'unsupported', 0],
          ['f0d9e8', 'invalid-encoding', 0],
          ['db2d', 'fetch-fault', 1],
        ] as const) {
          await using(compiler, code, LONG, async (cpu) => {
            const before = input(0x1000n, { 3: 0x6000n }),
              state = stack({}, 0, 0x37b, 0x8084);
            cpu.setState(before);
            seed(cpu, state);
            const result = await cpu.run({ budget: 1n, repeatBudget: 5n });
            outcome(result, reason, 1n, 0n, 5n, 0n, before);
            x87(cpu, state);
            other(cpu);
            if (reason === 'x87-exception') pending(result, state, 0x1000n);
            else if (reason === 'data-fault') {
              fault(result, {
                instructionPc: 0x1000n,
                address: 0x6000n,
                width,
                access: 'write',
                cause: 'unmapped',
                failingAddress: 0x6000n,
              });
              equal(result.x87Exception, undefined, 'no pending record on FN access fault');
            } else if (reason === 'fetch-fault') {
              fault(result, {
                instructionPc: 0x1000n,
                address: 0x1002n,
                width,
                access: 'execute',
                cause: 'unmapped',
                failingAddress: 0x1002n,
              });
              equal(result.x87Exception, undefined, 'decode fault before pending record');
            } else noFault(result);
          });
        }
      },
    },
    {
      name: 'x87 segment repair preserves a failed store then posts deferred overflow without writing or popping',
      async run() {
        const execution = context('protected', false, true);
        execution.segments.ds.limit = 0x6002;
        await using(
          compiler,
          'd91f9b',
          execution,
          async (cpu) => {
            const before = input(0x1000n, { 3: 0x6000n }),
              state = stack({ 0: raw(0x407f) }, 0, 0x377);
            cpu.setState(before);
            seed(cpu, state);
            const failed = await cpu.run({ budget: 2n, repeatBudget: 7n });
            outcome(failed, 'segment-fault', 2n, 0n, 7n, 0n, before);
            x87(cpu, state);
            other(cpu);
            equal(failed.segmentFault?.segment, 'ds', 'selected segment');
            equal(failed.segmentFault?.cause, 'limit', 'segment limit');
            equal(failed.segmentFault?.offset, 0x6000n, 'store offset');
            equal(failed.segmentFault?.width, 4, 'store width');
            equal(failed.segmentFault?.failingOffset, 0x6003n, 'late segment byte');
            equal(failed.x87Exception, undefined, 'no numeric detector during segment failure');
            memory(cpu, 0x6000n, 'a5a5a5a5');
            const repaired = cpu.readContext();
            if (repaired.mode === 'long64') throw Error('legacy profile');
            repaired.segments.ds.limit = 0xffffffff;
            cpu.setContext(repaired);
            const after = clone(state);
            after.statusWord = 0x8088;
            const posted = environment(after, 0x1000n, 0x6000n, 0x11f);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
            x87(cpu, posted, NUMERIC_STATUS);
            other(cpu);
            noFault(result);
            memory(cpu, 0x6000n, 'a5a5a5a5');
            const detector = await cpu.run({ budget: 1n });
            outcome(detector, 'x87-exception', 1n, 0n, 1n, 0n, changed(before, 0x1002n));
            pending(detector, cpu.readX87State(), 0x1002n);
          },
          { data: [{ base: 0x6000n, bytes: 'a5a5a5a5' }] },
        );
      },
    },
    {
      name: 'x87 pending state is not imposed on skipped paths and raw SSE predecessors can complete before detection',
      async run() {
        await using(compiler, '7402d9e890', LONG, async (cpu) => {
          const before = input(0x1000n, {}, 0x442n),
            state = stack({}, 3, 0x37b, 0x8084);
          cpu.setState(before);
          seed(cpu, state);
          const result = await cpu.run({ budget: 2n });
          outcome(result, 'budget', 2n, 2n, 2n, 0n, changed(before, 0x1005n));
          x87(cpu, state);
          other(cpu);
          noFault(result);
        });
        await using(compiler, '0f57c09b', LONG, async (cpu) => {
          const before = input(),
            state = stack({}, 3, 0x37b, 0x8084),
            expected = banks();
          expected[0] = 0n;
          cpu.setState(before);
          seed(cpu, state);
          const result = await cpu.run({ budget: 1n });
          outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1003n));
          x87(cpu, state);
          xmm(cpu, expected);
          equal(cpu.readMxcsr(), OTHER_MXCSR, 'raw SSE preserves MXCSR');
          noFault(result);
          const detector = await cpu.run({ budget: 1n });
          outcome(detector, 'x87-exception', 1n, 0n, 1n, 0n, changed(before, 0x1003n));
          pending(detector, state, 0x1003n);
          xmm(cpu, expected);
        });
      },
    },
    {
      name: 'x87 resource exits and owner eviction preserve pending state until a reached waiting entry executes',
      async run() {
        await using(
          compiler,
          '909b',
          LONG,
          async (cpu) => {
            const before = input(),
              state = stack({}, 4, 0x37b, 0x8084);
            cpu.setState(before);
            seed(cpu, state);
            const limited = await cpu.run({ budget: 2n, repeatBudget: 7n });
            outcome(limited, 'resource-limit', 2n, 1n, 7n, 0n, changed(before, 0x1001n));
            x87(cpu, state);
            other(cpu);
            noFault(limited);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'x87-exception', 1n, 0n, 1n, 0n, changed(before, 0x1001n));
            pending(result, state, 0x1001n);
            x87(cpu, state);
            other(cpu);
            equal(result.resources.compilations, 1, 'waiting owner compiled after resource exit');
            equal(result.resources.cachedArtifacts, 1, 'old owner evicted');
          },
          { limits: { maxInstructions: 1, maxTranslationsPerRun: 1, maxCachedArtifacts: 1 } },
        );
      },
    },
    {
      name: 'x87 changed TOP payloads and precision are invocation data at a retained middle entry',
      async run() {
        await using(compiler, 'd8c1d8c1', LONG, async (cpu) => {
          const before = input(),
            state = stack({ 0: ONE, 1: raw(0x4000) });
          cpu.setState(before);
          seed(cpu, state);
          const first = await cpu.run({ budget: 1n });
          outcome(first, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
          const replacement = stack({ 0: raw(0x4001), 1: raw(0x4000) }, 6, 0x27f),
            expected = clone(replacement);
          slot(expected, 6, raw(0x4001, 0xc000000000000000n));
          cpu.setX87State(replacement);
          const result = await cpu.run({ budget: 1n });
          outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1004n));
          x87(cpu, environment(expected, 0x1002n), NUMERIC_STATUS);
          other(cpu);
          noFault(result);
          equal(
            result.resources.compilations,
            0,
            'changed x87 imports do not recompile retained middle entry',
          );
        });
      },
    },
    {
      name: 'x87 deferred producers retain integer effects and FNSTSW before a separately resumable WAIT',
      async run() {
        await using(compiler, 'd8c14883c001dfe09b', LONG, async (cpu) => {
          const before = input(0x1000n, { 0: 10n }, 0xcd7n),
            state = stack({ 0: ONE, 1: raw(0x3fc3) }, 0, 0x25f),
            expected = clone(state);
          slot(expected, 0, ONE);
          expected.statusWord = 0x80a0;
          const posted = environment(expected, 0x1000n, undefined, 0xc1);
          cpu.setState(before);
          seed(cpu, state);
          const first = await cpu.run({ budget: 2n, repeatBudget: 7n });
          const afterAdd = changed(before, 0x1006n, { 0: 11n }, 0x402n);
          outcome(first, 'budget', 2n, 2n, 7n, 0n, afterAdd);
          noFault(first);
          x87(cpu, posted, NUMERIC_STATUS);
          const status = await cpu.run({ budget: 1n, repeatBudget: 5n }),
            atWait = changed(afterAdd, 0x1008n, { 0: 0x80a0n });
          outcome(status, 'budget', 1n, 1n, 5n, 0n, atWait);
          noFault(status);
          x87(cpu, posted, NUMERIC_STATUS);
          for (const options of [{ budget: 0n }, { budget: 2n, stop: 0x1008n }]) {
            const result = await cpu.run(options);
            outcome(
              result,
              options.budget === 0n ? 'budget' : 'stop',
              options.budget,
              0n,
              options.budget,
              0n,
              atWait,
            );
            noFault(result);
            x87(cpu, posted, NUMERIC_STATUS);
          }
          for (let retry = 0; retry < 2; retry++) {
            const result = await cpu.run({ budget: 3n, repeatBudget: 9n });
            outcome(result, 'x87-exception', 3n, 0n, 9n, 0n, atWait);
            pending(result, cpu.readX87State(), 0x1008n);
            x87(cpu, posted, NUMERIC_STATUS);
            cpu.setState(cpu.readState());
            cpu.setMxcsr(OTHER_MXCSR);
            cpu.setContext({ ...LONG });
          }
          const repaired = cpu.readX87State();
          repaired.controlWord = 0x37f;
          repaired.statusWord &= ~0x8080;
          cpu.setX87State(repaired);
          const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
          outcome(result, 'budget', 1n, 1n, 0n, 0n, changed(atWait, 0x1009n));
          noFault(result);
          x87(cpu, repaired);
          other(cpu);
          equal(result.resources.compilations, 0, 'new controls are observed at retained WAIT');
        });
      },
    },
    {
      name: 'x87 no-wait clear init and status operations preserve payloads while waiting spellings retain two boundaries',
      async run() {
        await using(compiler, 'dfe09bdbe3dbe2', LONG, async (cpu) => {
          const before = input(),
            state = stack({}, 5, 0x37b, 0x8084);
          cpu.setState(before);
          seed(cpu, state);
          const status = await cpu.run({ budget: 1n });
          const atWait = changed(before, 0x1002n, {
            0: (before.registers[0]! & ~0xffffn) | 0xa884n,
          });
          outcome(status, 'budget', 1n, 1n, 1n, 0n, atWait);
          x87(cpu, state);
          noFault(status);
          const wait = await cpu.run({ budget: 1n });
          outcome(wait, 'x87-exception', 1n, 0n, 1n, 0n, atWait);
          pending(wait, state, 0x1002n);
          cpu.setState(changed(atWait, 0x1003n));
          const initialized = await cpu.run({ budget: 1n });
          outcome(initialized, 'budget', 1n, 1n, 1n, 0n, changed(atWait, 0x1005n));
          const empty = {
            ...clone(state),
            controlWord: 0x37f,
            statusWord: 0,
            tagWord: 0xffff,
            instructionPointer: 0n,
            dataPointer: 0n,
            opcode: 0,
          };
          x87(cpu, empty);
          noFault(initialized);
          other(cpu);
          const clearing = clone(state);
          clearing.statusWord |= 0x4500;
          cpu.setX87State(clearing);
          const cleared = await cpu.run({ budget: 1n });
          const clean = clone(clearing);
          clean.statusWord &= 0x7f00;
          outcome(cleared, 'budget', 1n, 1n, 1n, 0n, changed(atWait, 0x1007n));
          x87(cpu, clean);
          noFault(cleared);
          other(cpu);
        });
        await using(compiler, '9bdbe3', LONG, async (cpu) => {
          const before = input(),
            state = stack({ 0: ONE }, 3, 0x27f);
          cpu.setState(before);
          seed(cpu, state);
          const first = await cpu.run({ budget: 1n });
          outcome(first, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1001n));
          x87(cpu, state);
          noFault(first);
          const second = await cpu.run({ budget: 1n });
          outcome(second, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1003n));
          x87(cpu, {
            ...clone(state),
            controlWord: 0x37f,
            statusWord: 0,
            tagWord: 0xffff,
            instructionPointer: 0n,
            dataPointer: 0n,
            opcode: 0,
          });
          noFault(second);
        });
      },
    },
    {
      name: 'x87 FLDCW unmasks old sticky status for the next waiting instruction and FN memory controls bypass it',
      async run() {
        await using(
          compiler,
          'd92bd93bdd3bd9d0',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 3: 0x6000n }),
              state = stack({}, 0, 0x37f, 4),
              unmasked = clone(state);
            unmasked.controlWord = 0x37b;
            unmasked.statusWord = 0x8084;
            cpu.setState(before);
            seed(cpu, state);
            const load = await cpu.run({ budget: 1n });
            outcome(load, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
            x87(cpu, unmasked);
            noFault(load);
            const cw = await cpu.run({ budget: 1n });
            outcome(cw, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1004n));
            x87(cpu, unmasked);
            memory(cpu, 0x6000n, '7b03');
            noFault(cw);
            const sw = await cpu.run({ budget: 1n });
            outcome(sw, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1006n));
            x87(cpu, unmasked);
            memory(cpu, 0x6000n, '8480');
            noFault(sw);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'x87-exception', 1n, 0n, 1n, 0n, changed(before, 0x1006n));
            pending(result, unmasked, 0x1006n);
            other(cpu);
          },
          { data: [{ base: 0x6000n, bytes: '7b03' }] },
        );
      },
    },
    {
      name: 'x87 standalone WAIT executes at the last u64 byte without probing a following instruction',
      async run() {
        const pc = (1n << 64n) - 1n;
        await using(
          compiler,
          '9b',
          LONG,
          async (cpu) => {
            const before = input(pc),
              state = stack();
            cpu.setState(before);
            seed(cpu, state);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0n));
            x87(cpu, state);
            other(cpu);
            noFault(result);
            const posted = stack({}, 0, 0x37b, 0x8084);
            cpu.setX87State(posted);
            cpu.setState(before);
            const failed = await cpu.run({ budget: 1n });
            outcome(failed, 'x87-exception', 1n, 0n, 1n, 0n, before);
            pending(failed, posted, pc);
            x87(cpu, posted);
          },
          { entry: pc, codeBase: pc },
        );
      },
    },
    {
      name: 'x87 false conditional moves check both stack operands and masked stack faults write indefinite independently of predicates',
      async run() {
        for (const destination of [false, true])
          for (const source of [false, true])
            for (const condition of [false, true])
              for (const masked of [false, true]) {
                const values: Record<number, bigint> = {};
                if (destination) values[0] = ONE;
                if (source) values[1] = raw(0x7fff, 0x8000000000000011n);
                const invalid = !destination || !source,
                  state = stack(values, 0, masked ? 0x37f : 0x37e, 0x200),
                  expected = clone(state);
                if (invalid) {
                  expected.statusWord = masked ? 0x41 : 0x80c1;
                  if (masked) slot(expected, 0, INDEFINITE);
                } else {
                  expected.statusWord = 0x200;
                  if (condition) slot(expected, 0, state.registers[1]!);
                }
                await using(compiler, 'dac1', LONG, async (cpu) => {
                  const before = input(0x1000n, {}, condition ? 0x403n : 0x402n);
                  cpu.setState(before);
                  seed(cpu, state);
                  const result = await cpu.run({ budget: 1n });
                  outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
                  x87(
                    cpu,
                    environment(
                      expected,
                      0x1000n,
                      undefined,
                      invalid && !masked ? 0x2c1 : undefined,
                    ),
                    NUMERIC_STATUS,
                  );
                  other(cpu);
                  noFault(result);
                });
              }
      },
    },
    {
      name: 'x87 constants clear incoming C1 and honor rounding without numeric precision status',
      async run() {
        const constants = [
          ONE,
          raw(0x4000, 0xd49a784bcd1b8afen),
          raw(0x3fff, 0xb8aa3b295c17f0bcn),
          raw(0x4000, 0xc90fdaa22168c235n),
          raw(0x3ffd, 0x9a209a84fbcff799n),
          raw(0x3ffe, 0xb17217f7d1cf79acn),
          0n,
        ];
        for (let index = 0; index < 7; index++)
          for (const rc of index === 3 ? [0, 1, 2, 3] : [0]) {
            const state = stack({}, 0, 0x7f | (rc << 10), 0x200),
              expected = clone(state);
            slot(
              expected,
              7,
              index === 3 && (rc === 1 || rc === 3) ? constants[index]! - 1n : constants[index]!,
            );
            expected.statusWord = 0x3800;
            await using(compiler, `d9${(0xe8 + index).toString(16)}`, LONG, async (cpu) => {
              const before = input();
              cpu.setState(before);
              seed(cpu, state);
              const result = await cpu.run({ budget: 1n });
              outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1002n));
              x87(cpu, environment(expected), NUMERIC_STATUS);
              other(cpu);
              noFault(result);
            });
          }
      },
    },
  ];
}
