import { createCpu, type Cpu } from '../../../host/index.js';
import { LIMITS } from '../../support/fixture.js';
import {
  BANK,
  PC,
  check,
  equal,
  initial,
  little,
  same,
  usingPaged,
  word,
  type Scenario,
} from './fixture.js';

async function aliasCpu(
  compiler: WebAssembly.Module,
  kind: 'refetch' | 'read' | 'dirty',
  maxTranslationsPerRun = 8,
): Promise<Cpu> {
  const tables = new Uint8Array(0x4000);
  const entries: [number, bigint][] = [
    [0x1000, 0x2027n],
    [0x2000, 0x3027n],
    [0x3010, 0x4027n],
    [0x4000, 0x9027n],
  ];
  if (kind === 'refetch') entries.push([0x4008, 0xa043n]);
  else entries.push([0x4800, kind === 'read' ? 0xa091n : 0xa023n]);
  for (const [address, value] of entries) tables.set(little([value]), address - 0x1000);
  const code =
    kind === 'refetch'
      ? Uint8Array.of(0xc0)
      : Uint8Array.of(kind === 'read' ? 0x8b : 0x89, 0x07, 0, kind === 'read' ? 0x7f : 0xc0);
  const mapping = (
    base: bigint,
    backing: string,
    offset: number,
    length: number,
    execute: boolean,
  ) => ({ base, backing, offset, length, permissions: { read: true, write: true, execute } });
  const mappings = [
    mapping(0x1000n, 'tables', 0, 0x4000, false),
    ...(kind === 'refetch'
      ? [mapping(0x9fffn, 'tables', 0x3008, 1, true), mapping(0xa000n, 'code', 0, 1, true)]
      : [
          mapping(0x9000n, 'code', 0, 2, true),
          mapping(0x9002n, 'tables', 0x3800, 1, true),
          mapping(0x9003n, 'code', 3, 1, true),
          mapping(0xa000n, 'data', 0, 8, false),
        ]),
  ];
  return createCpu({
    compiler,
    memoryModel: 'ia32e-paged',
    paging: BANK,
    memory: {
      backings: [
        { id: 'tables', bytes: tables },
        { id: 'code', bytes: code },
        { id: 'data', bytes: little([0x11223344n]) },
      ],
      mappings,
    },
    memoryLimits: { maxBackingBytes: 0x5000, maxBackings: 3, maxMappings: 8 },
    entry: kind === 'refetch' ? PC + 0xfffn : PC,
    limits: { ...LIMITS, maxTranslationsPerRun },
  });
}

