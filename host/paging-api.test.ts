import assert from 'node:assert/strict';
import test from 'node:test';
import { Core } from './core.js';
import { createCpu, type Options } from './cpu.js';
import type { PagingState } from './paging.js';
import { longSnapshot, protectedSnapshot } from '../tests/support/context.js';

const limits = {
  maxInstructions: 32,
  maxSourceBytes: 256,
  maxArtifactBytes: 65536,
  maxCachedArtifacts: 8,
  maxCachedBytes: 1048576,
  maxTranslationsPerRun: 8,
};
const bank = (): PagingState => ({
  cr0: 0x80010033n,
  cr2: 0n,
  cr3: 0x1000n,
  cr4: 0x628n,
  efer: 0xd00n,
});

async function fixture(
  memoryModel: 'linear' | 'ia32e-paged' = 'ia32e-paged',
  transform?: (options: Options) => Options,
) {
  let paging = bank();
  let context = longSnapshot();
  const imports: PagingState[] = [];
  const contextImports: unknown[] = [];
  const writes: { address: bigint; bytes: Uint8Array }[] = [];
  const maps: unknown[] = [];
  const engine = {
    isPaged: memoryModel === 'ia32e-paged',
    readPagingState: () => ({ ...paging }),
    setPagingState(input: PagingState) {
      if (input.cr0 !== 0x80010033n) throw new TypeError('invalid normalized paging profile');
      imports.push(input);
      paging = { ...input };
    },
    readContext: () => structuredClone(context),
    setContext(input: ReturnType<typeof longSnapshot>) {
      contextImports.push(input);
      context = structuredClone(input);
    },
    readMemory: () => Uint8Array.of(0x90, 2),
    writeOwnedMemory(address: bigint, bytes: Uint8Array) {
      writes.push({ address, bytes });
    },
    setMappings(input: unknown) {
      maps.push(input);
    },
    current: () => ({ rip: 0x1000n, remaining: 0n, repeatRemaining: 0n }),
    snapshot: () => ({
      registers: Array<bigint>(16).fill(0n),
      flags: 2n,
      rip: 0x1000n,
      interruptibility: { sti: false, ss: false },
      event: { kind: 'ready' },
      interrupts: { irq: null, nmiPending: false, nmiBlocked: false },
    }),
    eventKind: () => 'ready',
    hasQueuedInterrupts: () => false,
    prepareEntry: () => false,
    fault: () => undefined,
    segmentFault: () => undefined,
    alignmentFault: () => undefined,
    valid: () => true,
    release() {},
    releaseIo() {},
    dispose() {},
  };
  const original = Core.create;
  Core.create = async (_compiler, memory) => {
    paging = { ...(memory.paging ?? paging) };
    return engine as unknown as Core;
  };
  try {
    const memory = {
      backings: [{ id: 'ram', bytes: Uint8Array.of(0x90, 2) }],
      mappings: [
        {
          base: 0x1000n,
          backing: 'ram',
          offset: 0,
          length: 2,
          permissions: { read: true, write: true, execute: true },
        },
      ],
    };
    const common = {
      compiler: new Uint8Array(),
      memory,
      entry: 0x1000n,
      memoryLimits: { maxBackings: 2, maxBackingBytes: 16, maxMappings: 2 },
      limits,
    };
    const options: Options =
      memoryModel === 'ia32e-paged' ? { ...common, memoryModel, paging: bank() } : common;
    const cpu = await createCpu(transform ? transform(options) : options);
    return { cpu, imports, contextImports, writes, maps };
  } finally {
    Core.create = original;
  }
}

test('constructor owns one captured model and paging bank before later option getters', async () => {
  const source = bank();
  const reads = new Map<PropertyKey, number>();
  const paging = new Proxy(source, {
    get(target, key, receiver) {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return Reflect.get(target, key, receiver) as unknown;
    },
  });
  let models = 0,
    banks = 0;
  const f = await fixture('ia32e-paged', (options) => {
    if (options.memoryModel !== 'ia32e-paged') assert.fail('expected paged fixture');
    return {
      ...options,
      get memoryModel() {
        models++;
        return 'ia32e-paged' as const;
      },
      get paging() {
        banks++;
        return paging;
      },
      get context() {
        source.cr3 = 0x2000n;
        return longSnapshot();
      },
    };
  });
  try {
    assert.equal(models, 1);
    assert.equal(banks, 1);
    assert.deepEqual(
      [...reads],
      ['cr0', 'cr2', 'cr3', 'cr4', 'efer'].map((key) => [key, 1]),
    );
    assert.equal(f.cpu.readPagingState().cr3, 0x1000n);
  } finally {
    f.cpu.dispose();
  }
});

