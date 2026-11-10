import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createCpu, type Options, type RunResult } from '../../host/index.js';
import type { State } from '../../host/index.js';

const compiler = await WebAssembly.compile(
  new Uint8Array(await readFile(new URL('../../build/ring64.wasm', import.meta.url))),
);
const CODE = 0x1000n;
const RAM = 0x8000n;
const limits = {
  maxInstructions: 32,
  maxSourceBytes: 256,
  maxArtifactBytes: 65536,
  maxCachedArtifacts: 8,
  maxCachedBytes: 1048576,
  maxTranslationsPerRun: 8,
};

function options(): Options & {
  code: { base: bigint; bytes: Uint8Array };
  ram: { base: bigint; bytes: Uint8Array };
} {
  return {
    compiler,
    code: { base: CODE, bytes: Uint8Array.of(0xb8, 1, 0, 0, 0, 0xb9, 2, 0, 0, 0) },
    ram: { base: RAM, bytes: Uint8Array.of(1, 2, 3, 4) },
    limits,
  };
}

function state(): State {
  return {
    registers: Array.from({ length: 16 }, (_, index) => BigInt(index + 3)),
    flags: 2n,
    rip: CODE,
    interruptibility: { sti: false, ss: false },
    event: { kind: 'ready' },
    interrupts: { irq: null, nmiPending: false, nmiBlocked: false },
  };
}

for (const span of ['code', 'ram'] as const) {
  for (const field of ['base', 'bytes'] as const) {
    test(`creation captures ${span}.${field} once before validation and execution`, async () => {
      const input = options();
      const original = input[span][field];
      let reads = 0;
      Object.defineProperty(input[span], field, {
        get() {
          reads++;
          if (reads === 1) return original;
          return field === 'base' ? (1n << 64n) + CODE : Uint8Array.of(0xb8, 9, 0, 0, 0);
        },
      });
      const cpu = await createCpu(input);
      try {
        assert.equal(reads, 1);
        assert.equal(cpu.readState().rip, CODE);
        assert.deepEqual(cpu.readMemory(RAM, 4), Uint8Array.of(1, 2, 3, 4));
        const result = await cpu.run({ budget: 1n });
        assert.equal(result.reason, 'budget');
        assert.equal(result.retired, 1n);
        assert.equal(result.state.registers[0], 1n);
        assert.equal(result.state.rip, CODE + 5n);
      } finally {
        cpu.dispose();
      }
    });
  }

  test(`creation rejects the captured out-of-range ${span} base`, async () => {
    for (const invalid of [-1n, 1n << 64n]) {
      const input = options();
      let reads = 0;
      Object.defineProperty(input[span], 'base', {
        get() {
          return ++reads === 1 ? invalid : CODE;
        },
      });
      await assert.rejects(createCpu(input), /unsigned 64-bit bigint/);
      assert.equal(reads, 1);
    }
  });
}

for (const field of ['registers', 'flags', 'rip'] as const) {
  test(`state import captures ${field} once and executes from that value`, async () => {
    const cpu = await createCpu(options());
    const input = state();
    const expected = state();
    const original = input[field];
    let reads = 0;
    Object.defineProperty(input, field, {
      get() {
        reads++;
        if (reads === 1) return original;
        return field === 'registers' ? Array(16).fill(99n) : (1n << 64n) + 2n;
      },
    });
    try {
      cpu.setState(input);
      assert.equal(reads, 1);
      assert.deepEqual(cpu.readState(), expected);
      const result = await cpu.run({ budget: 1n });
      expected.registers[0] = 1n;
      expected.rip = CODE + 5n;
      assert.equal(result.reason, 'budget');
      assert.equal(result.retired, 1n);
      assert.deepEqual(result.state, expected);
    } finally {
      cpu.dispose();
    }
  });
}