export function pagingFetchScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'paging required code faults precede exhausted compile allowance while execute debug precedes code walks',
      async run() {
        await usingPaged(compiler, { limits: { maxTranslationsPerRun: 1 } }, async (cpu) => {
          cpu.writePhysicalMemory(0x9fffn, Uint8Array.of(0x90));
          cpu.setState(initial(PC + 0xfffn));
          const result = await cpu.run({ budget: 2n });
          equal(result.reason, 'page-fault', 'required code PF before compile quota');
          equal(result.retired, 1n, 'completed current page');
          equal(result.pageFault?.address, PC + 0x1000n, 'exact next code byte');
          equal(result.pageFault?.errorCode, 0, 'NXE0 supervisor fetch bit clear');
        });
        await usingPaged(compiler, { bank: { ...BANK, cr3: 0x8000n } }, async (cpu) => {
          cpu.setDebugState({ addresses: [PC, 0n, 0n, 0n], dr6: 0n, dr7: 0x401n });
          cpu.setState(initial(PC, {}, 2n));
          equal(
            (await cpu.run({ budget: 1n })).reason,
            'debug-exception',
            'execute DB before unbacked root',
          );
          cpu.setState(initial(PC, {}, 0x10002n));
          const resumed = await cpu.run({ budget: 1n });
          equal(resumed.reason, 'physical-memory-fault', 'RF exposes backend root read');
          equal(resumed.physicalMemoryFault?.phase, 'walk-read', 'typed physical access');
          equal(resumed.state.flags, 0x10002n, 'failed fetch is pre-begin');
          equal(cpu.readPagingState().cr2, 0n, 'private refusal leaves CR2');
        });
      },
    },
    {
      name: 'paging sparse physical execution accepts the last physical byte and both large page sizes',
      async run() {
        const end = 1n << 52n;
        await usingPaged(
          compiler,
          {
            words: [[0x4000n, (end - 0x1000n) | 7n]],
            spans: [{ physical: end - 1n, bytes: Uint8Array.of(0x90), execute: true }],
          },
          async (cpu) => {
            cpu.setState(initial(PC + 0xfffn));
            equal((await cpu.run({ budget: 1n })).reason, 'budget', 'last legal physical byte');
          },
        );
        for (const [entry, leaf, physical] of [
          [0x3010n, 0x201087n, 0x200000n],
          [0x2000n, 0x40001087n, 0x40400000n],
        ] as const) {
          await usingPaged(
            compiler,
            {
              words: [[entry, leaf]],
              spans: [{ physical, bytes: Uint8Array.of(0x90), execute: true }],
            },
            async (cpu) => {
              equal(
                (await cpu.run({ budget: 1n })).reason,
                'budget',
                'large page PAT bit accepted',
              );
            },
          );
        }
      },
    },
    {
      name: 'paging initial gates and speculative discovery leave future code A and CR2 untouched',
      async run() {
        await usingPaged(
          compiler,
          {
            words: [[0x4008n, 0xa007n]],
            spans: [{ physical: 0xa000n, bytes: Uint8Array.of(0x90), execute: true }],
          },
          async (cpu) => {
            const before = cpu.readPhysicalMemory(0x1000n, 0x4000);
            equal((await cpu.run({ budget: 0n })).reason, 'budget', 'budget0 gate');
            same(cpu.readPhysicalMemory(0x1000n, 0x4000), before, 'no budget0 walk');
            equal((await cpu.run({ budget: 10n, stop: PC })).reason, 'stop', 'stop gate');
            same(cpu.readPhysicalMemory(0x1000n, 0x4000), before, 'no stop walk');
            cpu.writePhysicalMemory(0x9ffdn, Uint8Array.of(0x75, 0x01, 0x90));
            cpu.setState(initial(PC + 0xffdn, {}, 0x42n));
            equal((await cpu.run({ budget: 1n })).reason, 'budget', 'untaken conditional');
            equal(word(cpu, 0x4008n), 0xa007n, 'future discovery leaves A clear');
            equal(cpu.readPagingState().cr2, 0n, 'no speculative CR2');
          },
        );
      },
    },
    {
      name: 'paging accessed alias abandons obsolete encoding with finite pre-begin work and resumes exactly once',
      async run() {
        const small = await aliasCpu(compiler, 'refetch', 1);
        const large = await aliasCpu(compiler, 'refetch', 8);
        try {
          for (const cpu of [small, large])
            cpu.setState(initial(PC + 0xfffn, { 0: 0xffffffff80000001n }, 0x10002n));
          const suspended = await small.run({ budget: 1n });
          equal(suspended.reason, 'resource-limit', 'ceiling-th abandoned admission yields');
          equal(suspended.resources.pagingRestarts, 1, 'one restart');
          equal(suspended.resources.compilations, 0, 'no fictitious compilation');
          equal(suspended.retired, 0n, 'no obsolete REX instruction begins');
          equal(suspended.state.flags, 0x10002n, 'RF preserved before begin');
          equal(word(small, 0x4008n), 0xa063n, 'completed A visible through opcode alias');
          const resumed = await small.run({ budget: 1n });
          const direct = await large.run({ budget: 1n });
          equal(resumed.reason, 'budget', 'new shorter MOVSXD executes');
          equal(resumed.state.rip, PC + 0x1001n, 'two current bytes only, obsolete tail unmapped');
          equal(resumed.state.registers[0], 0x80000001n, 'current opcode result');
          equal(resumed.resources.pagingRestarts, 0, 'set A is no-op');
          same(resumed.state, direct.state, 'bounded resumes match sufficient allowance');
        } finally {
          small.dispose();
          large.dispose();
        }
      },
    },
    {
      name: 'paging read-accessed and dirty alias publication invalidate future native encoding before its execution',
      async run() {
        for (const kind of ['read', 'dirty'] as const) {
          const cpu = await aliasCpu(compiler, kind);
          try {
            cpu.setState(initial(PC, { 0: 0x1234567880000001n, 7: 0x500000n }, 0x8d7n));
            const result = await cpu.run({ budget: 2n });
            equal(result.reason, 'budget', 'two instructions');
            equal(result.retired, 2n, 'completed data operation never replayed');
            equal(result.state.flags, 0x8d7n, 'changed instruction preserves flags');
            if (kind === 'read') {
              equal(result.state.registers[0], 0x11223344n, 'load result remains');
              equal(
                result.state.registers[1]! & 255n,
                0x7fn,
                'new MOV CL immediate instead of old XCHG',
              );
            } else {
              equal(result.state.registers[0], 0x80000001n, 'new MOVSXD instead of old AND');
              equal(word(cpu, 0xa000n) & 0xffffffffn, 0x80000001n, 'one completed store');
            }
            check(result.resources.compilations >= 2, 'alias source requires replacement owner');
          } finally {
            cpu.dispose();
          }
        }
      },
    },
  ];
}
