import {
  Core,
  captureState,
  copyMemoryInput,
  unsigned64,
  type CompileLimits,
  type Fault,
  type Span,
  type State,
} from './core.js';
import { Translations, type Artifact } from './translations.js';
import {
  backingName,
  captureBackings,
  captureInitialMemory,
  captureMappings,
  validateBackings,
  validateMappings,
  type MemoryBackingInput,
  type MemoryLimits,
  type MemoryMapping,
} from './memory.js';

export interface Limits extends CompileLimits {
  maxCachedArtifacts: number;
  maxCachedBytes: number;
  maxTranslationsPerRun: number;
}

interface CommonOptions {
  compiler: Uint8Array | WebAssembly.Module;
  limits: Limits;
}

export type Options = CommonOptions &
  (
    | { code: Span; ram: Span; memoryLimits?: MemoryLimits; memory?: never; entry?: never }
    | {
        memory: { backings: MemoryBackingInput[]; mappings: MemoryMapping[] };
        entry: bigint;
        memoryLimits: MemoryLimits;
        code?: never;
        ram?: never;
      }
  );

export interface RunResult {
  reason: string;
  retired: bigint;
  remaining: bigint;
  state: State;
  fault?: Fault;
  resources: {
    compilations: number;
    cacheHits: number;
    nativeEntries: number;
    dispatches: number;
    generatedBytes: number;
    cachedArtifacts: number;
    cachedBytes: number;
  };
  timings: {
    translationMs: number;
    browserCompileMs: number;
    instantiationMs: number;
    executionMs: number;
    totalMs: number;
  };
}

function checkedLimits(limits: Limits): Limits {
  const names = [
    'maxInstructions',
    'maxSourceBytes',
    'maxArtifactBytes',
    'maxCachedArtifacts',
    'maxCachedBytes',
    'maxTranslationsPerRun',
  ] as const;
  const result = { ...limits };
  for (const name of names) {
    const value = result[name];
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
      throw new TypeError(`${name} must be an explicit positive wasm32 integer`);
    }
  }
  return result;
}

const CONSTRUCTION = Symbol('createCpu');

export async function createCpu(options: Options): Promise<Cpu> {
  const began = performance.now();
  const limits = checkedLimits(options.limits);
  const memory = captureInitialMemory(options);
  const core = await Core.create(options.compiler, memory);
  return new Cpu(
    CONSTRUCTION,
    core,
    limits,
    performance.now() - began,
    memory.memoryLimits,
    new Map(memory.backings.map(({ id, bytes }) => [id, bytes.length])),
  );
}

export class Cpu {
  #lifecycle: 'idle' | 'running' | 'failed' | 'disposed' = 'idle';
  readonly #cache: Translations;
  #core: Core | undefined;
  readonly #limits: Limits;
  readonly #memoryLimits: MemoryLimits;
  #backings: Map<string, number>;

