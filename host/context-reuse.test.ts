import assert from 'node:assert/strict';
import test from 'node:test';
import { Core, type GeneratedRun, type State } from './core.js';
import { createCpu } from './cpu.js';

const PC = 0x1000n;
const state = (): State => ({ registers: Array<bigint>(16).fill(0n), flags: 2n, rip: PC });

async function fixture(translations = 8) {
  let context = 0n,
    epoch = 0n,
    observed = false,
    owner = 0n;
  let current = { rip: PC, remaining: 0n, repeatRemaining: 0n };
  let output = 0n;
  const records = new Map<
    bigint,
    { context: bigint; epoch: bigint; observed: boolean; alive: boolean; published: boolean }
  >();
  const runs = new Map<GeneratedRun, bigint>();
  const calls = {
    activations: [] as bigint[],
    releases: [] as bigint[],
    publications: [] as bigint[],
    invocations: [] as bigint[],
    probes: [] as bigint[],
  };
  let onActivate: ((id: bigint) => void) | undefined;
  let onInstantiate: (() => void) | undefined;
  let onExecute: (() => void) | undefined;
  let probe: (pc: bigint) => string = () => 'dispatch';
  function change(next: bigint) {
    if (context === next) return;
    context = next;
    epoch++;
    for (const record of records.values()) if (!record.published) record.alive = false;
  }
  const engine = {
    current: () => current,
    snapshot: () => ({
      ...state(),
      registers: [output, ...Array<bigint>(15).fill(0n)],
      rip: current.rip,
      interruptibility: { sti: false, ss: false },
      event: { kind: 'ready' },
      interrupts: { irq: null, nmiPending: false, nmiBlocked: false },
    }),
    setState(input: State) {
      current = { ...current, rip: input.rip };
    },
    setContext(input: { segments: { fs: { base: bigint } } }) {
      change(input.segments.fs.base);
    },
    prepareEntry: () => observed,
    eventKind: () => 'ready',
    hasQueuedInterrupts: () => false,
    contextVersion: () => epoch,
    boundaryObserved: () => observed,
    stageException: () => false,
    fault: () => undefined,
    segmentFault: () => undefined,
    alignmentFault: () => undefined,
    pageFault: (reason: string) =>
      reason === 'page-fault'
        ? {
            instructionPc: current.rip,
            vector: 14,
            address: current.rip,
            access: 'execute',
            errorCode: 16,
          }
        : undefined,
    probe(pc: bigint) {
      calls.probes.push(pc);
      return probe(pc);
    },
    compile(pc: bigint) {
      owner++;
      records.set(owner, { context, epoch, observed, alive: true, published: false });
      return {
        bytes: Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0),
        metadata: {
          entries: [pc, pc + 1n],
          owner,
          contextVersion: epoch,
          boundaryObserved: observed,
          byteLength: 8,
          instructionCount: 2,
          blockCount: 1,
          sourceBytes: 2,
          dependencies: [],
        },
      };
    },
    instantiate() {
      onInstantiate?.();
      const run = () => 0;
      runs.set(run, owner);
      return run;
    },
    publish(id: bigint) {
      calls.publications.push(id);
      const record = records.get(id);
      if (
        !record?.alive ||
        record.epoch !== epoch ||
        record.context !== context ||
        record.observed !== observed
      )
        return false;
      record.published = true;
      return true;
    },
    valid: (id: bigint) => records.get(id)?.alive ?? false,
    activate(id: bigint) {
      calls.activations.push(id);
      onActivate?.(id);
      const record = records.get(id);
      return (
        record?.alive &&
        record.published &&
        record.context === context &&
        record.observed === observed
      );
    },
    execute(
      run: GeneratedRun,
      _index: number,
      budget: bigint,
      _stop: unknown,
      repeatBudget: bigint,
    ) {
      const id = runs.get(run)!;
      calls.invocations.push(id);
      output = records.get(id)!.context;
      current = { rip: current.rip + 1n, remaining: budget - 1n, repeatRemaining: repeatBudget };
      onExecute?.();
      return budget === 1n ? 'budget' : 'dispatch';
    },
    release(id: bigint) {
      calls.releases.push(id);
      records.delete(id);
    },
    dispose() {},
  };
  const create = Core.create;
  Core.create = async () => engine as unknown as Core;
  try {
    const cpu = await createCpu({
      compiler: new Uint8Array(),
      code: { base: PC, bytes: Uint8Array.of(0x90, 0x90) },
      ram: { base: 0x8000n, bytes: new Uint8Array(8) },
      limits: {
        maxInstructions: 8,
        maxSourceBytes: 32,
        maxArtifactBytes: 65536,
        maxCachedArtifacts: 4,
        maxCachedBytes: 1024,
        maxTranslationsPerRun: translations,
      },
    });
    return {
      cpu,
      calls,
      records,
      change,
      owner: () => owner,
      onActivate: (hook?: (id: bigint) => void) => {
        onActivate = hook;
      },
      onInstantiate: (hook?: () => void) => {
        onInstantiate = hook;
      },
      onExecute: (hook?: () => void) => {
        onExecute = hook;
      },
      probe: (hook: (pc: bigint) => string) => {
        probe = hook;
      },
      observe: (value: boolean) => {
        observed = value;
      },
    };
  } finally {
    Core.create = create;
  }
}

