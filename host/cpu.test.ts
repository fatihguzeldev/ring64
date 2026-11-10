import assert from 'node:assert/strict';
import test from 'node:test';
import { Core } from './core.js';
import { Cpu, createCpu } from './cpu.js';

const limits = {
  maxInstructions: 32,
  maxSourceBytes: 256,
  maxArtifactBytes: 65536,
  maxCachedArtifacts: 8,
  maxCachedBytes: 1048576,
  maxTranslationsPerRun: 8,
};

test('CPU construction cannot bypass the factory lifecycle owner', () => {
  assert.throws(() => Reflect.construct(Cpu, [null, limits, 0]), /factory|createCpu/);
});

test('debug trap result retains the completed source and prepared continuation separately', async () => {
  const { cpu } = await fixture([
    { reason: 'debug-exception', remaining: 0n, repeatRemaining: 7n, rip: 0x2000n },
  ]);
  try {
    const result = await cpu.run({ budget: 1n, repeatBudget: 7n, stop: 0x2000n });
    assert.equal(result.reason, 'debug-exception');
    assert.equal(result.retired, 1n);
    assert.equal(result.remaining, 0n);
    assert.equal(result.remainingRepeatBudget, 7n);
    assert.equal(result.state.rip, 0x2000n);
    assert.deepEqual(result.debugException, {
      vector: 1,
      class: 'trap',
      cause: 'single-step',
      instructionPc: 0x1000n,
      resumePc: 0x2000n,
      instructionCompleted: true,
      resumeFlags: 0x102n,
    });
    assert.equal(result.fault, undefined);
  } finally {
    cpu.dispose();
  }
});

test('boundary getters cannot publish an outer state import after run or disposal', async () => {
  for (const action of ['run', 'dispose'] as const) {
    const { cpu, stateImports } = await fixture([
      { reason: 'budget', remaining: 0n, repeatRemaining: 1n },
    ]);
    let pending: Promise<unknown> | undefined;
    const source = {
      registers: Array<bigint>(16).fill(9n),
      flags: 2n,
      rip: 0x3000n,
      interruptibility: {
        get sti() {
          if (action === 'run') pending = cpu.run({ budget: 1n, repeatBudget: 1n });
          else cpu.dispose();
          return false;
        },
        ss: true,
      },
    };
    assert.throws(() => cpu.setState(source), action === 'run' ? /running/ : /disposed/);
    assert.deepEqual(stateImports, []);
    if (pending) await pending;
    if (action === 'dispose') assert.throws(() => cpu.readState(), /disposed/);
    cpu.dispose();
  }
});

test('a boundary profile change during asynchronous compile refuses stale publication', async () => {
  const f = await fixture([{ reason: 'budget', remaining: 0n, repeatRemaining: 1n }]);
  const original = WebAssembly.compile;
  let compilations = 0;
  WebAssembly.compile = async (bytes) => {
    if (compilations++ === 0) f.setBoundaryObserved(true);
    return original(bytes);
  };
  try {
    const result = await f.cpu.run({ budget: 1n, repeatBudget: 1n });
    assert.equal(result.reason, 'budget');
    assert.equal(result.retired, 1n);
    assert.equal(result.resources.compilations, 2);
    assert.deepEqual(f.instantiatedProfiles, [true]);
    assert.equal(f.entries.length, 1);
  } finally {
    WebAssembly.compile = original;
    f.cpu.dispose();
  }
});

test('a synchronously completed cached run from an option getter rejects the outer run', async () => {
  const f = await fixture(
    Array.from({ length: 3 }, () => ({ reason: 'budget', remaining: 0n, repeatRemaining: 1n })),
  );
  let nested: Promise<unknown> | undefined;
  try {
    await f.cpu.run({ budget: 1n });
    await assert.rejects(
      f.cpu.run({
        get budget() {
          nested = f.cpu.run({ budget: 1n });
          assert.equal(f.cpu.readState().rip, 0x1000n, 'cached nested call already completed');
          return 1n;
        },
      }),
      /run.*capture/,
    );
    await nested;
    assert.equal(f.entries.length, 2, 'only warm and nested entries execute');
  } finally {
    await nested;
    f.cpu.dispose();
  }
});

