import type { Cpu, ExecutionContextSnapshot, FastSystemState } from '../../../host/index.js';
import { longSnapshot } from '../../support/context.js';
import {
  BANK,
  PC,
  check,
  equal,
  hex,
  initial,
  little,
  same,
  usingPaged,
  word,
  type Scenario,
} from '../paging/fixture.js';

const roots = [
  [0x1000n, 0x2027n],
  [0x1800n, 0x2027n],
  [0x2000n, 0x3027n],
  [0x3010n, 0x4027n],
  [0x4000n, 0x9063n],
] as const;
const empty: FastSystemState = {
  star: 0n,
  lstar: 0n,
  fmask: 0n,
  sysenterCs: 0n,
  sysenterEip: 0n,
  sysenterEsp: 0n,
  kernelGsBase: 0n,
};
function bytesHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}
function wrmsr(index: bigint, value: bigint): string {
  return `b9${bytesHex(little([index], 4))}b8${bytesHex(little([value], 4))}ba${bytesHex(little([value >> 32n], 4))}0f30`;
}
function caches(
  context: ExecutionContextSnapshot,
  mode: 'long64' | 'compatibility',
  cpl: number,
  cs: number,
  ss: number,
): void {
  equal(context.mode, mode, 'synthetic execution mode');
  equal(context.cpl, cpl, 'synthetic CPL');
  const common = {
    base: 0n,
    limit: 0xffffffff,
    usable: true,
    dpl: cpl,
    present: true,
    conforming: false,
    accessed: true,
    granularity: true,
    available: false,
  };
  same(
    context.segments.cs,
    {
      ...common,
      selector: cs,
      type: 'readable-code',
      default32: mode === 'compatibility',
      long: mode === 'long64',
    },
    'complete synthetic CS',
  );
  same(
    context.segments.ss,
    { ...common, selector: ss, type: 'read-write', default32: true, long: false },
    'complete synthetic SS',
  );
}
function otherSegments(context: ExecutionContextSnapshot) {
  const { ds, es, fs, gs } = context.segments;
  return {
    ds,
    es,
    fs,
    gs,
    gdtr: context.gdtr,
    idtr: context.idtr,
    ldtr: context.ldtr,
    tr: context.tr,
  };
}
function numeric(cpu: Cpu) {
  return { xmm: cpu.readXmmState(), x87: cpu.readX87State(), mxcsr: cpu.readMxcsr() };
}