test('host publishes cold owners once and reuses admitted A B A candidates without epoch-key eviction', async () => {
  const f = await fixture();
  try {
    f.cpu.setState(state());
    await f.cpu.run({ budget: 1n });
    assert.deepEqual(f.calls.publications, [1n], 'cold browser artifact must pass publication');
    f.cpu.setContext({ mode: 'long64', fsBase: 1n, gsBase: 0n });
    f.cpu.setState(state());
    const b = await f.cpu.run({ budget: 1n });
    assert.equal(b.state.registers[0], 1n, 'incompatible A module cannot run');
    assert.equal(b.resources.cacheHits, 0);
    f.cpu.setContext({ mode: 'long64', fsBase: 0n, gsBase: 0n });
    f.cpu.setState(state());
    const a = await f.cpu.run({ budget: 1n });
    assert.equal(a.state.registers[0], 0n);
    assert.equal(a.resources.compilations, 0);
    assert.equal(a.resources.cacheHits, 1);
    assert.equal(a.resources.nativeEntries, 1);
    assert.deepEqual(f.calls.invocations, [1n, 2n, 1n]);
    assert.deepEqual(f.calls.releases, []);
  } finally {
    f.cpu.dispose();
  }
});

test('a published first-entry refusal leaves its installed live owner dormant for a later return', async () => {
  const f = await fixture();
  try {
    let changed = false;
    f.onActivate(() => {
      if (!changed) {
        changed = true;
        f.change(1n);
      }
    });
    f.cpu.setState(state());
    const b = await f.cpu.run({ budget: 1n });
    assert.equal(b.state.registers[0], 1n, 'refused A never executes');
    assert.equal(b.resources.compilations, 2);
    assert.equal(b.resources.cacheHits, 0);
    assert.equal(b.resources.nativeEntries, 1);
    assert.deepEqual(f.calls.invocations, [2n]);
    assert.deepEqual(f.calls.releases, []);
    f.change(0n);
    f.cpu.setState(state());
    const a = await f.cpu.run({ budget: 1n });
    assert.equal(a.resources.compilations, 0);
    assert.equal(a.resources.cacheHits, 1);
    assert.deepEqual(f.calls.invocations, [2n, 1n]);
  } finally {
    f.cpu.dispose();
  }
});

test('dead refused candidates release once without hiding an older eligible middle entry', async () => {
  const f = await fixture();
  try {
    f.cpu.setState(state());
    await f.cpu.run({ budget: 1n });
    f.change(1n);
    f.cpu.setState(state());
    await f.cpu.run({ budget: 1n });
    f.change(0n);
    f.cpu.setState({ ...state(), rip: PC + 1n });
    f.onActivate((id) => {
      if (id === 2n) f.records.get(id)!.alive = false;
    });
    const result = await f.cpu.run({ budget: 1n });
    assert.equal(result.resources.compilations, 0);
    assert.equal(result.resources.cacheHits, 1);
    assert.equal(result.resources.nativeEntries, 1);
    assert.deepEqual(f.calls.releases, [2n]);
    assert.deepEqual(f.calls.invocations, [1n, 2n, 1n]);
  } finally {
    f.cpu.dispose();
  }
});