test('an invalid nested run attempt does not invalidate a state capture', async () => {
  const f = await fixture();
  let nested: Promise<unknown> | undefined;
  try {
    f.cpu.setState({
      registers: Array<bigint>(16).fill(9n),
      rip: 0x2000n,
      get flags() {
        nested = f.cpu.run({ budget: -1n });
        void nested.catch(() => {});
        return 2n;
      },
    });
    await assert.rejects(nested!, /unsigned 64-bit bigint/);
    assert.equal(f.stateImports.length, 1);
    assert.equal(f.entries.length, 0);
  } finally {
    f.cpu.dispose();
  }
});

test('cached boundary variants consume one preparation token per entry without hot profile queries', async () => {
  const steps = Array.from({ length: 4 }, (_, index) => ({
    reason: index % 2 === 0 ? 'dispatch' : 'budget',
    remaining: index % 2 === 0 ? 1n : 0n,
    repeatRemaining: 0n,
    boundaryObserved: index % 2 === 0,
  }));
  const f = await fixture(steps);
  try {
    const first = await f.cpu.run({ budget: 2n, repeatBudget: 0n });
    assert.equal(first.resources.compilations, 2);
    const cached = await f.cpu.run({ budget: 2n, repeatBudget: 0n });
    assert.equal(cached.resources.compilations, 0);
    assert.equal(cached.resources.nativeEntries, 2);
    assert.deepEqual(f.preparedProfiles, [false, true, false, true]);
    assert.deepEqual(f.queriedProfiles, [false, true], 'only cold post-await queries');
    await f.cpu.run({ budget: 0n });
    assert.deepEqual(f.preparedProfiles, [false, true, false, true, false]);
    assert.deepEqual(f.queriedProfiles, [false, true]);
  } finally {
    f.cpu.dispose();
  }
});

type Step = {
  reason: string;
  remaining: bigint;
  repeatRemaining: bigint;
  rip?: bigint;
  boundaryObserved?: boolean;
};

async function fixture(steps: Step[] = []) {
  let current = { rip: 0x1000n, remaining: 0n, repeatRemaining: 0n };
  let xmm = Array<bigint>(16).fill(0n);
  const entries: { budget: bigint; repeatBudget: bigint | undefined }[] = [];
  const stateImports: unknown[] = [];
  let boundaryObserved = false;
  let irq: number | null = null;
  let nmiPending = false;
  const deliveryConfigurations: boolean[] = [];
  const instantiatedProfiles: boolean[] = [];
  const preparedProfiles: boolean[] = [];
  const queriedProfiles: boolean[] = [];
  const engine = {
    current: () => current,
    snapshot: () => ({
      registers: Array<bigint>(16).fill(0n),
      flags: 2n,
      rip: current.rip,
      interruptibility: { sti: false, ss: false },
      event: { kind: 'ready' },
      interrupts: { irq, nmiPending, nmiBlocked: false },
    }),
    configureDelivery(enabled: boolean) {
      deliveryConfigurations.push(enabled);
    },
    eventKind: () => 'ready',
    hasQueuedInterrupts: () => irq !== null || nmiPending,
    externalBoundary: () => 'dispatch',
    requestInterrupt(vector: number) {
      if (irq !== null) return false;
      irq = vector;
      return true;
    },
    requestNmi() {
      nmiPending = true;
    },
    stageException: () => false,
    deliverException: () => 'dispatch',
    setState(state: unknown) {
      stateImports.push(state);
    },
    debugException: () => ({
      vector: 1,
      class: 'trap',
      cause: 'single-step',
      instructionPc: 0x1000n,
      resumePc: 0x2000n,
      instructionCompleted: true,
      resumeFlags: 0x102n,
    }),
    readXmmState: () => [...xmm],
    setXmmState: (bank: bigint[]) => {
      xmm = [...bank];
    },
    clearFault() {},
    prepareEntry() {
      preparedProfiles.push(boundaryObserved);
      return boundaryObserved;
    },
    fault() {},
    segmentFault() {},
    alignmentFault() {},
    probe: () => 'dispatch',
    compile: (pc: bigint) => ({
      bytes: Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0),
      metadata: {
        entries: [pc],
        owner: 1n,
        contextVersion: 0n,
        boundaryObserved,
        byteLength: 8,
        instructionCount: 1,
        blockCount: 1,
        sourceBytes: 1,
        dependencies: [],
      },
    }),
    contextVersion: () => 0n,
    boundaryObserved: () => {
      queriedProfiles.push(boundaryObserved);
      return boundaryObserved;
    },
    valid: () => true,
    instantiate: () => {
      instantiatedProfiles.push(boundaryObserved);
      return () => 0;
    },
    activate() {},
    release() {},
    execute(_run: unknown, _index: number, budget: bigint, _stop: unknown, repeatBudget?: bigint) {
      entries.push({ budget, repeatBudget });
      const step = steps.shift();
      assert.ok(step, 'unexpected native entry');
      if (step.boundaryObserved !== undefined) boundaryObserved = step.boundaryObserved;
      current = { ...current, ...step };
      return step.reason;
    },
    dispose() {},
  };
  const create = Core.create;
  Core.create = async () => engine as unknown as Core;
  try {
    const cpu = await createCpu({
      compiler: new Uint8Array(),
      code: { base: 0x1000n, bytes: Uint8Array.of(0x90) },
      ram: { base: 0x8000n, bytes: new Uint8Array(1) },
      limits,
    });
    return {
      cpu,
      entries,
      stateImports,
      instantiatedProfiles,
      preparedProfiles,
      queriedProfiles,
      deliveryConfigurations,
      setBoundaryObserved(value: boolean) {
        boundaryObserved = value;
      },
    };
  } finally {
    Core.create = create;
  }
}

