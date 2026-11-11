import type { GeneratedRun, UnitMetadata } from './core.js';

export interface Artifact {
  run: GeneratedRun;
  metadata: UnitMetadata;
}

export interface InstalledEntry {
  readonly artifact: Artifact;
  readonly index: number;
}

const EMPTY: readonly InstalledEntry[] = Object.freeze([]);

export class Translations {
  readonly #entries = new Map<bigint, readonly InstalledEntry[]>();
  readonly #observedEntries = new Map<bigint, readonly InstalledEntry[]>();
  readonly #artifacts = new Map<Artifact, true>();
  #bytes = 0;

  constructor(
    readonly maxArtifacts: number,
    readonly maxBytes: number,
    readonly release: (artifact: Artifact) => void = () => {},
  ) {}

  candidates(pc: bigint, boundaryObserved = false): readonly InstalledEntry[] {
    const entries = boundaryObserved ? this.#observedEntries : this.#entries;
    return entries.get(pc) ?? EMPTY;
  }

  touch(artifact: Artifact): void {
    if (this.#artifacts.delete(artifact)) this.#artifacts.set(artifact, true);
  }

  canFit(bytes: number): boolean {
    return bytes <= this.maxBytes;
  }

  install(artifact: Artifact): boolean {
    if (!this.canFit(artifact.metadata.byteLength)) return false;
    if (this.#artifacts.has(artifact)) return true;
    while (
      this.#artifacts.size >= this.maxArtifacts ||
      this.#bytes + artifact.metadata.byteLength > this.maxBytes
    ) {
      const oldest = this.#artifacts.keys().next().value;
      if (!oldest) throw new Error('cache accounting failed');
      this.remove(oldest);
    }
    this.#artifacts.set(artifact, true);
    this.#bytes += artifact.metadata.byteLength;
    const entries = artifact.metadata.boundaryObserved ? this.#observedEntries : this.#entries;
    artifact.metadata.entries.forEach((pc, index) => {
      entries.set(pc, [Object.freeze({ artifact, index }), ...(entries.get(pc) ?? EMPTY)]);
    });
    return true;
  }

  resources(): { cachedArtifacts: number; cachedBytes: number } {
    return { cachedArtifacts: this.#artifacts.size, cachedBytes: this.#bytes };
  }

  inspect(): UnitMetadata[] {
    return Array.from(this.#artifacts.keys(), (artifact) => ({
      ...artifact.metadata,
      entries: [...artifact.metadata.entries],
      dependencies: artifact.metadata.dependencies.map((range) => ({ ...range })),
    }));
  }

  remove(artifact: Artifact): void {
    if (!this.#artifacts.delete(artifact)) return;
    this.#bytes -= artifact.metadata.byteLength;
    const entries = artifact.metadata.boundaryObserved ? this.#observedEntries : this.#entries;
    for (const pc of artifact.metadata.entries) {
      const remaining = entries.get(pc)?.filter((entry) => entry.artifact !== artifact);
      if (remaining?.length) entries.set(pc, remaining);
      else entries.delete(pc);
    }
    this.release(artifact);
  }

  prune(valid: (artifact: Artifact) => boolean): void {
    for (const artifact of this.#artifacts.keys()) {
      if (!valid(artifact)) this.remove(artifact);
    }
  }

  clear(): void {
    for (const artifact of this.#artifacts.keys()) this.remove(artifact);
  }
}
