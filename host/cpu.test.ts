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

type Step = { reason: string; remaining: bigint; repeatRemaining: bigint; rip?: bigint };

async function fixture(steps: Step[] = []) {
  let current = { rip: 0x1000n, remaining: 0n, repeatRemaining: 0n };
  let xmm = Array<bigint>(16).fill(0n);
  const entries: { budget: bigint; repeatBudget: bigint | undefined }[] = [];
  const stateImports: unknown[] = [];
  const engine = {
    current: () => current,
    snapshot: () => ({ registers: Array<bigint>(16).fill(0n), flags: 2n, rip: current.rip }),
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
        byteLength: 8,
        instructionCount: 1,
        blockCount: 1,
        sourceBytes: 1,
        dependencies: [],
      },
    }),
    contextVersion: () => 0n,
    valid: () => true,
    instantiate: () => () => 0,
    activate() {},
    release() {},
    execute(_run: unknown, _index: number, budget: bigint, _stop: unknown, repeatBudget?: bigint) {
      entries.push({ budget, repeatBudget });
      const step = steps.shift();
      assert.ok(step, 'unexpected native entry');
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
    return { cpu, entries, stateImports };
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