test('run reports both accounting pairs on exits before native execution', async () => {
  const { cpu } = await fixture();
  try {
    for (const input of [
      { budget: 0n },
      { budget: 7n, stop: 0x1000n },
      { budget: 0n, repeatBudget: 5n },
      { budget: 7n, stop: 0x1000n, repeatBudget: 0n },
    ]) {
      const result = await cpu.run(input);
      assert.equal(result.retired, 0n);
      assert.equal(result.remaining, input.budget);
      assert.equal(result.repeatIterations, 0n);
      assert.equal(result.remainingRepeatBudget, input.repeatBudget ?? input.budget);
    }
  } finally {
    cpu.dispose();
  }
});

test('canonical delivery and its legacy alias capture one budget and share accounting', async () => {
  const f = await fixture();
  try {
    for (const alias of ['eventDelivery', 'exceptionDelivery'] as const) {
      let optionReads = 0,
        budgetReads = 0;
      const options = {
        budget: 0n,
        get [alias]() {
          optionReads++;
          return {
            get budget() {
              budgetReads++;
              return 7n;
            },
          };
        },
      };
      const result = await f.cpu.run(options);
      assert.equal(optionReads, 1);
      assert.equal(budgetReads, 1);
      assert.equal(result.deliveryAttempts, 0n);
      assert.equal(result.remainingDeliveryBudget, 7n);
    }
    assert.deepEqual(f.deliveryConfigurations, [true, false, true, false]);
    for (const options of [
      { budget: 0n, eventDelivery: { budget: 1n }, exceptionDelivery: { budget: 1n } },
      { budget: 0n, eventDelivery: null, exceptionDelivery: { budget: 1n } },
    ])
      await assert.rejects(f.cpu.run(options as never), /mutually exclusive/);
    const omitted = await f.cpu.run({
      budget: 0n,
      eventDelivery: undefined,
      exceptionDelivery: undefined,
    });
    assert.equal(omitted.deliveryAttempts, undefined);
    assert.deepEqual(f.deliveryConfigurations, [true, false, true, false]);
    for (const value of [
      null,
      [],
      false,
      {},
      { budget: undefined },
      { budget: 0 },
      { budget: -1n },
      { budget: 1n << 64n },
    ])
      await assert.rejects(f.cpu.run({ budget: 0n, eventDelivery: value } as never), TypeError);
  } finally {
    f.cpu.dispose();
  }
});

