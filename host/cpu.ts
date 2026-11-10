import {
  captureContext,
  type ExecutionContext,
  type ExecutionContextSnapshot,
  type SegmentFault,
} from './context.js';
import { captureX87State, type X87State, type X87Exception } from './x87.js';
import {
  Core,
  captureState,
  captureXmmState,
  captureMxcsr,
  copyMemoryInput,
  unsigned64,
  type CompileLimits,
  type Fault,
  type AlignmentFault,
  type SimdException,
  type GeneralProtectionFault,
  type ProtectionFault,
  type SystemMemoryFault,
  type Span,
  type State,
  type StateSnapshot,
  type DebugException,
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
  context?: ExecutionContext;
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
  repeatIterations: bigint;
  remainingRepeatBudget: bigint;
  deliveryAttempts?: bigint;
  remainingDeliveryBudget?: bigint;
  state: StateSnapshot;
  fault?: Fault;
  segmentFault?: SegmentFault;
  alignmentFault?: AlignmentFault;
  simdException?: SimdException;
  generalProtectionFault?: GeneralProtectionFault;
  x87Exception?: X87Exception;
  protectionFault?: ProtectionFault;
  systemMemoryFault?: SystemMemoryFault;
  debugException?: DebugException;
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
// [] -> [] with v128.const followed by drop: fixed SIMD, no relaxed operations.
const SIMD_PROBE = Uint8Array.of(
  0,
  97,
  115,
  109,
  1,
  0,
  0,
  0,
  1,
  4,
  1,
  96,
  0,
  0,
  3,
  2,
  1,
  0,
  10,
  23,
  1,
  21,
  0,
  253,
  12,
  ...Array<number>(16).fill(0),
  26,
  11,
);

export async function createCpu(options: Options): Promise<Cpu> {
  const began = performance.now();
  if (!WebAssembly.validate(SIMD_PROBE)) throw new TypeError('WebAssembly SIMD is required');
  const limits = checkedLimits(options.limits);
  const memory = captureInitialMemory(options);
  const contextInput = options.context;
  const context = contextInput === undefined ? undefined : captureContext(contextInput);
  const core = await Core.create(options.compiler, memory, context);
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
  #runGeneration = 0;
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

  private requireIdle(runGeneration?: number): number {
    if (this.#lifecycle !== 'idle') throw new Error(`cpu is ${this.#lifecycle}`);
    if (runGeneration !== undefined && runGeneration !== this.#runGeneration)
      throw new Error('cpu run started during input capture');
    return this.#runGeneration;
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

  private engineCall<T>(action: () => T): T {
    try {
      return action();
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
    this.engineCall(() => this.#engine.addBacking(captured[0]!));
    this.#backings = lengths;
  }

  removeBacking(id: string): void {
    this.requireIdle();
    backingName(id);
    if (!this.#backings.has(id)) throw new TypeError('unknown backing name');
    this.engineCall(() => this.#engine.removeBacking(id));
    this.#backings.delete(id);
  }

  setMappings(mappings: MemoryMapping[]): void {
    this.requireIdle();
    const captured = captureMappings(mappings, this.#memoryLimits);
    this.requireIdle();
    validateMappings(captured, this.#backings);
    this.engineCall(() => this.#engine.setMappings(captured));
    this.pruneTranslations();
  }

  readContext(): ExecutionContextSnapshot {
    this.requireIdle();
    return this.engineCall(() => this.#engine.readContext());
  }

  setContext(context: ExecutionContext): void {
    this.requireIdle();
    const input = captureContext(context);
    this.requireIdle();
    this.engineCall(() => this.#engine.setContext(input));
    this.pruneTranslations();
  }

  setState(state: State): void {
    const generation = this.requireIdle();
    const input = captureState(state);
    // Input accessors can start a run or dispose the CPU.
    this.requireIdle(generation);
    this.engineCall(() => this.#engine.setState(input));
  }
  readState(): StateSnapshot {
    this.requireIdle();
    return this.engineCall(() => this.#engine.snapshot());
  }
  setXmmState(state: bigint[]): void {
    this.requireIdle();
    const bank = captureXmmState(state);
    this.requireIdle();
    this.engineCall(() => this.#engine.setXmmState(bank));
  }
  readXmmState(): bigint[] {
    this.requireIdle();
    return this.engineCall(() => this.#engine.readXmmState());
  }
  readMxcsr(): number {
    this.requireIdle();
    return this.engineCall(() => this.#engine.readMxcsr());
  }
  setMxcsr(value: number): void {
    this.requireIdle();
    const input = captureMxcsr(value);
    this.requireIdle();
    this.engineCall(() => this.#engine.setMxcsr(input));
  }
  readX87State(): X87State {
    this.requireIdle();
    return this.engineCall(() => this.#engine.readX87State());
  }
  setX87State(value: X87State): void {
    this.requireIdle();
    const input = captureX87State(value);
    this.requireIdle();
    this.engineCall(() => this.#engine.setX87State(input));
  }
  readMemory(address: bigint, length: number): Uint8Array {
    this.requireIdle();
    return this.engineCall(() => this.#engine.readMemory(address, length));
  }
  writeMemory(address: bigint, bytes: Uint8Array): void {
    this.requireIdle();
    unsigned64(address, 'address');
    const input = copyMemoryInput(bytes);
    this.requireIdle();
    this.engineCall(() => this.#engine.writeOwnedMemory(address, input));
    this.pruneTranslations();
  }
  inspectTranslations() {
    this.requireIdle();
    return this.#cache.inspect();
  }

  async run(options: {
    budget: bigint;
    stop?: bigint | undefined;
    repeatBudget?: bigint | undefined;
    exceptionDelivery?: { budget: bigint } | undefined;
  }): Promise<RunResult> {
    const generation = this.requireIdle();
    const { budget, stop, repeatBudget: suppliedRepeatBudget, exceptionDelivery } = options;
    let deliveryBudget: bigint | undefined;
    if (exceptionDelivery !== undefined) {
      if (
        exceptionDelivery === null ||
        typeof exceptionDelivery !== 'object' ||
        Array.isArray(exceptionDelivery)
      ) {
        throw new TypeError('exceptionDelivery must contain a budget');
      }
      deliveryBudget = exceptionDelivery.budget;
    }
    this.requireIdle(generation);
    unsigned64(budget, 'budget');
    if (stop !== undefined) unsigned64(stop, 'stop');
    const repeatBudget = suppliedRepeatBudget === undefined ? budget : suppliedRepeatBudget;
    unsigned64(repeatBudget, 'repeatBudget');
    if (exceptionDelivery !== undefined) unsigned64(deliveryBudget, 'exception delivery budget');
    if (this.#runGeneration === Number.MAX_SAFE_INTEGER)
      throw new Error('cpu run generation exhausted');
    this.#runGeneration++;
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
    let remainingRepeatBudget = repeatBudget;
    let remainingDeliveryBudget = deliveryBudget;
    const finish = (reason: string): RunResult => {
      this.pruneTranslations();
      const fault = this.#engine.fault(reason);
      const segmentFault = this.#engine.segmentFault(reason);
      const alignmentFault = this.#engine.alignmentFault(reason);
      const simdException =
        reason === 'simd-exception' ? this.#engine.simdException(reason) : undefined;
      const generalProtectionFault =
        reason === 'general-protection' ? this.#engine.generalProtectionFault(reason) : undefined;
      const x87Exception =
        reason === 'x87-exception' ? this.#engine.x87Exception(reason) : undefined;
      const protectionFault =
        reason === 'protection-fault' ? this.#engine.protectionFault(reason) : undefined;
      const systemMemoryFault =
        reason === 'system-memory-fault' ? this.#engine.systemMemoryFault(reason) : undefined;
      const debugException =
        reason === 'debug-exception' ? this.#engine.debugException(reason) : undefined;
      const result = {
        reason,
        retired: budget - remaining,
        remaining,
        repeatIterations: repeatBudget - remainingRepeatBudget,
        remainingRepeatBudget,
        ...(deliveryBudget === undefined
          ? {}
          : {
              deliveryAttempts: deliveryBudget - remainingDeliveryBudget!,
              remainingDeliveryBudget: remainingDeliveryBudget!,
            }),
        state: this.#engine.snapshot(),
        ...(fault ? { fault } : {}),
        ...(segmentFault ? { segmentFault } : {}),
        ...(alignmentFault ? { alignmentFault } : {}),
        ...(simdException ? { simdException } : {}),
        ...(generalProtectionFault ? { generalProtectionFault } : {}),
        ...(x87Exception ? { x87Exception } : {}),
        ...(protectionFault ? { protectionFault } : {}),
        ...(systemMemoryFault ? { systemMemoryFault } : {}),
        ...(debugException ? { debugException } : {}),
        resources: { ...resources, ...this.#cache.resources() },
        timings,
      };
      timings.totalMs = performance.now() - began;
      return result;
    };
    try {
      if (deliveryBudget !== undefined) this.#engine.configureDelivery(true);
      let servicingEvent = false;
      for (;;) {
        const eventKind = this.#engine.eventKind();
        if (eventKind === 'shutdown') return finish('shutdown');
        const boundaryObserved = eventKind === 'ready' && this.#engine.prepareEntry();
        const pc = this.#engine.current().rip;
        if (!servicingEvent) {
          if (remaining === 0n) return finish('budget');
          if (stop !== undefined && pc === stop) return finish('stop');
        }
        if (eventKind === 'pending') {
          if (remainingDeliveryBudget === undefined) return finish('pending-exception');
          if (remainingDeliveryBudget === 0n) return finish('event-budget');
          remainingDeliveryBudget--;
          const at = performance.now();
          const reason = this.#engine.deliverException();
          timings.executionMs += performance.now() - at;
          if (reason !== 'dispatch') return finish(reason);
          servicingEvent = this.#engine.eventKind() === 'pending';
          this.pruneTranslations();
          resources.dispatches++;
          continue;
        }
        servicingEvent = false;
        let entry = this.#cache.get(pc, boundaryObserved);
        if (entry) {
          resources.cacheHits++;
        } else {
          const probe = this.#engine.probe(pc);
          if (probe !== 'dispatch') {
            if (deliveryBudget !== undefined && this.#engine.stageException(probe)) {
              servicingEvent = true;
              continue;
            }
            return finish(probe);
          }
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
            if (
              this.#engine.contextVersion() !== output.metadata.contextVersion ||
              this.#engine.boundaryObserved() !== (output.metadata.boundaryObserved ?? false) ||
              !this.#engine.valid(output.metadata.owner)
            )
              continue;
            at = performance.now();
            const artifact: Artifact = {
              run: this.#engine.instantiate(module),
              metadata: output.metadata,
            };
            timings.instantiationMs += performance.now() - at;
            if (!this.#cache.install(artifact)) return finish('resource-limit');
            installed = true;
            entry = this.#cache.get(pc, boundaryObserved);
            if (entry?.artifact !== artifact)
              throw new Error('installed artifact does not own its requested entry');
          } finally {
            if (!installed) this.#engine.release(output.metadata.owner);
          }
        }
        const before = remaining;
        const repeatBefore = remainingRepeatBudget;
        const at = performance.now();
        this.#engine.activate(entry.artifact.metadata.owner);
        const reason = this.#engine.execute(
          entry.artifact.run,
          entry.index,
          remaining,
          stop,
          remainingRepeatBudget,
        );
        timings.executionMs += performance.now() - at;
        resources.nativeEntries++;
        const current = this.#engine.current();
        remaining = current.remaining;
        remainingRepeatBudget = current.repeatRemaining;
        if (
          remaining > before ||
          remainingRepeatBudget > repeatBefore ||
          (reason === 'dispatch' &&
            remaining === before &&
            remainingRepeatBudget === repeatBefore) ||
          (reason === 'budget' && remaining !== 0n) ||
          (reason === 'repeat-budget' && (remainingRepeatBudget !== 0n || remaining === 0n))
        ) {
          throw new Error('generated execution violated its progress contract');
        }
        if (reason !== 'dispatch') {
          if (deliveryBudget !== undefined && this.#engine.stageException(reason)) {
            servicingEvent = true;
            continue;
          }
          return finish(reason);
        }
        this.pruneTranslations();
        resources.dispatches++;
      }
    } catch (cause) {
      this.#lifecycle = 'failed';
      throw new Error('cpu engine failed', { cause });
    } finally {
      if (this.#lifecycle === 'running') {
        if (deliveryBudget !== undefined) this.#engine.configureDelivery(false);
        this.#lifecycle = 'idle';
      }
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
