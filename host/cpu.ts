import { captureIo, type IoProvider } from './io.js';
import type { DeviceNotAvailable, NumericControlFault } from './numeric-controls.js';
import { captureDebugState, type DebugState } from './debug.js';
import { capturePagingState, type PagingState } from './paging.js';
import {
  captureFastSystemState,
  zeroFastSystemState,
  type FastSystemState,
} from './fast-system.js';
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
  type State,
  type StateSnapshot,
  type DebugException,
  type PageFault,
  type PhysicalMemoryFault,
} from './core.js';
import { Translations, type Artifact, type InstalledEntry } from './translations.js';
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
  type MemoryModel,
  type MemoryOptions,
} from './memory.js';

export interface Limits extends CompileLimits {
  maxCachedArtifacts: number;
  maxCachedBytes: number;
  maxTranslationsPerRun: number;
}

interface CommonOptions {
  io?: IoProvider;
  compiler: Uint8Array | WebAssembly.Module;
  limits: Limits;
  context?: ExecutionContext;
}

export type Options = CommonOptions & MemoryOptions;

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
  deviceNotAvailable?: DeviceNotAvailable;
  numericControlFault?: NumericControlFault;
  protectionFault?: ProtectionFault;
  systemMemoryFault?: SystemMemoryFault;
  debugException?: DebugException;
  pageFault?: PageFault;
  physicalMemoryFault?: PhysicalMemoryFault;
  resources: {
    pagingRestarts?: number;
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
  const io = captureIo(options);
  const memory = captureInitialMemory(options);
  if (memory.memoryModel !== 'linear') {
    memory.paging = capturePagingState(options.paging!);
    memory.fastSystem =
      'fastSystem' in options ? captureFastSystemState(options.fastSystem!) : zeroFastSystemState();
  }
  const contextInput = options.context;
  const context =
    contextInput === undefined
      ? undefined
      : captureContext(contextInput, memory.memoryModel === 'physical');
  if (memory.memoryModel === 'physical' && context === undefined)
    throw new TypeError('physical memory requires a non-undefined context');
  if (
    memory.memoryModel === 'ia32e-paged' &&
    context &&
    context.mode !== 'long64' &&
    context.mode !== 'compatibility'
  )
    throw new TypeError('paged memory requires a Long64 or compatibility context');
  const core = await Core.create(options.compiler, memory, context, io);
  return new Cpu(
    CONSTRUCTION,
    core,
    limits,
    performance.now() - began,
    memory.memoryLimits,
    new Map(memory.backings.map(({ id, bytes }) => [id, bytes.length])),
    memory.memoryModel,
  );
}

export class Cpu {
  #lifecycle: 'idle' | 'running' | 'failed' | 'disposed' = 'idle';
  #runGeneration = 0;
  #captureToken: { readonly reset: object } = { reset: {} };
  readonly #cache: Translations;
  #core: Core | undefined;
  readonly #limits: Limits;
  readonly #memoryLimits: MemoryLimits;
  readonly #memoryModel: MemoryModel;
  #backings: Map<string, number>;