test('idle intake preserves one IRQ slot coalesces NMI and validates even while occupied', async () => {
  const f = await fixture();
  try {
    assert.equal(f.cpu.requestInterrupt(-0), true);
    assert.equal(f.cpu.requestInterrupt(255), false);
    assert.equal(f.cpu.requestInterrupt(0), false);
    for (const vector of [-1, 256, 1.5, NaN, Infinity, '2', 2n, null, new Number(2)])
      assert.throws(() => f.cpu.requestInterrupt(vector as number), TypeError);
    f.cpu.requestNmi();
    f.cpu.requestNmi();
    assert.deepEqual(f.cpu.readState().interrupts, { irq: 0, nmiPending: true, nmiBlocked: false });
    const result = await f.cpu.run({ budget: 0n, eventDelivery: { budget: 4n } });
    assert.equal(result.deliveryAttempts, 0n);
    assert.deepEqual(result.state.interrupts, { irq: 0, nmiPending: true, nmiBlocked: false });
  } finally {
    f.cpu.dispose();
  }
});

test('nested intake during capture survives rejected scalar input and remains visible to admitted option capture', async () => {
  const f = await fixture();
  try {
    assert.throws(
      () =>
        f.cpu.setState({
          registers: Array<bigint>(16).fill(0n),
          flags: 2n,
          rip: 0x1000n,
          get interrupts() {
            f.cpu.requestNmi();
            return { irq: null, nmiPending: 0, nmiBlocked: false };
          },
        } as never),
      TypeError,
    );
    assert.deepEqual(f.stateImports, []);
    assert.equal(f.cpu.readState().interrupts.nmiPending, true);
    const result = await f.cpu.run({
      budget: 0n,
      get eventDelivery() {
        assert.equal(f.cpu.requestInterrupt(13), true);
        return { budget: 2n };
      },
    });
    assert.equal(result.reason, 'budget');
    assert.deepEqual(result.state.interrupts, { irq: 13, nmiPending: true, nmiBlocked: false });
    assert.equal(result.deliveryAttempts, 0n);
  } finally {
    f.cpu.dispose();
  }
});

test('active compile failed and disposed lifecycles reject external intake before state changes', async () => {
  const f = await fixture([{ reason: 'budget', remaining: 0n, repeatRemaining: 0n }]);
  const running = f.cpu.run({ budget: 1n, repeatBudget: 0n });
  assert.throws(() => f.cpu.requestInterrupt(2), /running/);
  assert.throws(() => f.cpu.requestNmi(), /running/);
  await running;
  assert.deepEqual(f.cpu.readState().interrupts, {
    irq: null,
    nmiPending: false,
    nmiBlocked: false,
  });
  f.cpu.dispose();
  assert.throws(() => f.cpu.requestInterrupt(2), /disposed/);
  assert.throws(() => f.cpu.requestNmi(), /disposed/);
  const failed = await fixture([{ reason: 'budget', remaining: 1n, repeatRemaining: 0n }]);
  await assert.rejects(failed.cpu.run({ budget: 1n, repeatBudget: 0n }), /engine failed/);
  assert.throws(() => failed.cpu.requestInterrupt(2), /failed/);
  assert.throws(() => failed.cpu.requestNmi(), /failed/);
  failed.cpu.dispose();
});

for (const field of ['eventDelivery', 'exceptionDelivery', 'budget'] as const)
  test(`a cached completed run during ${field} alias capture rejects outer admission`, async () => {
    const f = await fixture(
      Array.from({ length: 2 }, () => ({ reason: 'budget', remaining: 0n, repeatRemaining: 0n })),
    );
    let nested: Promise<unknown> | undefined;
    try {
      await f.cpu.run({ budget: 1n, repeatBudget: 0n });
      const start = () => {
        nested = f.cpu.run({ budget: 1n, repeatBudget: 0n });
      };
      const delivery = {
        get budget() {
          if (field === 'budget') start();
          return 1n;
        },
      };
      await assert.rejects(
        f.cpu.run({
          budget: 1n,
          get eventDelivery() {
            if (field === 'eventDelivery') start();
            return field === 'exceptionDelivery' ? undefined : delivery;
          },
          get exceptionDelivery() {
            if (field === 'exceptionDelivery') start();
            return field === 'exceptionDelivery' ? delivery : undefined;
          },
        }),
        /run.*capture/,
      );
      await nested;
      assert.equal(f.entries.length, 2);
    } finally {
      await nested;
      f.cpu.dispose();
    }
  });

