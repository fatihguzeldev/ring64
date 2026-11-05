import { createCpu } from '../../host/index.js';
import { runScenarios } from './scenarios.js';

const resultWindow = window as Window & { ring64Result?: Promise<string> };

resultWindow.ring64Result = (async () => {
  const bytes = new Uint8Array(await (await fetch('/build/ring64.wasm')).arrayBuffer());
  const conformance = await runScenarios(bytes);
  const code = Uint8Array.from(
    'b800000000b9030000004801c84883e90175f7488903'.match(/../g)!,
    (byte) => parseInt(byte, 16),
  );
  const limits = {
    maxInstructions: 128,
    maxSourceBytes: 2048,
    maxArtifactBytes: 262144,
    maxCachedArtifacts: 32,
    maxCachedBytes: 4194304,
    maxTranslationsPerRun: 32,
  };
  const creationAt = performance.now();
  const cpu = await createCpu({
    compiler: bytes,
    code: { base: 0x1000n, bytes: code },
    ram: { base: 0x8000n, bytes: new Uint8Array(32) },
    limits,
  });
  const creationWallMs = performance.now() - creationAt;
  try {
    const initial = { registers: Array<bigint>(16).fill(0n), flags: 2n, rip: 0x1000n };
    initial.registers[3] = 0x8008n;
    cpu.setState(initial);
    const firstAt = performance.now();
    const first = await cpu.run({ budget: 13n, stop: 0x1016n });
    const firstWallMs = performance.now() - firstAt;
    cpu.setState(initial);
    cpu.writeMemory(0x8000n, new Uint8Array(32));
    const reusedAt = performance.now();
    const reused = await cpu.run({ budget: 13n, stop: 0x1016n });
    const reusedWallMs = performance.now() - reusedAt;
    if (
      first.retired !== 12n ||
      first.state.registers[0] !== 6n ||
      reused.resources.compilations !== 0 ||
      reused.state.registers[0] !== 6n
    ) {
      throw new Error('characterization output mismatch');
    }
    return JSON.stringify(
      {
        conformance,
        environment: { userAgent: navigator.userAgent },
        characterization: {
          label: 'tiny literal; phase costs, not a throughput ranking',
          creationMs: cpu.creationMs,
          creationWallMs,
          firstWallMs,
          reusedWallMs,
          limits,
          first,
          reused,
          units: cpu.inspectTranslations(),
        },
      },
      (_, value: unknown) => (typeof value === 'bigint' ? '0x' + value.toString(16) : value),
    );
  } finally {
    cpu.dispose();
  }
})();
