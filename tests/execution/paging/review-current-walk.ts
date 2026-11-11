import { createCpu } from '../../../host/index.js';
import { LIMITS } from '../../support/fixture.js';
import { BANK, PC, equal, initial, little, same, type Scenario } from './fixture.js';

async function redirected(compiler: WebAssembly.Module, allowance: number) {
  const root = new Uint8Array(4096);
  root.set(little([0x10727n]));
  const old = new Uint8Array(4096);
  old.set(little([0x20007n]));
  const fresh = new Uint8Array(4096);
  fresh.set(little([0x22027n]));
  const directory = new Uint8Array(4096);
  directory.set(little([0x32027n]), 16);
  const table = new Uint8Array(4096);
  table.set(little([0x50027n]));
  const backings = [
    { id: 'root', bytes: root },
    { id: 'oldpdpt', bytes: old },
    { id: 'olddir', bytes: new Uint8Array(4096) },
    { id: 'pdpt', bytes: fresh },
    { id: 'dir', bytes: directory },
    { id: 'pt', bytes: table },
    { id: 'code', bytes: Uint8Array.of(0x90) },
  ];
  const map = (base: bigint, backing: string, offset: number, length: number, execute = false) => ({
    base,
    backing,
    offset,
    length,
    permissions: { read: true, write: true, execute },
  });
  return createCpu({
    compiler,
    memoryModel: 'ia32e-paged',
    paging: BANK,
    entry: PC,
    memory: {
      backings,
      mappings: [
        map(0x1000n, 'root', 0, 4096),
        map(0x10000n, 'root', 1, 1),
        map(0x10001n, 'oldpdpt', 1, 4095),
        map(0x20000n, 'olddir', 0, 4096),
        map(0x12000n, 'pdpt', 0, 4096),
        map(0x22000n, 'dir', 0, 4096),
        map(0x32000n, 'pt', 0, 4096),
        map(0x50000n, 'code', 0, 1, true),
      ],
    },
    memoryLimits: { maxBackings: 7, maxMappings: 8, maxBackingBytes: 24577 },
    limits: { ...LIMITS, maxTranslationsPerRun: allowance },
  });
}

export function pagingCurrentWalkReviewScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'paging first-byte A alias redirects the already-used hierarchy before an obsolete lower P0 can fault',
      async run() {
        const small = await redirected(compiler, 1),
          large = await redirected(compiler, 8);
        try {
          for (const cpu of [small, large]) cpu.setState(initial(PC, {}, 0x10002n));
          const suspended = await small.run({ budget: 1n });
          equal(suspended.reason, 'resource-limit', 'abandon stale current-byte hierarchy');
          equal(suspended.resources.pagingRestarts, 1, 'one actual abandonment');
          equal(suspended.resources.compilations, 0, 'no source admitted');
          equal(suspended.retired, 0n, 'no instruction begin');
          equal(suspended.state.flags, 0x10002n, 'RF preserved');
          equal(small.readPagingState().cr2, 0n, 'obsolete lower P0 never selected');
          const resumed = await small.run({ budget: 1n }),
            direct = await large.run({ budget: 1n });
          equal(resumed.reason, 'budget', 'current hierarchy maps valid NOP');
          equal(resumed.retired, 1n, 'executes once');
          equal(resumed.state.rip, PC + 1n, 'correct NOP continuation');
          equal(resumed.resources.pagingRestarts, 0, 'stable resumed walk');
          same(resumed.state, direct.state, 'short resumes equal sufficient allowance');
          equal(large.readPagingState().cr2, 0n, 'large allowance also sees no false PF');
        } finally {
          small.dispose();
          large.dispose();
        }
      },
    },
  ];
}