test('run captures every option once and defaults repetition allowance to the captured budget', async () => {
  const { cpu } = await fixture();
  const reads = { budget: 0, stop: 0, repeatBudget: 0 };
  try {
    const result = await cpu.run({
      get budget() {
        return ++reads.budget === 1 ? 7n : -1n;
      },
      get stop() {
        return ++reads.stop === 1 ? 0x1000n : -1n;
      },
      get repeatBudget() {
        reads.repeatBudget++;
        return undefined;
      },
    });
    assert.deepEqual(reads, { budget: 1, stop: 1, repeatBudget: 1 });
    assert.equal(result.remainingRepeatBudget, 7n);
  } finally {
    cpu.dispose();
  }
});

test('malformed explicit repetition allowances reject even before budget, stop or ordinary execution', async () => {
  const { cpu } = await fixture();
  try {
    for (const repeatBudget of [-1n, 1n << 64n, null, 0, '1']) {
      for (const input of [{ budget: 0n }, { budget: 1n, stop: 0x1000n }, { budget: 1n }]) {
        await assert.rejects(
          cpu.run({ ...input, repeatBudget: repeatBudget as bigint }),
          /repeatBudget must be an unsigned 64-bit bigint/,
        );
        assert.equal(cpu.readState().rip, 0x1000n);
      }
    }
  } finally {
    cpu.dispose();
  }
});

test('pending and disposed runs reject before invoking any option getter', async () => {
  const { cpu } = await fixture([{ reason: 'budget', remaining: 0n, repeatRemaining: 1n }]);
  const pending = cpu.run({ budget: 1n });
  let reads = 0;
  const input = {
    get budget() {
      reads++;
      return 0n;
    },
  };
  await assert.rejects(cpu.run(input), /running/);
  assert.equal(reads, 0);
  await pending;
  cpu.dispose();
  await assert.rejects(cpu.run(input), /disposed/);
  assert.equal(reads, 0);
});

test('a nested run started by an option getter retains its effects and rejects the outer run', async () => {
  const { cpu } = await fixture([{ reason: 'budget', remaining: 0n, repeatRemaining: 9n }]);
  let nested: ReturnType<Cpu['run']> | undefined;
  try {
    await assert.rejects(
      cpu.run({
        budget: 3n,
        get repeatBudget() {
          nested = cpu.run({ budget: 1n, repeatBudget: 9n });
          return 5n;
        },
      }),
      /running/,
    );
    assert.ok(nested);
    assert.equal((await nested).retired, 1n);
    assert.equal(cpu.readState().rip, 0x1000n);
  } finally {
    await nested;
    cpu.dispose();
  }
});

test('disposal from a run option getter rejects the outer run before core access', async () => {
  const { cpu } = await fixture();
  await assert.rejects(
    cpu.run({
      budget: 0n,
      get stop() {
        cpu.dispose();
        return undefined;
      },
    }),
    /disposed/,
  );
  assert.doesNotThrow(() => cpu.dispose());
});

test('repetition-only progress survives internal dispatch without refilling either allowance', async () => {
  const { cpu, entries } = await fixture([
    { reason: 'dispatch', remaining: 3n, repeatRemaining: 2n },
    { reason: 'repeat-budget', remaining: 3n, repeatRemaining: 0n },
  ]);
  try {
    const result = await cpu.run({ budget: 3n, repeatBudget: 5n });
    assert.equal(result.reason, 'repeat-budget');
    assert.equal(result.retired, 0n);
    assert.equal(result.remaining, 3n);
    assert.equal(result.repeatIterations, 5n);
    assert.equal(result.remainingRepeatBudget, 0n);
    assert.equal(result.fault, undefined);
    assert.equal(result.segmentFault, undefined);
    assert.deepEqual(entries, [
      { budget: 3n, repeatBudget: 5n },
      { budget: 3n, repeatBudget: 2n },
    ]);
  } finally {
    cpu.dispose();
  }
});

