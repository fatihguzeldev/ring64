import {
  createCpu,
  type Cpu,
  type ExecutionContext,
  type PagingState,
} from '../../../host/index.js';
import { LIMITS, check, equal, hex, initial, type Scenario } from '../../support/fixture.js';
import { context } from '../modes/fixture.js';
import { same } from '../far-control/fixture.js';

const PC = 0x400000n;
const BANK: PagingState = { cr0: 0x80000033n, cr2: 0n, cr3: 0x1000n, cr4: 0x628n, efer: 0x500n };

function put(bytes: Uint8Array, offset: number, word: bigint): void {
  for (let index = 0; index < 8; index++)
    bytes[offset + index] = Number((word >> BigInt(index * 8)) & 255n);
}

async function using(
  compiler: WebAssembly.Module,
  code: string,
  run: (cpu: Cpu) => Promise<void>,
  setup: {
    execution?: ExecutionContext;
    bank?: PagingState;
    dataLeaf?: bigint;
    nextRootCode?: string;
    translations?: number;
  } = {},
): Promise<void> {
  const tables = new Uint8Array(0x8000);
  for (const [offset, word] of [
    [0, 0x2007n],
    [0x1000, 0x3007n],
    [0x2010, 0x4007n],
    [0x3000, 0x9007n],
    [0x3800, setup.dataLeaf ?? 0xb007n],
    [0x4000, 0x6007n],
    [0x5000, 0x7007n],
    [0x6010, 0x8007n],
    [0x7000, 0xa007n],
  ] as const)
    put(tables, offset, word);
  const codePages = new Uint8Array(0x2000).fill(0x82);
  codePages.set(hex(code));
  if (setup.nextRootCode !== undefined) codePages.set(hex(setup.nextRootCode), 0x1000);
  const data = new Uint8Array(0x1000).fill(0xa5);
  const cpu = await createCpu({
    compiler,
    memoryModel: 'ia32e-paged',
    paging: setup.bank ?? BANK,
    ...(setup.execution === undefined ? {} : { context: setup.execution }),
    memory: {
      backings: [
        { id: 'tables', bytes: tables },
        { id: 'code', bytes: codePages },
        { id: 'data', bytes: data },
      ],
      mappings: [
        {
          base: 0x1000n,
          backing: 'tables',
          offset: 0,
          length: tables.length,
          permissions: { read: true, write: true, execute: false },
        },
        {
          base: 0x9000n,
          backing: 'code',
          offset: 0,
          length: codePages.length,
          permissions: { read: true, write: true, execute: true },
        },
        {
          base: 0xb000n,
          backing: 'data',
          offset: 0,
          length: data.length,
          permissions: { read: true, write: true, execute: false },
        },
      ],
    },
    memoryLimits: { maxBackings: 8, maxMappings: 12, maxBackingBytes: 0x10000 },
    limits: {
      ...LIMITS,
      maxTranslationsPerRun: setup.translations ?? LIMITS.maxTranslationsPerRun,
    },
    entry: PC,
  });
  try {
    await run(cpu);
  } finally {
    cpu.dispose();
  }
}