test('state import captures each indexed bank once without using caller array methods', async () => {
  const cpu = await createCpu(options());
  try {
    for (const method of ['iterator', 'forEach', 'getters'] as const) {
      const input = state();
      const expected = state();
      const reads = Array(16).fill(0) as number[];
      if (method === 'iterator') {
        input.registers[Symbol.iterator] = () => {
          throw new Error('caller iterator must not run');
        };
      } else if (method === 'forEach') {
        input.registers.forEach = () => {
          throw new Error('caller forEach must not run');
        };
      } else {
        for (let index = 0; index < 16; index++) {
          Object.defineProperty(input.registers, index, {
            get() {
              reads[index] = reads[index]! + 1;
              return reads[index] === 1 ? expected.registers[index] : 1n << 64n;
            },
          });
        }
      }
      cpu.setState(input);
      assert.deepEqual(cpu.readState(), expected);
      if (method === 'getters') assert.deepEqual(reads, Array(16).fill(1));
      const result = await cpu.run({ budget: 1n });
      expected.registers[0] = 1n;
      expected.rip = CODE + 5n;
      assert.deepEqual(result.state, expected);
    }
  } finally {
    cpu.dispose();
  }
});

test('invalid captured state values reject before changing the imported state', async () => {
  const cpu = await createCpu(options());
  const original = state();
  cpu.setState(original);
  try {
    for (const field of ['register', 'flags', 'rip'] as const) {
      for (const invalid of [-1n, 1n << 64n]) {
        const input = state();
        let reads = 0;
        const getter = () => (++reads === 1 ? invalid : 2n);
        Object.defineProperty(
          field === 'register' ? input.registers : input,
          field === 'register' ? 7 : field,
          { get: getter },
        );
        assert.throws(() => cpu.setState(input), /unsigned 64-bit bigint/);
        assert.equal(reads, 1);
        assert.deepEqual(cpu.readState(), original);
      }
    }
    const result = await cpu.run({ budget: 1n });
    assert.equal(result.reason, 'budget');
    assert.equal(result.retired, 1n);
  } finally {
    cpu.dispose();
  }
});

test('a run started by a state getter keeps its original input and rejects the overlapping import', async () => {
  const cpu = await createCpu(options());
  const original = state();
  cpu.setState(original);
  let pending: Promise<RunResult> | undefined;
  const input = state();
  input.rip = CODE + 5n;
  Object.defineProperty(input, 'flags', {
    get() {
      pending ??= cpu.run({ budget: 1n });
      assert.throws(() => cpu.readState(), /running/);
      assert.throws(() => cpu.readMemory(RAM, 4), /running/);
      assert.throws(() => cpu.writeMemory(RAM, Uint8Array.of(9)), /running/);
      assert.throws(() => cpu.dispose(), /running/);
      return 2n;
    },
  });
  try {
    assert.throws(() => cpu.setState(input), /running/);
    assert.ok(pending);
    const result = await pending;
    const expected = state();
    expected.registers[0] = 1n;
    expected.rip = CODE + 5n;
    assert.equal(result.reason, 'budget');
    assert.equal(result.retired, 1n);
    assert.deepEqual(result.state, expected);
    assert.deepEqual(cpu.readMemory(RAM, 4), Uint8Array.of(1, 2, 3, 4));
  } finally {
    await pending;
    cpu.dispose();
  }
});

test('disposal during state input acquisition rejects before touching the released core', async () => {
  const cpu = await createCpu(options());
  const input = state();
  Object.defineProperty(input, 'flags', {
    get() {
      cpu.dispose();
      return 2n;
    },
  });
  assert.throws(() => cpu.setState(input), /disposed/);
  assert.throws(() => cpu.readState(), /disposed/);
  assert.doesNotThrow(() => cpu.dispose());
});

test('state input getters can observe and write memory while the CPU remains idle', async () => {
  const cpu = await createCpu(options());
  const original = state();
  cpu.setState(original);
  const input = state();
  Object.defineProperty(input, 'flags', {
    get() {
      assert.deepEqual(cpu.readState(), original);
      cpu.writeMemory(RAM, Uint8Array.of(9, 8, 7, 6));
      return 2n;
    },
  });
  try {
    cpu.setState(input);
    assert.deepEqual(cpu.readState(), original);
    assert.deepEqual(cpu.readMemory(RAM, 4), Uint8Array.of(9, 8, 7, 6));
    assert.equal((await cpu.run({ budget: 1n })).reason, 'budget');
  } finally {
    cpu.dispose();
  }
});

