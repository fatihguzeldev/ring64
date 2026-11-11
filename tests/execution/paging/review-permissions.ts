import { createCpu } from '../../../host/index.js';
import { LIMITS } from '../../support/fixture.js';
import { snapshot } from '../far-control/fixture.js';
import {
  BANK,
  PC,
  usingPaged,
  word,
  little,
  hex,
  initial,
  equal,
  same,
  type Scenario,
  type Cpu,
} from './fixture.js';

const DATA = 0x8000500000n;

async function hierarchy(
  compiler: WebAssembly.Module,
  level: number,
  bits: bigint,
  code: string,
  cpl: number,
  wp: boolean,
  run: (cpu: Cpu) => Promise<void>,
  leaf = 0xa007n,
  nxe = false,
): Promise<void> {
  const entries = [0x5007n, 0x6007n, 0x7007n];
  entries[level] = bits;
  const pdpt = new Uint8Array(0x1000);
  pdpt.set(little([entries[1]!]));
  const pd = new Uint8Array(0x1000);
  pd.set(little([entries[2]!]), 16);
  const pt = new Uint8Array(0x1000);
  pt.set(little([leaf]), 0x800);
  const data = new Uint8Array(0x1000).fill(0xa5);
  data.set(little([0x1122334455667788n]));
  if (nxe) data[0] = 0x90;
  const execution = snapshot();
  execution.cpl = cpl;
  await usingPaged(
    compiler,
    {
      code,
      context: execution,
      bank: { ...BANK, cr0: wp ? 0x80010033n : 0x80000033n, efer: nxe ? 0xd00n : 0x500n },
      words: [[0x1008n, entries[0]!]],
      spans: [
        { physical: 0x5000n, bytes: pdpt },
        { physical: 0x6000n, bytes: pd },
        { physical: 0x7000n, bytes: pt },
        { physical: 0xa000n, bytes: data, execute: true },
      ],
    },
    run,
  );
}