test('admission churn exhausts its private restart cap without a probe or fabricated work counter', async () => {
  const f = await fixture(1);
  try {
    f.cpu.setState(state());
    await f.cpu.run({ budget: 1n });
    f.change(1n);
    f.cpu.setState(state());
    await f.cpu.run({ budget: 1n });
    f.onActivate((id) => f.change(f.records.get(id)!.context === 0n ? 1n : 0n));
    f.calls.activations.length = 0;
    f.calls.probes.length = 0;
    f.calls.invocations.length = 0;
    f.cpu.setState(state());
    const result = await f.cpu.run({ budget: 1n });
    assert.equal(result.reason, 'resource-limit');
    assert.equal(result.retired, 0n);
    assert.equal(result.remaining, 1n);
    assert.equal(result.resources.compilations, 0);
    assert.equal(result.resources.cacheHits, 0);
    assert.equal(result.resources.nativeEntries, 0);
    assert.equal(result.resources.pagingRestarts, undefined);
    assert.deepEqual(f.calls.invocations, []);
    assert.deepEqual(f.calls.probes, [], 'exhausted restart stops before next miss probe');
    assert.equal(f.calls.activations.length, 4, 'initial scan and one permitted restarted scan');
  } finally {
    f.cpu.dispose();
  }
});

test('a refused dormant candidate cannot hide a required fault after the real compile quota is used', async () => {
  const f = await fixture(1);
  try {
    f.probe((pc) => (pc === PC ? 'dispatch' : 'page-fault'));
    f.onExecute(() => f.change(1n));
    f.cpu.setState(state());
    const result = await f.cpu.run({ budget: 2n });
    assert.equal(result.reason, 'page-fault');
    assert.equal(result.retired, 1n);
    assert.equal(result.resources.compilations, 1);
    assert.equal(result.resources.cacheHits, 0);
    assert.equal(result.resources.nativeEntries, 1);
    assert.equal(result.pageFault?.instructionPc, PC + 1n);
    assert.deepEqual(f.calls.probes, [PC, PC + 1n]);
  } finally {
    f.cpu.dispose();
  }
});

test('the atomic publication gate rejects context ABA during browser instantiation and releases only temporary owners', async () => {
  const f = await fixture();
  try {
    let changed = false;
    f.onInstantiate(() => {
      if (!changed) {
        changed = true;
        f.change(1n);
        f.change(0n);
      }
    });
    f.cpu.setState(state());
    const result = await f.cpu.run({ budget: 1n });
    assert.equal(result.reason, 'budget');
    assert.equal(result.resources.compilations, 2);
    assert.equal(result.resources.nativeEntries, 1);
    assert.deepEqual(f.calls.publications, [1n, 2n]);
    assert.deepEqual(f.calls.releases, [1n]);
    assert.deepEqual(f.calls.invocations, [2n]);
  } finally {
    f.cpu.dispose();
  }
});

test('a profile change during rejected admission restarts with the current observed variant', async () => {
  const f = await fixture();
  try {
    f.cpu.setState(state());
    await f.cpu.run({ budget: 1n });
    f.observe(true);
    f.cpu.setState(state());
    await f.cpu.run({ budget: 1n });
    f.observe(false);
    let changed = false;
    f.onActivate(() => {
      if (!changed) {
        changed = true;
        f.observe(true);
      }
    });
    f.cpu.setState(state());
    const result = await f.cpu.run({ budget: 1n });
    assert.equal(result.resources.compilations, 0);
    assert.equal(result.resources.cacheHits, 1);
    assert.equal(result.resources.nativeEntries, 1);
    assert.deepEqual(f.calls.invocations, [1n, 2n, 2n]);
    assert.deepEqual(f.calls.releases, []);
  } finally {
    f.cpu.dispose();
  }
});

test('a valid run-option getter context import selects the resulting context and keeps inherited admission rules', async () => {
  const f = await fixture();
  try {
    f.cpu.setState(state());
    await f.cpu.run({ budget: 1n });
    f.change(1n);
    f.cpu.setState(state());
    await f.cpu.run({ budget: 1n });
    f.change(0n);
    f.cpu.setState(state());
    const result = await f.cpu.run({
      get budget() {
        f.cpu.setContext({ mode: 'long64', fsBase: 1n, gsBase: 0n });
        return 1n;
      },
    });
    assert.equal(result.state.registers[0], 1n);
    assert.equal(result.resources.compilations, 0);
    assert.equal(result.resources.cacheHits, 1);
    assert.deepEqual(f.calls.invocations, [1n, 2n, 2n]);
  } finally {
    f.cpu.dispose();
  }
});