  constructor(
    token: typeof CONSTRUCTION,
    core: Core,
    limits: Limits,
    readonly creationMs: number,
    memoryLimits: MemoryLimits,
    backings: Map<string, number>,
    memoryModel: MemoryModel = 'linear',
  ) {
    if (token !== CONSTRUCTION) throw new TypeError('use the createCpu factory');
    this.#core = core;
    this.#limits = { ...limits };
    this.#memoryLimits = { ...memoryLimits };
    this.#memoryModel = memoryModel;
    this.#backings = backings;
    this.#cache = new Translations(limits.maxCachedArtifacts, limits.maxCachedBytes, (artifact) =>
      this.#core?.release(artifact.metadata.owner),
    );
  }

  private requireIdle(
    captureToken?: { readonly reset: object },
    allowCompletedRun = false,
  ): { readonly reset: object } {
    if (this.#lifecycle !== 'idle') throw new Error(`cpu is ${this.#lifecycle}`);
    if (
      captureToken !== undefined &&
      captureToken !== this.#captureToken &&
      (!allowCompletedRun || captureToken.reset !== this.#captureToken.reset)
    )
      throw new Error('cpu run or reset started during input capture');
    return this.#captureToken;
  }

  private requirePhysicalMemory(): void {
    if (this.#memoryModel === 'linear')
      throw new TypeError('method requires physical or ia32e-paged memory');
  }

  private requireMemoryModel(model: MemoryModel): void {
    if (this.#memoryModel !== model) throw new TypeError(`method requires ${model} memory`);
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
    const generation = this.requireIdle();
    const captured = captureBackings([input], this.#memoryLimits, this.#backings);
    this.requireIdle(generation, true);
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
    const generation = this.requireIdle();
    const captured = captureMappings(mappings, this.#memoryLimits, this.#memoryModel);
    this.requireIdle(generation, true);
    validateMappings(captured, this.#backings);
    this.engineCall(() => this.#engine.setMappings(captured));
    this.pruneTranslations();
  }

  readContext(): ExecutionContextSnapshot {
    this.requireIdle();
    return this.engineCall(() => this.#engine.readContext());
  }

  setContext(context: ExecutionContext): void {
    const generation = this.requireIdle();
    const input = captureContext(context, this.#memoryModel === 'physical');
    this.requireIdle(generation, true);
    if (
      this.#memoryModel === 'ia32e-paged' &&
      input.mode !== 'long64' &&
      input.mode !== 'compatibility'
    )
      throw new TypeError('paged memory requires a Long64 or compatibility context');
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
  requestInterrupt(vector: number): boolean {
    this.requireIdle();
    if (typeof vector !== 'number' || !Number.isInteger(vector) || vector < 0 || vector > 255)
      throw new TypeError('IRQ vector must be an unsigned 8-bit integer number');
    return this.engineCall(() => this.#engine.requestInterrupt(vector === 0 ? 0 : vector));
  }
  requestNmi(): void {
    this.requireIdle();
    this.engineCall(() => this.#engine.requestNmi());
  }
  setXmmState(state: bigint[]): void {
    const generation = this.requireIdle();
    const bank = captureXmmState(state);
    this.requireIdle(generation, true);
    this.engineCall(() => this.#engine.setXmmState(bank));
  }
  readDebugState(): DebugState {
    this.requireIdle();
    return this.engineCall(() => this.#engine.readDebugState());
  }
  setDebugState(state: DebugState): void {
    const generation = this.requireIdle();
    const input = captureDebugState(state);
    this.requireIdle(generation);
    this.engineCall(() => this.#engine.setDebugState(input));
    this.pruneTranslations();
  }
  readPagingState(): PagingState {
    this.requireIdle();
    this.requirePhysicalMemory();
    return this.engineCall(() => this.#engine.readPagingState());
  }
  setPagingState(state: PagingState): void {
    const generation = this.requireIdle();
    this.requirePhysicalMemory();
    const input = capturePagingState(state);
    this.requireIdle(generation);
    this.engineCall(() => this.#engine.setPagingState(input));
    this.pruneTranslations();
  }
  readFastSystemState(): FastSystemState {
    this.requireIdle();
    this.requirePhysicalMemory();
    return this.engineCall(() => this.#engine.readFastSystemState());
  }
  setFastSystemState(state: FastSystemState): void {
    const generation = this.requireIdle();
    this.requirePhysicalMemory();
    const input = captureFastSystemState(state);
    this.requireIdle(generation);
    this.engineCall(() => this.#engine.setFastSystemState(input));
    this.pruneTranslations();
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
    const generation = this.requireIdle();
    const input = captureMxcsr(value);
    this.requireIdle(generation, true);
    this.engineCall(() => this.#engine.setMxcsr(input));
  }
  readX87State(): X87State {
    this.requireIdle();
    return this.engineCall(() => this.#engine.readX87State());
  }
  setX87State(value: X87State): void {
    const generation = this.requireIdle();
    const input = captureX87State(value);
    this.requireIdle(generation, true);
    this.engineCall(() => this.#engine.setX87State(input));
  }
  readMemory(address: bigint, length: number): Uint8Array {
    this.requireIdle();
    this.requireMemoryModel('linear');
    return this.engineCall(() => this.#engine.readMemory(address, length));
  }
  writeMemory(address: bigint, bytes: Uint8Array): void {
    const generation = this.requireIdle();
    this.requireMemoryModel('linear');
    unsigned64(address, 'address');
    const input = copyMemoryInput(bytes);
    this.requireIdle(generation, true);
    this.engineCall(() => this.#engine.writeOwnedMemory(address, input));
    this.pruneTranslations();
  }
  readPhysicalMemory(address: bigint, length: number): Uint8Array {
    this.requireIdle();
    this.requirePhysicalMemory();
    return this.engineCall(() => this.#engine.readMemory(address, length));
  }
  writePhysicalMemory(address: bigint, bytes: Uint8Array): void {
    const generation = this.requireIdle();
    this.requirePhysicalMemory();
    unsigned64(address, 'address');
    const input = copyMemoryInput(bytes);
    this.requireIdle(generation);
    this.engineCall(() => this.#engine.writeOwnedMemory(address, input));
    this.pruneTranslations();
  }
  reset(): void {
    this.requireIdle();
    this.requireMemoryModel('physical');
    this.engineCall(() => {
      this.#engine.reset();
      this.#cache.clear();
    });
    this.#captureToken = { reset: {} };
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
    eventDelivery?: { budget: bigint } | undefined;
  }): Promise<RunResult> {
    const generation = this.requireIdle();
    const {
      budget,
      stop,
      repeatBudget: suppliedRepeatBudget,
      exceptionDelivery,
      eventDelivery,
    } = options;
    if (exceptionDelivery !== undefined && eventDelivery !== undefined)
      throw new TypeError('eventDelivery and exceptionDelivery are mutually exclusive');
    const selectedDelivery = eventDelivery === undefined ? exceptionDelivery : eventDelivery;
    let deliveryBudget: bigint | undefined;
    if (selectedDelivery !== undefined) {
      if (
        selectedDelivery === null ||
        typeof selectedDelivery !== 'object' ||
        Array.isArray(selectedDelivery)
      ) {
        throw new TypeError('event delivery must contain a budget');
      }
      deliveryBudget = selectedDelivery.budget;
    }
    this.requireIdle(generation);
    unsigned64(budget, 'budget');
    if (stop !== undefined) unsigned64(stop, 'stop');
    const repeatBudget = suppliedRepeatBudget === undefined ? budget : suppliedRepeatBudget;
    unsigned64(repeatBudget, 'repeatBudget');
    if (selectedDelivery !== undefined) unsigned64(deliveryBudget, 'event delivery budget');
    if (this.#runGeneration === Number.MAX_SAFE_INTEGER)
      throw new Error('cpu run generation exhausted');
    this.#runGeneration++;
    this.#captureToken = { reset: this.#captureToken.reset };
    this.#lifecycle = 'running';
    const began = performance.now();
    const resources = {
      ...(this.#memoryModel !== 'linear' ? { pagingRestarts: 0 } : {}),
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
    let admissionRestarts = 0;
    const restartAdmission = () => {
      if (admissionRestarts >= this.#limits.maxTranslationsPerRun) return false;
      admissionRestarts++;
      return true;
    };
    const finish = (reason: string): RunResult => {
      this.pruneTranslations();
      const numeric = this.#engine.numericFault?.(reason);
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
      const pageFault = reason === 'page-fault' ? this.#engine.pageFault(reason) : undefined;
      const physicalMemoryFault =
        reason === 'physical-memory-fault' ? this.#engine.physicalMemoryFault(reason) : undefined;
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
        ...(numeric?.vector === 7
          ? { deviceNotAvailable: numeric }
          : numeric?.vector === 6
            ? { numericControlFault: numeric }
            : {}),
        ...(fault ? { fault } : {}),
        ...(segmentFault ? { segmentFault } : {}),
        ...(alignmentFault ? { alignmentFault } : {}),
        ...(simdException ? { simdException } : {}),
        ...(generalProtectionFault ? { generalProtectionFault } : {}),
        ...(x87Exception ? { x87Exception } : {}),
        ...(protectionFault ? { protectionFault } : {}),
        ...(systemMemoryFault ? { systemMemoryFault } : {}),
        ...(debugException ? { debugException } : {}),
        ...(pageFault ? { pageFault } : {}),
        ...(physicalMemoryFault ? { physicalMemoryFault } : {}),
        resources: { ...resources, ...this.#cache.resources() },
        timings,
      };
      timings.totalMs = performance.now() - began;
      return result;
    };
    try {
      if (deliveryBudget !== undefined) this.#engine.configureDelivery(true);
      let servicingEvent = false;
      // Idle-only intake keeps queues stable except at explicit acceptance boundaries.
      let eventKind = this.#engine.eventKind();
      let queuedInterrupts = this.#engine.hasQueuedInterrupts();
      execution: for (;;) {
        if (
          eventKind === 'shutdown' &&
          (deliveryBudget === undefined || !this.#engine.shutdownCanWake())
        )
          return finish('shutdown');
        const boundaryObserved = eventKind === 'ready' && this.#engine.prepareEntry();
        const pc = this.#engine.current().rip;
        if (!servicingEvent) {
          if (remaining === 0n) return finish('budget');
          if (stop !== undefined && pc === stop) return finish('stop');
        }
        if (eventKind === 'pending' || eventKind === 'pending-interrupt') {
          if (remainingDeliveryBudget === undefined)
            return finish(eventKind === 'pending' ? 'pending-exception' : 'pending-interrupt');
          if (remainingDeliveryBudget === 0n) return finish('event-budget');
          remainingDeliveryBudget--;
          const at = performance.now();
          const reason = this.#engine.deliverException();
          timings.executionMs += performance.now() - at;
          if (reason === 'shutdown') {
            eventKind = 'shutdown';
            servicingEvent = false;
            continue;
          }
          if (reason !== 'dispatch') return finish(reason);
          eventKind = this.#engine.eventKind();
          servicingEvent = eventKind === 'pending' || eventKind === 'pending-interrupt';
          this.pruneTranslations();
          resources.dispatches++;
          continue;
        }
        servicingEvent = false;
        if (queuedInterrupts || eventKind === 'halted' || eventKind === 'shutdown') {
          const reason = this.#engine.externalBoundary();
          if (reason === 'pending-interrupt') {
            eventKind = this.#engine.eventKind();
            queuedInterrupts = this.#engine.hasQueuedInterrupts();
            if (deliveryBudget === undefined) return finish(reason);
            if (eventKind !== 'pending-interrupt')
              throw new Error('core failed to accept eligible interrupt');
            servicingEvent = true;
            continue;
          }
          if (reason !== 'dispatch') return finish(reason);
        }
        let entry: InstalledEntry | undefined;
        let cached = false;
        let executionBegan = 0;
        let refusedEpoch: bigint | undefined;
        for (const candidate of this.#cache.candidates(pc, boundaryObserved)) {
          executionBegan = performance.now();
          if (this.#engine.activate(candidate.artifact.metadata.owner)) {
            entry = candidate;
            cached = true;
            break;
          }
          timings.executionMs += performance.now() - executionBegan;
          if (!this.#engine.valid(candidate.artifact.metadata.owner))
            this.#cache.remove(candidate.artifact);
          const epoch = this.#engine.contextVersion();
          if (
            this.#engine.boundaryObserved() !== boundaryObserved ||
            (refusedEpoch !== undefined && refusedEpoch !== epoch)
          ) {
            if (!restartAdmission()) return finish('resource-limit');
            continue execution;
          }
          refusedEpoch = epoch;
        }
        if (!entry) {
          const probe = this.#engine.probe(pc);
          if (probe === 'paging-restart') {
            resources.pagingRestarts = (resources.pagingRestarts ?? 0) + 1;
            if (resources.pagingRestarts >= this.#limits.maxTranslationsPerRun)
              return finish('resource-limit');
            this.pruneTranslations();
            continue;
          }
          if (probe !== 'dispatch') {
            if (
              (deliveryBudget !== undefined || boundaryObserved) &&
              this.#engine.stageException(probe)
            ) {
              eventKind = 'pending';
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
              run: this.#engine.instantiate(module, output.metadata.boundaryObserved),
              metadata: output.metadata,
            };
            timings.instantiationMs += performance.now() - at;
            if (!this.#engine.publish(output.metadata.owner)) continue;
            if (!this.#cache.install(artifact)) return finish('resource-limit');
            installed = true;
            entry = this.#cache
              .candidates(pc, output.metadata.boundaryObserved)
              .find((candidate) => candidate.artifact === artifact);
            if (!entry) throw new Error('installed artifact does not own its requested entry');
          } finally {
            if (!installed) this.#engine.release(output.metadata.owner);
          }
          executionBegan = performance.now();
          if (!this.#engine.activate(entry.artifact.metadata.owner)) {
            timings.executionMs += performance.now() - executionBegan;
            if (!this.#engine.valid(entry.artifact.metadata.owner))
              this.#cache.remove(entry.artifact);
            if (!restartAdmission()) return finish('resource-limit');
            continue;
          }
        }
        const before = remaining;
        const repeatBefore = remainingRepeatBudget;
        const reason = this.#engine.execute(
          entry.artifact.run,
          entry.index,
          remaining,
          stop,
          remainingRepeatBudget,
        );
        timings.executionMs += performance.now() - executionBegan;
        this.#cache.touch(entry.artifact);
        if (cached) resources.cacheHits++;
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
        if (reason === 'paging-restart') {
          resources.pagingRestarts = (resources.pagingRestarts ?? 0) + 1;
          if (resources.pagingRestarts >= this.#limits.maxTranslationsPerRun)
            return finish('resource-limit');
          this.pruneTranslations();
          continue;
        }
        if (reason !== 'dispatch') {
          if (reason === 'pending-interrupt' || reason === 'halted') {
            eventKind = this.#engine.eventKind();
            queuedInterrupts = this.#engine.hasQueuedInterrupts();
            if (reason === 'pending-interrupt') {
              if (deliveryBudget === undefined) return finish(reason);
              if (eventKind !== 'pending-interrupt')
                throw new Error('core failed to accept eligible interrupt');
              servicingEvent = true;
              continue;
            }
            if (queuedInterrupts && this.#engine.externalBoundary() === 'pending-interrupt') {
              eventKind = this.#engine.eventKind();
              queuedInterrupts = this.#engine.hasQueuedInterrupts();
              if (deliveryBudget === undefined) return finish('pending-interrupt');
              if (eventKind !== 'pending-interrupt')
                throw new Error('core failed to accept eligible interrupt');
              servicingEvent = true;
            }
            continue;
          }
          if (
            (deliveryBudget !== undefined || boundaryObserved) &&
            this.#engine.stageException(reason)
          ) {
            eventKind = 'pending';
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
    core?.releaseIo();
    if (!failed) core?.dispose();
  }
}