export function pagingPermissionReviewScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'paging permissions every nonleaf RW participates while supervisor WP0 and reads retain their defined exemptions',
      async run() {
        for (let level = 0; level < 3; level++)
          for (const [cpl, wp, write, expected] of [
            [3, true, true, 7],
            [0, true, true, 3],
            [0, false, true, null],
            [3, true, false, null],
          ] as const) {
            const denied = [0x5005n, 0x6005n, 0x7005n][level]!;
            await hierarchy(
              compiler,
              level,
              denied,
              write ? '488907' : '488b07',
              cpl,
              wp,
              async (cpu) => {
                const before = initial(PC, { 0: 0xaabbccddn, 7: DATA }, 2n);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                equal(
                  result.reason,
                  expected === null ? 'budget' : 'page-fault',
                  `RW level${level}/cpl${cpl}/WP${wp}`,
                );
                equal(
                  result.retired,
                  expected === null ? 1n : 0n,
                  'one complete access or exact fault',
                );
                if (expected !== null) {
                  equal(result.pageFault?.errorCode, expected, 'literal hierarchical RW error');
                  equal(cpu.readPagingState().cr2, DATA, 'operand fault address');
                  same(result.state.registers, before.registers, 'no destination publication');
                } else if (!write)
                  equal(result.state.registers[0], 0x1122334455667788n, 'RW0 is readable');
                equal(
                  word(cpu, 0x7800n),
                  write && expected === null ? 0xa067n : 0xa027n,
                  'valid leaf visited before permission result, D only on actual store',
                );
                same(
                  cpu.readPhysicalMemory(0xa000n, 8),
                  little([write && expected === null ? 0xaabbccddn : 0x1122334455667788n]),
                  'literal payload or complete guard',
                );
              },
            );
          }
      },
    },
    {
      name: 'paging permissions every nonleaf US controls user access while supervisor accesses remain admitted',
      async run() {
        for (let level = 0; level < 3; level++)
          for (const [cpl, write, expected] of [
            [3, false, 5],
            [3, true, 7],
            [0, false, null],
            [0, true, null],
          ] as const) {
            await hierarchy(
              compiler,
              level,
              [0x5003n, 0x6003n, 0x7003n][level]!,
              write ? '488907' : '488b07',
              cpl,
              true,
              async (cpu) => {
                const before = initial(PC, { 0: 0xaabbccddn, 7: DATA }, 2n);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                equal(
                  result.reason,
                  expected === null ? 'budget' : 'page-fault',
                  `US level${level}/cpl${cpl}`,
                );
                equal(result.retired, expected === null ? 1n : 0n, 'whole access');
                if (expected !== null) {
                  equal(result.pageFault?.errorCode, expected, 'literal user protection error');
                  same(result.state.registers, before.registers, 'no denied result');
                }
                equal(
                  word(cpu, 0x7800n),
                  write && expected === null ? 0xa067n : 0xa027n,
                  'lower valid leaf actually visited',
                );
              },
            );
          }
      },
    },
    {
      name: 'paging permissions every nonleaf XD blocks user and supervisor instruction fetch with frozen NXE error classification',
      async run() {
        for (let level = 0; level < 3; level++)
          for (const cpl of [0, 3])
            await hierarchy(
              compiler,
              level,
              [0x5007n, 0x6007n, 0x7007n][level]! | (1n << 63n),
              '90',
              cpl,
              true,
              async (cpu) => {
                cpu.setState(initial(DATA, {}, 0x10002n));
                const result = await cpu.run({ budget: 1n });
                equal(result.reason, 'page-fault', `XD level${level}/cpl${cpl}`);
                equal(result.pageFault?.errorCode, cpl === 3 ? 21 : 17, 'literal NX fetch error');
                equal(result.retired, 0n, 'no instruction begin');
                equal(result.state.flags, 0x10002n, 'required fetch preserves RF');
                equal(cpu.readPagingState().cr2, DATA, 'fetch linear address');
                equal(word(cpu, 0x7800n), 0xa027n, 'leaf A precedes aggregate XD fault');
              },
              0xa007n,
              true,
            );
      },
    },
    {
      name: 'paging permissions lower controlling nonpresent and reserved entries win before upper US denial',
      async run() {
        for (let level = 0; level < 3; level++)
          for (const [leaf, error] of [
            [0x8000000000000000n, 4],
            [0x800000000000a007n, 13],
          ] as const)
            await hierarchy(
              compiler,
              level,
              [0x5003n, 0x6003n, 0x7003n][level]!,
              '488b07',
              3,
              true,
              async (cpu) => {
                const before = initial(PC, { 7: DATA }, 2n);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                equal(result.reason, 'page-fault', 'architectural controlling entry');
                equal(
                  result.pageFault?.errorCode,
                  error,
                  'lower P0/RSVD classification precedes aggregate U/S',
                );
                equal(result.retired, 0n, 'no result');
                same(result.state.registers, before.registers, 'all banks retained');
                equal(word(cpu, 0x7800n), leaf, 'invalid controlling leaf does not acquire A');
              },
              leaf,
            );
      },
    },
    {
      name: 'paging permissions warm code PTE remap cannot reuse its original physical encoding',
      async run() {
        await usingPaged(
          compiler,
          { code: '90', spans: [{ physical: 0xa000n, bytes: hex('f482'), execute: true }] },
          async (cpu) => {
            cpu.setState(initial(PC, {}, 2n));
            equal((await cpu.run({ budget: 1n })).reason, 'budget', 'warm old NOP');
            cpu.writePhysicalMemory(0x4000n, little([0xa027n]));
            cpu.setState(initial(PC, {}, 2n));
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'budget', 'post-HLT final budget gate');
            equal(result.retired, 1n, 'one new instruction');
            equal(result.state.event.kind, 'halted', 'new PTE selects HLT, not old NOP');
            equal(result.state.rip, PC + 1n, 'new one-byte instruction');
            same(
              cpu.readPhysicalMemory(0x9000n, 1),
              hex('90'),
              'old physical bytes remain unchanged',
            );
          },
        );
      },
    },
    {
      name: 'paging permissions native REP abandons changed STOSD after one D alias and never replays a completed element',
      async run() {
        const tables = new Uint8Array(0x4000);
        for (const [physical, entry] of [
          [0x1000, 0x2027n],
          [0x2000, 0x3027n],
          [0x3010, 0x4027n],
          [0x4000, 0x9027n],
          [0x4800, 0xa0abn],
        ] as const)
          tables.set(little([entry]), physical - 0x1000);
        const cpu = await createCpu({
          compiler,
          memoryModel: 'ia32e-paged',
          paging: BANK,
          entry: PC,
          memory: {
            backings: [
              { id: 'tables', bytes: tables },
              { id: 'prefix', bytes: hex('f300') },
              { id: 'data', bytes: new Uint8Array(8).fill(0xa5) },
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
                base: 0x9000n,
                backing: 'prefix',
                offset: 0,
                length: 1,
                permissions: { read: true, write: true, execute: true },
              },
              {
                base: 0x9001n,
                backing: 'tables',
                offset: 0x3800,
                length: 1,
                permissions: { read: true, write: true, execute: true },
              },
              {
                base: 0x9002n,
                backing: 'prefix',
                offset: 1,
                length: 1,
                permissions: { read: true, write: true, execute: true },
              },
              {
                base: 0xa000n,
                backing: 'data',
                offset: 0,
                length: 8,
                permissions: { read: true, write: true, execute: false },
              },
            ],
          },
          memoryLimits: { maxBackings: 3, maxMappings: 5, maxBackingBytes: 0x5000 },
          limits: LIMITS,
        });
        try {
          cpu.setState(initial(PC, { 0: 0x11223344n, 1: 2n, 7: 0x500000n }, 2n));
          const result = await cpu.run({ budget: 1n, repeatBudget: 2n });
          equal(result.reason, 'unsupported', 'D sets AB to EB, F3 JMP remains unadmitted');
          equal(result.retired, 0n, 'old REP never finishes');
          equal(result.repeatIterations, 1n, 'one completed old-form element');
          equal(result.state.registers[1], 1n, 'unconsumed count retained');
          equal(result.state.registers[7], 0x500004n, 'index advances once');
          same(
            cpu.readPhysicalMemory(0xa000n, 8),
            hex('44332211a5a5a5a5'),
            'completed first element only',
          );
          equal(word(cpu, 0x4800n), 0xa0ebn, 'actual D publication changed executable alias');
          equal(result.state.rip, PC, 'changed instruction is reprobed at REP boundary');
        } finally {
          cpu.dispose();
        }
      },
    },
  ];
}
