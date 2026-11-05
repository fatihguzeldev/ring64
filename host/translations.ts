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
  readonly #artifacts = new Map<Artifact, true>();
  #bytes = 0;

  constructor(
    readonly maxArtifacts: number,
    readonly maxBytes: number,
  ) {}

  get(pc: bigint): InstalledEntry | undefined {
    const entry = this.#entries.get(pc);
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
      this.#artifacts.delete(oldest);
      this.#bytes -= oldest.metadata.byteLength;
      for (const pc of oldest.metadata.entries) {
        if (this.#entries.get(pc)?.artifact === oldest) this.#entries.delete(pc);
      }
    }
    this.#artifacts.set(artifact, true);
    this.#bytes += artifact.metadata.byteLength;
    artifact.metadata.entries.forEach((pc, index) => {
      this.#entries.set(pc, Object.freeze({ artifact, index }));
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
    }));
  }

  clear(): void {
    this.#entries.clear();
    this.#artifacts.clear();
    this.#bytes = 0;
  }
}