test('a run started while copying a memory input rejects the overlapping write', async () => {
  const cpu = await createCpu(options());
  cpu.setState(state());
  let pending: Promise<RunResult> | undefined;
  const input = new Proxy(Uint8Array.of(9, 8, 7, 6), {
    get(target, property) {
      if (property === Symbol.iterator)
        return function* () {
          pending = cpu.run({ budget: 1n });
          yield* [9, 8, 7, 6];
        };
      return Reflect.get(target, property, target) as unknown;
    },
  });
  try {
    assert.throws(() => cpu.writeMemory(RAM, input), /running/);
    assert.ok(pending);
    const result = await pending;
    assert.equal(result.reason, 'budget');
    assert.equal(result.state.registers[0], 1n);
    assert.equal(result.state.rip, CODE + 5n);
    assert.deepEqual(cpu.readMemory(RAM, 4), Uint8Array.of(1, 2, 3, 4));
  } finally {
    await pending;
    cpu.dispose();
  }
});

test('run options capture each getter once before applying instruction and repetition limits', async () => {
  const cpu = await createCpu(options());
  const reads = { budget: 0, stop: 0, repeatBudget: 0 };
  try {
    const result = await cpu.run({
      get budget() {
        return ++reads.budget === 1 ? 1n : -1n;
      },
      get stop() {
        reads.stop++;
        return CODE + 5n;
      },
      get repeatBudget() {
        return ++reads.repeatBudget === 1 ? 0n : -1n;
      },
    });
    assert.deepEqual(reads, { budget: 1, stop: 1, repeatBudget: 1 });
    assert.equal(result.reason, 'budget');
    assert.equal(result.retired, 1n);
    assert.equal(result.repeatIterations, 0n);
    assert.equal(result.remainingRepeatBudget, 0n);
    assert.equal(result.state.rip, CODE + 5n);
  } finally {
    cpu.dispose();
  }
});

for (const field of ['budget', 'stop', 'repeatBudget'] as const) {
  test(`a nested run from the ${field} getter rejects the outer run without losing nested state`, async () => {
    const cpu = await createCpu(options());
    let pending: Promise<RunResult> | undefined;
    const input = { budget: 0n, stop: CODE + 5n, repeatBudget: 0n };
    Object.defineProperty(input, field, {
      get() {
        pending = cpu.run({ budget: 1n, repeatBudget: 0n });
        return field === 'stop' ? CODE + 5n : 0n;
      },
    });
    try {
      await assert.rejects(cpu.run(input), /running/);
      assert.ok(pending);
      const result = await pending;
      assert.equal(result.reason, 'budget');
      assert.equal(result.retired, 1n);
      assert.equal(result.state.registers[0], 1n);
      assert.equal(result.state.rip, CODE + 5n);
      assert.deepEqual(cpu.readState(), result.state);
    } finally {
      await pending;
      cpu.dispose();
    }
  });
}

test('invalid outer run input preserves successful nested state and memory writes', async () => {
  const cpu = await createCpu(options());
  const nestedState = state();
  nestedState.registers[7] = 0x1234n;
  try {
    await assert.rejects(
      cpu.run({
        budget: 0n,
        get repeatBudget() {
          cpu.setState(nestedState);
          cpu.writeMemory(RAM, Uint8Array.of(9, 8, 7, 6));
          return -1n;
        },
      }),
      /repeatBudget must be an unsigned 64-bit bigint/,
    );
    assert.deepEqual(cpu.readState(), nestedState);
    assert.deepEqual(cpu.readMemory(RAM, 4), Uint8Array.of(9, 8, 7, 6));
    assert.equal((await cpu.run({ budget: 1n, repeatBudget: 0n })).retired, 1n);
  } finally {
    cpu.dispose();
  }
});