  constructor(
    token: typeof CONSTRUCTION,
    core: Core,
    limits: Limits,
    readonly creationMs: number,
    memoryLimits: MemoryLimits,
    backings: Map<string, number>,
  ) {
    if (token !== CONSTRUCTION) throw new TypeError('use the createCpu factory');
    this.#core = core;
    this.#limits = { ...limits };
    this.#memoryLimits = { ...memoryLimits };
    this.#backings = backings;
    this.#cache = new Translations(limits.maxCachedArtifacts, limits.maxCachedBytes, (artifact) =>
      this.#core?.release(artifact.metadata.owner),
    );
  }

  private requireIdle(): void {
    if (this.#lifecycle !== 'idle') throw new Error(`cpu is ${this.#lifecycle}`);
  }

  get #engine(): Core {
    if (!this.#core) throw new Error('cpu is disposed');
    return this.#core;
  }

  private pruneTranslations(): void {
    try {
      this.#cache.prune((artifact) => this.#engine.valid(artifact.metadata.owner));
    } catch (cause) {
      this.#lifecycle = 'failed';
      throw new Error('cpu engine failed', { cause });
    }
  }

  private mutate(action: () => void): void {
    try {
      action();
    } catch (cause) {
      if (cause instanceof TypeError || cause instanceof RangeError) throw cause;
      this.#lifecycle = 'failed';
      throw new Error('cpu engine failed', { cause });
    }
  }

  addBacking(input: MemoryBackingInput): void {
    this.requireIdle();
    const captured = captureBackings([input], this.#memoryLimits, this.#backings);
    this.requireIdle();
    const lengths = validateBackings(captured, this.#backings, this.#memoryLimits);
    this.mutate(() => this.#engine.addBacking(captured[0]!));
    this.#backings = lengths;
  }

  removeBacking(id: string): void {
    this.requireIdle();
    backingName(id);
    if (!this.#backings.has(id)) throw new TypeError('unknown backing name');
    this.mutate(() => this.#engine.removeBacking(id));
    this.#backings.delete(id);
  }

  setMappings(mappings: MemoryMapping[]): void {
    this.requireIdle();
    const captured = captureMappings(mappings, this.#memoryLimits);
    this.requireIdle();
    validateMappings(captured, this.#backings);
    this.mutate(() => this.#engine.setMappings(captured));
    this.pruneTranslations();
  }

  setState(state: State): void {
    this.requireIdle();
    const input = captureState(state);
    // Input accessors can start a run or dispose the CPU.
    this.requireIdle();
    this.#engine.setState(input);
  }
  readState(): State {
    this.requireIdle();
    return this.#engine.snapshot();
  }
  readMemory(address: bigint, length: number): Uint8Array {
    this.requireIdle();
    return this.#engine.readMemory(address, length);
  }
  writeMemory(address: bigint, bytes: Uint8Array): void {
    this.requireIdle();
    unsigned64(address, 'address');
    const input = copyMemoryInput(bytes);
    this.requireIdle();
    this.mutate(() => this.#engine.writeOwnedMemory(address, input));
    this.pruneTranslations();
  }
  inspectTranslations() {
    this.requireIdle();
    return this.#cache.inspect();
  }

  async run({ budget, stop }: { budget: bigint; stop?: bigint }): Promise<RunResult> {
    this.requireIdle();
    unsigned64(budget, 'budget');
    if (stop !== undefined) unsigned64(stop, 'stop');
    this.#lifecycle = 'running';
    const began = performance.now();
    const resources = {
      compilations: 0,
      cacheHits: 0,
      nativeEntries: 0,
      dispatches: 0,
      generatedBytes: 0,
    };
    const timings = {
      translationMs: 0,
      browserCompileMs: 0,
      instantiationMs: 0,
      executionMs: 0,
      totalMs: 0,
    };
    let remaining = budget;
    const finish = (reason: string): RunResult => {
      this.pruneTranslations();
      const fault = this.#engine.fault(reason);
      const result = {
        reason,
        retired: budget - remaining,
        remaining,
        state: this.#engine.snapshot(),
        ...(fault ? { fault } : {}),
        resources: { ...resources, ...this.#cache.resources() },
        timings,
      };
      timings.totalMs = performance.now() - began;
      return result;
    };
    try {
      this.#engine.clearFault();
      for (;;) {
        const pc = this.#engine.current().rip;
        if (remaining === 0n) return finish('budget');
        if (stop !== undefined && pc === stop) return finish('stop');
        let entry = this.#cache.get(pc);
        if (entry) {
          resources.cacheHits++;
        } else {
          const probe = this.#engine.probe(pc);
          if (probe !== 'dispatch') return finish(probe);
          if (resources.compilations >= this.#limits.maxTranslationsPerRun)
            return finish('resource-limit');
          resources.compilations++;
          let at = performance.now();
          const output = this.#engine.compile(pc, this.#limits);
          timings.translationMs += performance.now() - at;
          if (!output) return finish('resource-limit');
          resources.generatedBytes += output.bytes.length;
          if (!this.#cache.canFit(output.bytes.length)) {
            this.#engine.release(output.metadata.owner);
            return finish('resource-limit');
          }
          let installed = false;
          try {
            at = performance.now();
            const module = await WebAssembly.compile(new Uint8Array(output.bytes));
            timings.browserCompileMs += performance.now() - at;
            if (!this.#engine.valid(output.metadata.owner)) continue;
            at = performance.now();
            const artifact: Artifact = {
              run: this.#engine.instantiate(module),
              metadata: output.metadata,
            };
            timings.instantiationMs += performance.now() - at;
            if (!this.#cache.install(artifact)) return finish('resource-limit');
            installed = true;
            entry = this.#cache.get(pc);
            if (entry?.artifact !== artifact)
              throw new Error('installed artifact does not own its requested entry');
          } finally {
            if (!installed) this.#engine.release(output.metadata.owner);
          }
        }
        const before = remaining;
        const at = performance.now();
        this.#engine.clearFault();
        this.#engine.activate(entry.artifact.metadata.owner);
        const reason = this.#engine.execute(entry.artifact.run, entry.index, remaining, stop);
        timings.executionMs += performance.now() - at;
        resources.nativeEntries++;
        remaining = this.#engine.current().remaining;
        if (
          remaining > before ||
          (reason === 'dispatch' && remaining === before) ||
          (reason === 'budget' && remaining !== 0n)
        ) {
          throw new Error('generated execution violated its progress contract');
        }
        if (reason !== 'dispatch') return finish(reason);
        this.pruneTranslations();
        resources.dispatches++;
      }
    } catch (cause) {
      this.#lifecycle = 'failed';
      throw new Error('cpu engine failed', { cause });
    } finally {
      if (this.#lifecycle === 'running') this.#lifecycle = 'idle';
    }
  }

  dispose(): void {
    if (this.#lifecycle === 'running') throw new Error('cpu is running');
    if (this.#lifecycle === 'disposed') return;
    const core = this.#core;
    const failed = this.#lifecycle === 'failed';
    this.#lifecycle = 'disposed';
    this.#core = undefined;
    this.#cache.clear();
    if (!failed) core?.dispose();
  }
}