export function fastTransferScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'fast-system guest WRMSR and IRET establish a complete GS-stack SYSCALL SYSRET64 round trip',
      async run() {
        const context = longSnapshot(0n, 0x406000n);
        context.gdtr = { base: 0x405000n, limit: 55 };
        for (const name of ['fs', 'gs'] as const) {
          context.segments[name].selector = 0x2b;
          context.segments[name].dpl = 3;
        }
        const gdt = new Uint8Array(0x1000);
        gdt.set(
          hex(
            '0000000000000000ffff0000009baf00ffff00000093cf0000000000000000000000000000000000ffff000000f3cf00ffff000000fbaf00',
          ),
        );
        const data = new Uint8Array(0x1000).fill(0xa5);
        data.set(little([0x404f00n]), 8);
        data.set(little([0x402000n, 0x33n, 0x202n, 0x403ff0n, 0x2bn]), 0xfc0);
        const setup =
          wrmsr(0xc0000080n, 0x501n) +
          wrmsr(0xc0000081n, 0x0020000800000000n) +
          wrmsr(0xc0000082n, 0x401000n) +
          wrmsr(0xc0000084n, 0x300n) +
          wrmsr(0x174n, 8n) +
          wrmsr(0x175n, 0x404f00n) +
          wrmsr(0x176n, 0x401000n) +
          wrmsr(0xc0000102n, 0x404000n) +
          wrmsr(0xc0000101n, 0x406000n) +
          '48cf';
        const kernel = hex(
          '0f01f865488924250000000065488b242508000000505865c70425100000007856341265488b2425000000000f01f8480f07',
        );
        await usingPaged(
          compiler,
          {
            code: setup,
            context,
            words: [
              ...roots,
              [0x4008n, 0xa063n],
              [0x4010n, 0xb067n],
              [0x4018n, 0xc067n],
              [0x4020n, 0xd063n],
              [0x4028n, 0xe063n],
              [0x4030n, 0xf067n],
            ],
            spans: [
              { physical: 0xa000n, bytes: kernel, execute: true },
              { physical: 0xb000n, bytes: hex('0f0590'), execute: true },
              { physical: 0xc000n, bytes: new Uint8Array(0x1000).fill(0x5a) },
              { physical: 0xd000n, bytes: data },
              { physical: 0xe000n, bytes: gdt },
              { physical: 0xf000n, bytes: new Uint8Array(0x1000).fill(0x3c) },
            ],
          },
          async (cpu) => {
            cpu.setState(initial(PC, { 4: 0x404fc0n }, 0x202n));
            cpu.setXmmState(Array.from({ length: 16 }, (_, i) => (1n << 100n) + BigInt(i)));
            const numericBefore = numeric(cpu);
            const entered = await cpu.run({ budget: 128n, stop: 0x402000n });
            equal(entered.reason, 'stop', 'guest setup reaches its user instruction');
            equal(entered.retired, 37n, 'nine complete WRMSR configurations plus IRET');
            caches(cpu.readContext(), 'long64', 3, 0x33, 0x2b);
            const user = cpu.readState();
            const userContext = cpu.readContext();
            const guardedFrame = cpu.readPhysicalMemory(0xdf00n, 0x100);
            const result = await cpu.run({ budget: 64n, stop: 0x402002n });
            equal(result.reason, 'stop', 'return reaches literal user successor');
            equal(result.retired, 10n, 'one entry and nine guest kernel instructions');
            same(
              result.state.registers,
              user.registers.map((value, index) =>
                index === 1 ? 0x402002n : index === 11 ? 0x202n : value,
              ),
              'only RCX/R11 architectural entry saves change GPRs',
            );
            equal(result.state.flags, 0x202n, 'user flags restored');
            caches(cpu.readContext(), 'long64', 3, 0x33, 0x2b);
            same(
              otherSegments(cpu.readContext()),
              otherSegments(userContext),
              'other loaded authority restored',
            );
            equal(word(cpu, 0xd000n), 0x403ff0n, 'guest saves its user stack through kernel GS');
            equal(word(cpu, 0xd008n), 0x404f00n, 'kernel stack source preserved');
            equal(word(cpu, 0xd010n), 0xa5a5a5a512345678n, 'guarded kernel operation committed');
            equal(word(cpu, 0xdef8n), 0x406000n, 'PUSH uses the actual GS-loaded kernel stack');
            same(
              cpu.readPhysicalMemory(0xc000n, 0x1000),
              new Uint8Array(0x1000).fill(0x5a),
              'guest kernel stack work never touches the user stack',
            );
            same(
              cpu.readPhysicalMemory(0xdf00n, 0x100),
              guardedFrame,
              'no implicit fast-transfer frames',
            );
            same(numeric(cpu), numericBefore, 'numeric handover preserves every bank');
            same(
              cpu.readFastSystemState(),
              {
                star: 0x0020000800000000n,
                lstar: 0x401000n,
                fmask: 0x300n,
                sysenterCs: 8n,
                sysenterEip: 0x401000n,
                sysenterEsp: 0x404f00n,
                kernelGsBase: 0x404000n,
              },
              'guest-programmed bank survives both GS exchanges',
            );
            equal(cpu.readPagingState().efer, 0x501n, 'guest enabled SCE');
          },
        );
      },
    },
    {
      name: 'fast-system SYSENTER from all IA32e code sizes uses full pointers and SYSEXIT selects only 32 or 64 bit returns',
      async run() {
        for (const source of ['long64', 'compatibility16', 'compatibility32'] as const)
          for (const wide of [false, true]) {
            const context = longSnapshot();
            context.cpl = 3;
            context.segments.cs.selector = 0x33;
            context.segments.ss.selector = 0x2b;
            for (const segment of Object.values(context.segments)) segment.dpl = 3;
            if (source !== 'long64') {
              context.mode = 'compatibility';
              context.segments.cs.long = false;
              context.segments.cs.default32 = source === 'compatibility32';
            }
            await usingPaged(
              compiler,
              {
                code: '0f34',
                context,
                words: [...roots, [0x4000n, 0x9067n], [0x4008n, 0xa063n], [0x4010n, 0xb067n]],
                spans: [
                  { physical: 0xa000n, bytes: hex(wide ? '480f35' : '6667640f35'), execute: true },
                  { physical: 0xb000n, bytes: hex('90'), execute: true },
                ],
              },
              async (cpu) => {
                cpu.setFastSystemState({
                  ...empty,
                  sysenterCs: 8n,
                  sysenterEip: 0xffff800000401000n,
                  sysenterEsp: 0xffff800000403ff0n,
                });
                const before = initial(
                  PC,
                  { 1: 0xffff800000404ff0n, 2: 0xffff800000402000n, 4: 0x1234567880000400n },
                  0xad7n,
                );
                cpu.setState(before);
                const entry = await cpu.run({ budget: 1n });
                equal(entry.reason, 'budget', `${source} entry`);
                equal(entry.retired, 1n, 'one SYSENTER');
                equal(
                  entry.state.rip,
                  0xffff800000401000n,
                  'full SYSENTER RIP in every source submode',
                );
                equal(entry.state.registers[4], 0xffff800000403ff0n, 'full SYSENTER RSP');
                equal(entry.state.flags, 0x8d7n, 'only IF cleared');
                same(
                  entry.state.registers,
                  before.registers.map((v, i) => (i === 4 ? 0xffff800000403ff0n : v)),
                  'entry saves no return GPR',
                );
                caches(cpu.readContext(), 'long64', 0, 8, 16);
                const returned = await cpu.run({ budget: 1n });
                equal(returned.reason, 'budget', 'one successful SYSEXIT');
                equal(returned.retired, 1n, 'one SYSEXIT');
                equal(
                  returned.state.rip,
                  wide ? 0xffff800000402000n : 0x402000n,
                  'selected return RIP width',
                );
                equal(
                  returned.state.registers[4],
                  wide ? 0xffff800000404ff0n : 0x404ff0n,
                  'selected return RSP width',
                );
                equal(returned.state.flags, 0x8d7n, 'return preserves arithmetic and system flags');
                same(
                  returned.state.registers,
                  before.registers.map((v, i) =>
                    i === 4 ? (wide ? 0xffff800000404ff0n : 0x404ff0n) : v,
                  ),
                  'return consumes but preserves RCX/RDX',
                );
                caches(
                  cpu.readContext(),
                  wide ? 'long64' : 'compatibility',
                  3,
                  wide ? 0x2b : 0x1b,
                  wide ? 0x33 : 0x23,
                );
                equal(cpu.readPagingState().efer, 0x500n, 'SCE0 never disables SYSENTER pair');
                const first = await cpu.run({ budget: 1n });
                equal(
                  first.reason,
                  'budget',
                  'actual destination NOP executes under returned context',
                );
                equal(
                  first.state.rip,
                  (wide ? 0xffff800000402000n : 0x402000n) + 1n,
                  'destination fetch commits once',
                );
              },
            );
          }
      },
    },
    {
      name: 'fast-system SYSRET32 restores literal flag mask while preserving full RSP and inappropriate data caches',
      async run() {
        const context = longSnapshot(0xffff800000406000n, 0xffff800000407000n);
        await usingPaged(
          compiler,
          { code: '6667640f07', context, bank: { ...BANK, efer: 0x501n }, words: roots },
          async (cpu) => {
            cpu.setFastSystemState({ ...empty, star: 0x0020000800000000n });
            const before = initial(
              PC,
              { 1: 0x1122334400402000n, 4: 0x1234567880000400n, 11: 0xfffffffffffffeffn },
              2n,
            );
            cpu.setState(before);
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'budget', 'redundant66 does not invent a 16-bit return');
            equal(result.retired, 1n, 'one SYSRET');
            equal(result.state.rip, 0x402000n, 'only ECX enters compatibility RIP');
            equal(
              result.state.flags,
              0x3c7ed7n,
              'literal R11 mask clears RF VM reserved bits and TF remains0',
            );
            same(
              result.state.registers,
              before.registers,
              'SYSRET does not touch any GPR or truncate RSP',
            );
            caches(cpu.readContext(), 'compatibility', 3, 0x23, 0x2b);
            same(
              otherSegments(cpu.readContext()),
              otherSegments(context),
              'no IRET-style data segment invalidation',
            );
          },
        );
      },
    },
    {
      name: 'fast-system synthetic cache selectors preserve raw STAR SS TI null and wrapping outcomes without metadata access',
      async run() {
        const packets = [
          {
            code: '0f05',
            star: 0x0020000300000000n,
            entry: 0n,
            mode: 'long64',
            cpl: 0,
            cs: 0,
            ss: 11,
          },
          {
            code: '0f05',
            star: 0x0020ffff00000000n,
            entry: 0n,
            mode: 'long64',
            cpl: 0,
            cs: 0xfffc,
            ss: 7,
          },
          { code: '0f07', star: 0n, entry: 0n, mode: 'compatibility', cpl: 3, cs: 3, ss: 11 },
          {
            code: '480f07',
            star: 0xfff0000800000000n,
            entry: 0n,
            mode: 'long64',
            cpl: 3,
            cs: 3,
            ss: 0xfffb,
          },
          { code: '0f34', star: 0n, entry: 0x12340005n, mode: 'long64', cpl: 0, cs: 4, ss: 12 },
          {
            code: '0f35',
            star: 0n,
            entry: 0x1234fff5n,
            mode: 'compatibility',
            cpl: 3,
            cs: 7,
            ss: 15,
          },
          { code: '480f35', star: 0n, entry: 0x1234fff5n, mode: 'long64', cpl: 3, cs: 23, ss: 31 },
        ] as const;
        for (const packet of packets) {
          const context = longSnapshot();
          context.gdtr = { base: 0xffff800000100000n, limit: 0xffff };
          context.idtr = { base: 0xffff800000200000n, limit: 0xffff };
          await usingPaged(
            compiler,
            { code: packet.code, context, words: roots, bank: { ...BANK, efer: 0x501n } },
            async (cpu) => {
              cpu.setFastSystemState({
                ...empty,
                star: packet.star,
                sysenterCs: packet.entry,
                lstar: 0x402000n,
                sysenterEip: 0x402000n,
                sysenterEsp: 0x404000n,
              });
              cpu.setState(
                initial(PC, { 1: 0x402000n, 2: 0x402000n, 4: 0x800000000000n, 11: 0x202n }, 0x202n),
              );
              const tableBytes = cpu.readPhysicalMemory(0x1000n, 0x4000);
              const result = await cpu.run({ budget: 1n });
              equal(
                result.reason,
                'budget',
                `${packet.code} commits without target or stack access`,
              );
              equal(result.retired, 1n, 'one synthetic transfer');
              equal(result.state.rip, 0x402000n, 'unmapped target accepted before next fetch');
              caches(cpu.readContext(), packet.mode, packet.cpl, packet.cs, packet.ss);
              same(
                result.state.interruptibility,
                { sti: false, ss: false },
                'synthetic SS never arms inhibition',
              );
              same(result.state.event, { kind: 'ready' }, 'no fake event source');
              same(
                cpu.readPhysicalMemory(0x1000n, 0x4000),
                tableBytes,
                'no descriptor or stack metadata write',
              );
              equal(cpu.readPagingState().cr2, 0n, 'no target preflight PF');
            },
          );
        }
      },
    },
    {
      name: 'fast-system straight-line WRMSR FS consumer and SWAPGS GS store terminate stale native base assumptions',
      async run() {
        const context = longSnapshot(0x404000n, 0x406000n);
        const old = new Uint8Array(0x1000).fill(0x11);
        const fresh = new Uint8Array(0x1000).fill(0x88);
        const gs = new Uint8Array(0x1000).fill(0x22);
        fresh.set(little([0x8877665544332211n]), 0x100);
        await usingPaged(
          compiler,
          {
            code: '0f3064488b0348ffc00f01f865488903',
            context,
            words: [...roots, [0x4020n, 0xd063n], [0x4028n, 0xe063n], [0x4030n, 0xf063n]],
            spans: [
              { physical: 0xd000n, bytes: old },
              { physical: 0xe000n, bytes: fresh },
              { physical: 0xf000n, bytes: gs },
            ],
          },
          async (cpu) => {
            cpu.setFastSystemState({ ...empty, kernelGsBase: 0x405000n });
            cpu.setState(initial(PC, { 0: 0x404000n, 1: 0xc0000100n, 2: 0n, 3: 0x100n }, 2n));
            const warm = await cpu.run({ budget: 2n });
            equal(warm.reason, 'budget', 'warm successor at old FS base');
            equal(warm.state.registers[0], 0x1111111111111111n, 'old base warm oracle');
            cpu.setState(initial(PC, { 0: 0x405000n, 1: 0xc0000100n, 2: 0n, 3: 0x100n }, 2n));
            const result = await cpu.run({ budget: 5n });
            equal(result.reason, 'budget', 'all writer and consumer instructions complete');
            equal(result.retired, 5n, 'five instructions without host intervention');
            equal(result.state.rip, PC + 16n, 'literal straight-line successor');
            equal(result.state.registers[0], 0x8877665544332212n, 'new FS payload incremented');
            equal(word(cpu, 0xe100n), 0x8877665544332212n, 'new GS base receives the actual store');
            same(cpu.readPhysicalMemory(0xd000n, 0x1000), old, 'old FS region guarded');
            same(cpu.readPhysicalMemory(0xf000n, 0x1000), gs, 'old GS region guarded');
            equal(cpu.readContext().segments.fs.base, 0x405000n, 'WRMSR context authority');
            equal(cpu.readContext().segments.gs.base, 0x405000n, 'SWAPGS context authority');
            equal(cpu.readFastSystemState().kernelGsBase, 0x406000n, 'old GS bank authority');
            cpu.setState(initial(PC + 2n, { 3: 0x100n }, 2n));
            const middle = await cpu.run({ budget: 1n });
            equal(
              middle.state.registers[0],
              0x8877665544332212n,
              'retained middle entry sees updated FS base',
            );
          },
        );
      },
    },
    {
      name: 'fast-system compatibility FS base keeps full MSR readback while using only its low32 effective address',
      async run() {
        const context = longSnapshot(0xffff800000404000n);
        context.mode = 'compatibility';
        context.segments.cs.long = false;
        context.segments.cs.default32 = true;
        await usingPaged(
          compiler,
          {
            code: '0f30648b030f32',
            context,
            words: [...roots, [0x4028n, 0xe063n]],
            spans: [
              {
                physical: 0xe000n,
                bytes: Uint8Array.from({ length: 0x104 }, (_, i) =>
                  i >= 0x100 ? [0xef, 0xcd, 0xab, 0x89][i - 0x100]! : 0xa5,
                ),
              },
            ],
          },
          async (cpu) => {
            cpu.setState(
              initial(
                PC,
                {
                  0: 0x1122334400405000n,
                  1: 0x88776655c0000100n,
                  2: 0x12345678ffff8000n,
                  3: 0x100n,
                },
                2n,
              ),
            );
            const load = await cpu.run({ budget: 2n });
            equal(load.reason, 'budget', 'WRMSR plus FS operand complete');
            equal(
              load.state.registers[0],
              0x1122334489abcdefn,
              'legacy GPR upper bank and low32 base rule',
            );
            equal(
              cpu.readContext().segments.fs.base,
              0xffff800000405000n,
              'full stored FS base survives compatibility',
            );
            const read = await cpu.run({ budget: 1n });
            equal(read.reason, 'budget', 'MSR read completes');
            equal(read.state.registers[0], 0x405000n, 'RDMSR clears all RAX high32');
            equal(
              read.state.registers[2],
              0xffff8000n,
              'RDMSR returns the stored high base and clears RDX high32',
            );
          },
        );
      },
    },
    {
      name: 'fast-system descriptor and null FS reloads replace the same base authority observed by RDMSR',
      async run() {
        for (const mode of ['long64', 'compatibility'] as const) {
          const context = longSnapshot(0xffff800000404000n);
          context.mode = mode;
          context.segments.cs.long = mode === 'long64';
          context.segments.cs.default32 = mode === 'compatibility';
          context.gdtr = { base: 0x405000n, limit: 31 };
          const gdt = new Uint8Array(32);
          gdt.set(hex('ffff00604093cf00'), 24);
          await usingPaged(
            compiler,
            {
              code: '8ee00f32',
              context,
              words: [...roots, [0x4028n, 0xe063n]],
              spans: [{ physical: 0xe000n, bytes: gdt }],
            },
            async (cpu) => {
              cpu.setState(
                initial(PC, { 0: 0x1122334400000018n, 1: 0xc0000100n, 2: 0xffffffffffffffffn }, 2n),
              );
              const loaded = await cpu.run({ budget: 2n });
              equal(loaded.reason, 'budget', 'descriptor FS reload and RDMSR');
              equal(
                loaded.state.registers[0],
                0x406000n,
                'descriptor base low32 replaces former MSR base',
              );
              equal(loaded.state.registers[2], 0n, 'descriptor base high32 is zero');
              equal(
                cpu.readContext().segments.fs.base,
                0x406000n,
                'context shares descriptor-loaded base',
              );
              cpu.setState(initial(PC, { 0: 0n, 1: 0xc0000100n, 2: 0xffffffffffffffffn }, 2n));
              const nulled = await cpu.run({ budget: 2n });
              equal(nulled.reason, 'budget', 'null FS reload and RDMSR');
              equal(
                nulled.state.registers[0],
                0n,
                'null cache base replaces former descriptor base',
              );
              equal(nulled.state.registers[2], 0n, 'no stale high base survives');
              equal(
                cpu.readContext().segments.fs.usable,
                false,
                'predecessor normalized null cache retained',
              );
              check(
                cpu.readContext().segments.fs.selector === 0,
                'visible null selector preserved',
              );
            },
          );
        }
      },
    },
  ];
}
