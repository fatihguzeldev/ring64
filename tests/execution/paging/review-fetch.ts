import { createCpu, type Cpu, type MemoryBackingInput } from '../../../host/index.js';
import { LIMITS } from '../../support/fixture.js';
import { BANK, PC, equal, same, initial, little, word, type Scenario } from './fixture.js';

async function aliasChain(
  compiler: WebAssembly.Module,
  allowance: number,
  absent: boolean,
): Promise<Cpu> {
  const root = new Uint8Array(0x1000);
  root.set(little([0x10727n]));
  const backings: MemoryBackingInput[] = [{ id: 'root', bytes: root }];
  const mappings = [
    {
      base: 0x1000n,
      backing: 'root',
      offset: 0,
      length: root.length,
      permissions: { read: true, write: true, execute: false },
    },
  ];
  const full = (id: string, physical: bigint, bytes: Uint8Array, execute = false) => {
    backings.push({ id, bytes });
    mappings.push({
      base: physical,
      backing: id,
      offset: 0,
      length: bytes.length,
      permissions: { read: true, write: true, execute },
    });
  };
  for (const [index, pdpt] of [0x10000n, 0x12000n, 0x212000n].entries()) {
    const directory = 0x20000n + BigInt(index) * 0x2000n;
    const table = 0x30000n + BigInt(index) * 0x2000n;
    const physical = 0x40000n + BigInt(index) * 0x10000n;
    const pdptBytes = new Uint8Array(0x1000);
    pdptBytes.set(little([directory | 0x27n]));
    full(`pdpt${index}`, pdpt, pdptBytes);
    const directoryBytes = new Uint8Array(0x1000);
    directoryBytes.set(little([table | 0x27n]), 16);
    full(`directory${index}`, directory, directoryBytes);
    const tableBytes = new Uint8Array(0x1000);
    tableBytes.set(little([index === 2 && absent ? 0x8000000000000000n : physical | 0x27n]));
    if (index === 2) full(`table${index}`, table, tableBytes);
    else {
      backings.push({ id: `table${index}`, bytes: tableBytes });
      mappings.push({
        base: table,
        backing: 'root',
        offset: index + 1,
        length: 1,
        permissions: { read: true, write: true, execute: false },
      });
      mappings.push({
        base: table + 1n,
        backing: `table${index}`,
        offset: 1,
        length: 0xfff,
        permissions: { read: true, write: true, execute: false },
      });
    }
    full(`code${index}`, physical, Uint8Array.of(0x90, 0x82), true);
  }
  return createCpu({
    compiler,
    memoryModel: 'ia32e-paged',
    paging: BANK,
    memory: { backings, mappings },
    entry: PC,
    memoryLimits: { maxBackings: 16, maxMappings: 24, maxBackingBytes: 0x10000 },
    limits: { ...LIMITS, maxTranslationsPerRun: allowance },
  });
}