export function pagingControlScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'paging control guest MOVCR transfers every GPR and ignores encoded memory tails while preserving unrelated banks',
      async run() {
        for (const mode of ['long64', 'compatibility'] as const) {
          const execution: ExecutionContext =
            mode === 'long64' ? { mode, fsBase: 0n, gsBase: 0n } : context(mode);
          for (let register = 0; register < (mode === 'long64' ? 16 : 8); register++) {
            const rex = register >= 8 ? '41' : '';
            const modrm = (0x10 | (register & 7)).toString(16).padStart(2, '0');
            const code = '66' + rex + '0f20' + modrm;
            await using(
              compiler,
              code,
              async (cpu) => {
                const before = initial(PC, {}, 0x8d7n);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                equal(result.reason, 'budget', 'one CR2 read');
                equal(result.retired, 1n, 'one retirement');
                equal(result.state.rip, PC + BigInt(code.length / 2), 'only ModR/M consumed');
                same(
                  result.state.registers,
                  before.registers.map((value, index) =>
                    index === register
                      ? mode === 'long64'
                        ? 0xfedcba9876543210n
                        : (value & 0xffffffff00000000n) | 0x76543210n
                      : value,
                  ),
                  'only decoded GPR changes',
                );
                equal(result.state.flags, 0x8d7n, 'concrete arithmetic flags preserved');
                same(
                  cpu.readPagingState(),
                  { ...BANK, cr2: 0xfedcba9876543210n },
                  'CR read leaves complete bank unchanged',
                );
              },
              { execution, bank: { ...BANK, cr2: 0xfedcba9876543210n } },
            );
          }
        }
      },
    },
    {
      name: 'paging control guest register value checks distinguish architectural GP from valid deferred facilities atomically',
      async run() {
        const packets = [
          ['0f22c0', 0x180000033n, 'protection-fault'],
          ['0f22c0', 0x80000032n, 'protection-fault'],
          ['0f22c0', 0xa0000033n, 'protection-fault'],
          ['0f22c0', 0x80040033n, 'unsupported'],
          ['0f22d8', 0x8000000000000000n, 'protection-fault'],
          ['0f22d8', 0x2000000000000000n, 'unsupported'],
          ['0f22e0', 0x608n, 'protection-fault'],
          ['0f22e0', 0x1628n, 'protection-fault'],
          ['0f22e0', 0x8628n, 'protection-fault'],
          ['0f22e0', 0x620n, 'unsupported'],
          ['440f22c0', 0n, 'unsupported'],
        ] as const;
        for (const [code, value, reason] of packets)
          await using(compiler, code, async (cpu) => {
            const before = initial(PC, { 0: value }, 2n);
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, reason, `selected failure for ${code}/${value.toString(16)}`);
            equal(result.retired, 0n, 'failed control does not retire');
            equal(result.remaining, 1n, 'allowance retained');
            same(result.state.registers, before.registers, 'all GPRs retained');
            equal(result.state.rip, PC, 'faulting boundary retained');
            same(cpu.readPagingState(), BANK, 'no control publication');
          });
      },
    },
    {
      name: 'paging control EFER RDMSR clears full RAX and RDX in compatibility and WRMSR samples only low halves',
      async run() {
        for (const execution of [
          { mode: 'long64' as const, fsBase: 0n, gsBase: 0n },
          context('compatibility'),
        ]) {
          await using(
            compiler,
            '0f320f30',
            async (cpu) => {
              cpu.setState(
                initial(
                  PC,
                  { 0: 0xffffffffffffffffn, 2: 0xffffffffffffffffn, 1: 0x11223344c0000080n },
                  0x8d7n,
                ),
              );
              const read = await cpu.run({ budget: 1n });
              equal(read.reason, 'budget', 'RDMSR completes');
              equal(read.state.registers[0], 0x500n, 'RAX high half cleared');
              equal(read.state.registers[2], 0n, 'RDX high half cleared');
              equal(read.state.registers[1], 0x11223344c0000080n, 'ECX read retains full bank');
              cpu.setState(
                initial(
                  PC + 2n,
                  { 0: 0x1122334400000900n, 2: 0x5566778800000000n, 1: 0xc0000080n },
                  0x8d7n,
                ),
              );
              const before = cpu.readState();
              const write = await cpu.run({ budget: 1n });
              equal(write.reason, 'budget', 'WRMSR completes');
              same(write.state.registers, before.registers, 'WRMSR reads pair without editing it');
              equal(cpu.readPagingState().efer, 0xd00n, 'NXE enabled and read-only LMA retained');
              equal(write.state.flags, 0x8d7n, 'MSR flags preserved');
            },
            { execution },
          );
        }
      },
    },
    {
      name: 'paging control INVLPG has address-only semantics for absent pages and noncanonical long addresses',
      async run() {
        for (const address of [0x600000n, 0x800000000000n])
          await using(compiler, '0f0138', async (cpu) => {
            cpu.setState(initial(PC, { 0: address }, 0x8d7n));
            const before = cpu.readPhysicalMemory(0x1000n, 0x8000);
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'budget', 'INVLPG completes without operand translation');
            equal(result.retired, 1n, 'one completed invalidation');
            equal(result.state.rip, PC + 3n, 'successor');
            same(cpu.readPagingState(), BANK, 'CR2 and controls unchanged');
            const after = cpu.readPhysicalMemory(0x1000n, 0x8000);
            for (const index of [0, 0x1000, 0x2010, 0x3000]) before[index] = before[index]! | 0x20;
            same(after, before, 'only required code fetch sets A, no operand walk');
          });
      },
    },
    {
      name: 'paging control guest CR3 replacement invalidates native successors and resumes a private compile frontier without replay',
      async run() {
        for (const translations of [32, 1])
          await using(
            compiler,
            '0f22db48ffc082',
            async (cpu) => {
              cpu.setState(initial(PC, { 0: 0x1122334455667788n, 3: 0x5000n }, 2n));
              let result = await cpu.run({ budget: 2n });
              if (translations === 1) {
                equal(result.reason, 'resource-limit', 'new-root compile yields');
                equal(result.retired, 1n, 'CR3 writer completes once');
                equal(result.state.rip, PC + 3n, 'new root starts at successor');
                equal(cpu.readPagingState().cr3, 0x5000n, 'writer remains committed');
                result = await cpu.run({ budget: 1n });
              }
              equal(result.reason, 'budget', 'completed HLT reaches final budget gate');
              equal(result.state.event.kind, 'halted', 'new root successor is HLT');
              equal(result.state.rip, PC + 4n, 'new encoding consumed');
              equal(
                result.state.registers[0],
                0x1122334455667788n,
                'old native INC never executes',
              );
              equal(cpu.readPagingState().cr3, 0x5000n, 'new authority retained');
              same(
                cpu.readPhysicalMemory(0x9000n, 7),
                hex('0f22db48ffc082'),
                'old root code unchanged',
              );
            },
            { nextRootCode: '828282f482', translations },
          );
      },
    },
    {
      name: 'paging control guest WP change takes effect before the next store and host bank repair preserves its frozen PF',
      async run() {
        await using(
          compiler,
          '0f22c0890f',
          async (cpu) => {
            cpu.setState(initial(PC, { 0: 0x80010033n, 1: 0xaabbccddn, 7: 0x500000n }, 2n));
            const result = await cpu.run({ budget: 2n, eventDelivery: { budget: 0n } });
            equal(result.reason, 'event-budget', 'store PF selected after completed WP writer');
            equal(result.retired, 1n, 'only writer retires');
            check(result.state.event.kind === 'pending', 'PF retained');
            equal(result.state.event.exception.vector, 14, 'paging producer');
            equal(result.state.event.exception.errorCode, 3, 'supervisor write protection');
            equal(cpu.readPagingState().cr2, 0x500000n, 'fault address published');
            same(
              cpu.readPhysicalMemory(0xb000n, 4),
              hex('a5a5a5a5'),
              'denied store has no payload',
            );
            cpu.setPagingState({ ...cpu.readPagingState(), cr0: 0x80000033n });
            same(cpu.readState(), result.state, 'bank repair preserves exact accepted PF');
            const ready = { ...result.state, event: { kind: 'ready' as const } };
            cpu.setState(ready);
            const retry = await cpu.run({ budget: 1n });
            equal(retry.reason, 'budget', 'WP0 supervisor write retries');
            equal(retry.retired, 1n, 'store completes once');
            same(
              cpu.readPhysicalMemory(0xb000n, 4),
              hex('ddccbbaa'),
              'literal little-endian payload',
            );
            equal(cpu.readPagingState().cr2, 0x500000n, 'successful retry does not rewrite CR2');
          },
          { dataLeaf: 0xb005n },
        );
      },
    },
  ];
}