test('paging API captures once, detaches reads and preserves a nested successful repair on rejection', async () => {
  const f = await fixture();
  try {
    const observed = f.cpu.readPagingState();
    observed.cr3 = 0xdeadn;
    assert.deepEqual(f.cpu.readPagingState(), bank());
    let reads = 0;
    f.cpu.setPagingState({
      ...bank(),
      get cr3() {
        reads++;
        return 0x2000n;
      },
    });
    assert.equal(reads, 1);
    assert.equal(f.cpu.readPagingState().cr3, 0x2000n);
    assert.throws(
      () =>
        f.cpu.setPagingState({
          ...bank(),
          cr0: 0n,
          get efer() {
            f.cpu.setPagingState({ ...bank(), cr2: 0x800000000000n });
            return 0xd00n;
          },
        }),
      TypeError,
    );
    assert.deepEqual(f.cpu.readPagingState(), { ...bank(), cr2: 0x800000000000n });
    assert.equal(f.imports.length, 2);
  } finally {
    f.cpu.dispose();
  }
});

test('a completed nested run or disposal during paging capture cannot publish an outer bank', async () => {
  for (const action of ['run', 'dispose'] as const) {
    const f = await fixture();
    let nested: Promise<unknown> | undefined;
    try {
      assert.throws(
        () =>
          f.cpu.setPagingState({
            ...bank(),
            get cr2() {
              if (action === 'run') nested = f.cpu.run({ budget: 0n });
              else f.cpu.dispose();
              return 0n;
            },
          }),
        action === 'run' ? /run.*capture/ : /disposed/,
      );
      await nested;
      assert.deepEqual(f.imports, []);
    } finally {
      f.cpu.dispose();
    }
  }
});

test('memory APIs use the immutable constructor plane and own physical write bytes', async () => {
  for (const model of ['linear', 'ia32e-paged'] as const) {
    const f = await fixture(model);
    const address = model === 'linear' ? 0x1000n : 0x800000000000n;
    const bytes = Uint8Array.of(7, 8);
    try {
      if (model === 'linear') {
        assert.deepEqual(f.cpu.readMemory(address, 2), Uint8Array.of(0x90, 2));
        assert.throws(() => f.cpu.readPagingState(), TypeError);
        assert.throws(() => f.cpu.setPagingState(bank()), TypeError);
        assert.throws(() => f.cpu.readPhysicalMemory(address, 2), TypeError);
        assert.throws(() => f.cpu.writePhysicalMemory(address, bytes), TypeError);
      } else {
        assert.deepEqual(f.cpu.readPhysicalMemory(address, 2), Uint8Array.of(0x90, 2));
        assert.throws(() => f.cpu.readMemory(address, 2), TypeError);
        assert.throws(() => f.cpu.writeMemory(address, bytes), TypeError);
        f.cpu.writePhysicalMemory(address, bytes);
        bytes[0] = 9;
        assert.deepEqual(f.writes, [{ address, bytes: Uint8Array.of(7, 8) }]);
      }
      const mapping = {
        base: address,
        backing: 'ram',
        offset: 0,
        length: 2,
        permissions: { read: true, write: true, execute: false },
      };
      f.cpu.setMappings([mapping]);
      assert.deepEqual(f.maps, [[mapping]]);
    } finally {
      f.cpu.dispose();
    }
  }
});

test('paged context rejection precedes the engine cancellation boundary', async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.cpu.setContext(protectedSnapshot()), TypeError);
    assert.deepEqual(f.contextImports, []);
    const compatibility = { ...longSnapshot(), mode: 'compatibility' as const };
    compatibility.segments.cs.long = false;
    compatibility.segments.cs.default32 = true;
    f.cpu.setContext(compatibility);
    assert.equal(f.cpu.readContext().mode, 'compatibility');
    assert.deepEqual(f.cpu.readPagingState(), bank());
  } finally {
    f.cpu.dispose();
  }
});

test('context and mapping getters preserve inherited completed-run publication ordering', async () => {
  for (const projection of ['context', 'mappings'] as const) {
    const f = await fixture();
    let nested: Promise<unknown> | undefined;
    try {
      if (projection === 'context') {
        const input = longSnapshot();
        Object.defineProperty(input, 'mode', {
          get() {
            nested = f.cpu.run({ budget: 0n });
            return 'long64';
          },
        });
        f.cpu.setContext(input);
        assert.deepEqual(f.contextImports, [longSnapshot()]);
      } else {
        f.cpu.setMappings([
          {
            get base() {
              nested = f.cpu.run({ budget: 0n });
              return 0x800000000000n;
            },
            backing: 'ram',
            offset: 0,
            length: 2,
            permissions: { read: true, write: true, execute: false },
          },
        ]);
        assert.equal(f.maps.length, 1);
      }
      await nested;
    } finally {
      f.cpu.dispose();
    }
  }
});