export function pagingReviewFetchScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'paging review upper walk A invalidating consumed encoding abandons before a lower absent PTE can select a fault',
      async run() {
        for (const allowance of [1, 8]) {
          const tables = new Uint8Array(0x4000);
          for (const [address, value] of [
            [0x1000, 0x2027n],
            [0x2000, 0x3027n],
            [0x3010, 0x4027n],
            [0x3018, 0x5043n],
            [0x4ff8, 0x9027n],
          ] as const)
            tables.set(little([value]), address - 0x1000);
          const cpu = await createCpu({
            compiler,
            memoryModel: 'ia32e-paged',
            paging: BANK,
            memory: {
              backings: [
                { id: 'tables', bytes: tables },
                { id: 'missing', bytes: new Uint8Array(0x1000) },
              ],
              mappings: [
                {
                  base: 0x1000n,
                  backing: 'tables',
                  offset: 0,
                  length: 0x4000,
                  permissions: { read: true, write: true, execute: false },
                },
                {
                  base: 0x5000n,
                  backing: 'missing',
                  offset: 0,
                  length: 0x1000,
                  permissions: { read: true, write: true, execute: false },
                },
                {
                  base: 0x9fffn,
                  backing: 'tables',
                  offset: 0x2018,
                  length: 1,
                  permissions: { read: true, write: true, execute: true },
                },
              ],
            },
            entry: 0x5fffffn,
            memoryLimits: { maxBackings: 2, maxMappings: 3, maxBackingBytes: 0x5000 },
            limits: { ...LIMITS, maxTranslationsPerRun: allowance },
          });
          try {
            cpu.setState(initial(0x5fffffn, {}, 0x10002n));
            let result = await cpu.run({ budget: 1n });
            if (allowance === 1) {
              equal(result.reason, 'resource-limit', 'upper A abandons before lower P0');
              equal(result.resources.pagingRestarts, 1, 'one abandoned required-byte walk');
              equal(cpu.readPagingState().cr2, 0n, 'lower P0 not selected in abandoned pass');
              equal(result.state.flags, 0x10002n, 'pre-begin RF retained');
              result = await cpu.run({ budget: 1n });
            }
            equal(result.reason, 'page-fault', 'fresh changed instruction reaches lower P0');
            equal(result.retired, 0n, 'new MOVSXD never begins');
            equal(result.resources.compilations, 0, 'no encoding admitted');
            equal(cpu.readPagingState().cr2, 0x600000n, 'actual missing second instruction byte');
            equal(
              word(cpu, 0x3018n),
              0x5063n,
              'completed upper A changed the consumed REX to MOVSXD',
            );
            equal(result.state.rip, 0x5fffffn, 'original instruction boundary');
            equal(result.state.flags, 0x10002n, 'required-fetch fault precedes RF clearing');
          } finally {
            cpu.dispose();
          }
        }
      },
    },
    {
      name: 'paging review successive accessed aliases consume two finite restart passes and short resumes equal one admitted run',
      async run() {
        const small = await aliasChain(compiler, 1, false),
          large = await aliasChain(compiler, 8, false);
        try {
          for (const cpu of [small, large]) cpu.setState(initial(PC, {}, 0x10002n));
          const first = await small.run({ budget: 1n });
          equal(first.reason, 'resource-limit', 'first abandoned translation');
          equal(first.resources.pagingRestarts, 1, 'first finite pass');
          equal(first.resources.compilations, 0, 'no compilation on abandoned pass');
          equal(first.retired, 0n, 'no instruction began');
          equal(first.state.flags, 0x10002n, 'RF retained');
          equal(word(small, 0x1000n), 0x12727n, 'first alias selects second hierarchy');
          const second = await small.run({ budget: 1n });
          equal(second.reason, 'resource-limit', 'second abandoned translation');
          equal(second.resources.pagingRestarts, 1, 'fresh per-run allowance');
          equal(second.resources.compilations, 0, 'no false compilation');
          equal(second.retired, 0n, 'still before instruction begin');
          equal(second.state.flags, 0x10002n, 'second RF retained');
          equal(word(small, 0x1000n), 0x212727n, 'second alias selects final hierarchy');
          const stable = await small.run({ budget: 1n }),
            direct = await large.run({ budget: 1n });
          equal(stable.reason, 'budget', 'stable NOP completes');
          equal(stable.resources.pagingRestarts, 0, 'no no-op bitset restart');
          equal(
            direct.resources.pagingRestarts,
            2,
            'large run observes exactly two abandoned admissions',
          );
          equal(stable.retired, 1n, 'one final retirement');
          same(stable.state, direct.state, 'same final scalar boundary');
          equal(stable.state.flags, 2n, 'only real begin consumes RF');
          equal(
            stable.resources.compilations,
            direct.resources.compilations,
            'same actual compilation count',
          );
          equal(word(small, 0x1000n), word(large, 0x1000n), 'same completed A effects');
        } finally {
          small.dispose();
          large.dispose();
        }
      },
    },
    {
      name: 'paging review restart ceiling yields before a not-yet-admitted missing-page pass while a large run selects the real fetch PF',
      async run() {
        const small = await aliasChain(compiler, 2, true),
          large = await aliasChain(compiler, 8, true);
        try {
          for (const cpu of [small, large]) cpu.setState(initial(PC, {}, 0x10002n));
          const bounded = await small.run({ budget: 1n });
          equal(bounded.reason, 'resource-limit', 'ceiling before third fetch pass');
          equal(bounded.resources.pagingRestarts, 2, 'two actual abandonments');
          equal(bounded.resources.compilations, 0, 'no admitted compilation');
          equal(small.readPagingState().cr2, 0n, 'unadmitted next-pass PF has no CR2 effect');
          equal(bounded.state.flags, 0x10002n, 'pre-begin RF retained');
          const resumed = await small.run({ budget: 1n }),
            direct = await large.run({ budget: 1n });
          equal(resumed.reason, 'page-fault', 'next run admits faulting pass');
          equal(direct.reason, 'page-fault', 'large run reaches same PF');
          equal(direct.resources.pagingRestarts, 2, 'fault follows both abandonments');
          equal(resumed.resources.pagingRestarts, 0, 'fault itself is not a restart');
          equal(resumed.resources.compilations, 0, 'fault before compilation');
          equal(small.readPagingState().cr2, PC, 'actual failing linear fetch');
          same(resumed.state, direct.state, 'same frozen boundary');
          equal(resumed.state.flags, 0x10002n, 'report pre-begin fetch PF retains RF');
        } finally {
          small.dispose();
          large.dispose();
        }
      },
    },
  ];
}