test('full-width allowances remain separate and allow ordinary retirement with zero repeat allowance', async () => {
  const maximum = (1n << 64n) - 1n;
  const { cpu, entries } = await fixture([
    { reason: 'dispatch', remaining: maximum, repeatRemaining: 0n },
    { reason: 'stop', remaining: maximum - 1n, repeatRemaining: 0n },
  ]);
  try {
    const result = await cpu.run({ budget: maximum, repeatBudget: maximum });
    assert.equal(result.retired, 1n);
    assert.equal(result.remaining, maximum - 1n);
    assert.equal(result.repeatIterations, maximum);
    assert.equal(result.remainingRepeatBudget, 0n);
    assert.deepEqual(entries, [
      { budget: maximum, repeatBudget: maximum },
      { budget: maximum, repeatBudget: 0n },
    ]);
  } finally {
    cpu.dispose();
  }
});

for (const [name, steps] of Object.entries({
  'increased instruction allowance': [{ reason: 'stop', remaining: 4n, repeatRemaining: 5n }],
  'increased repetition allowance': [{ reason: 'stop', remaining: 3n, repeatRemaining: 6n }],
  'stalled initial dispatch': [{ reason: 'dispatch', remaining: 3n, repeatRemaining: 5n }],
  'stalled dispatch after prior repetition progress': [
    { reason: 'dispatch', remaining: 3n, repeatRemaining: 4n },
    { reason: 'dispatch', remaining: 3n, repeatRemaining: 4n },
  ],
  'budget exit with instruction allowance': [
    { reason: 'budget', remaining: 1n, repeatRemaining: 0n },
  ],
  'repeat-budget exit with repetition allowance': [
    { reason: 'repeat-budget', remaining: 3n, repeatRemaining: 1n },
  ],
  'repeat-budget exit without instruction allowance': [
    { reason: 'repeat-budget', remaining: 0n, repeatRemaining: 0n },
  ],
})) {
  test(`native progress rejects ${name}`, async () => {
    const { cpu } = await fixture(steps);
    try {
      await assert.rejects(cpu.run({ budget: 3n, repeatBudget: 5n }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.cause instanceof Error);
        assert.match(error.cause.message, /progress contract/);
        return true;
      });
      await assert.rejects(cpu.run({ budget: 0n }), /cpu is failed/);
    } finally {
      cpu.dispose();
    }
  });
}

test('pending and failed CPUs reject XMM access before capturing user inputs', async () => {
  const { cpu } = await fixture([{ reason: 'budget', remaining: 0n, repeatRemaining: 0n }]);
  cpu.setXmmState(Array<bigint>(16).fill(17n));
  const bank = new Proxy(Array<bigint>(16).fill(3n), {
    get() {
      return assert.fail('must not capture busy or failed CPU input');
    },
  });
  const pending = cpu.run({ budget: 1n });
  assert.throws(() => cpu.setXmmState(bank), /running/);
  assert.throws(() => cpu.readXmmState(), /running/);
  await pending;
  assert.deepEqual(cpu.readXmmState(), Array<bigint>(16).fill(17n));
  cpu.dispose();
  const failed = await fixture([{ reason: 'budget', remaining: 1n, repeatRemaining: 0n }]);
  await assert.rejects(failed.cpu.run({ budget: 1n }), /engine failed/);
  assert.throws(() => failed.cpu.setXmmState(bank), /failed/);
  assert.throws(() => failed.cpu.readXmmState(), /failed/);
  failed.cpu.dispose();
});

test('a run started by an XMM getter rejects outer publication while retaining completed effects', async () => {
  const { cpu } = await fixture([{ reason: 'budget', remaining: 0n, repeatRemaining: 0n }]);
  cpu.setXmmState(Array<bigint>(16).fill(5n));
  let pending: Promise<unknown> | undefined;
  const bank = Array<bigint>(16).fill(9n);
  Object.defineProperty(bank, 0, {
    get() {
      pending = cpu.run({ budget: 1n });
      return 9n;
    },
  });
  assert.throws(() => cpu.setXmmState(bank), /running/);
  assert.ok(pending);
  await pending;
  assert.deepEqual(cpu.readXmmState(), Array<bigint>(16).fill(5n));
  cpu.dispose();
});
