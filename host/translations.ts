import type { GeneratedRun, UnitMetadata } from './core.js';

export interface Artifact {
  run: GeneratedRun;
  metadata: UnitMetadata;
}

export interface InstalledEntry {
  readonly artifact: Artifact;
  readonly index: number;
}

export class Translations {
  readonly #entries = new Map<bigint, InstalledEntry>();
  readonly #observedEntries = new Map<bigint, InstalledEntry>();
  readonly #artifacts = new Map<Artifact, true>();
  #bytes = 0;

  constructor(
    readonly maxArtifacts: number,
    readonly maxBytes: number,
    readonly release: (artifact: Artifact) => void = () => {},
  ) {}

  get(pc: bigint, boundaryObserved = false): InstalledEntry | undefined {
    const entries = boundaryObserved ? this.#observedEntries : this.#entries;
    const entry = entries.get(pc);
    if (entry) {
      this.#artifacts.delete(entry.artifact);
      this.#artifacts.set(entry.artifact, true);
    }
    return entry;
  }

  canFit(bytes: number): boolean {
    return bytes <= this.maxBytes;
  }

  install(artifact: Artifact): boolean {
    if (!this.canFit(artifact.metadata.byteLength)) return false;
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
      entries.set(pc, Object.freeze({ artifact, index }));
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

  private remove(artifact: Artifact): void {
    this.#artifacts.delete(artifact);
    this.#bytes -= artifact.metadata.byteLength;
    const entries = artifact.metadata.boundaryObserved ? this.#observedEntries : this.#entries;
    for (const pc of artifact.metadata.entries) {
      if (entries.get(pc)?.artifact === artifact) entries.delete(pc);
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
