import {
  changed,
  check,
  equal,
  hex,
  initial,
  little,
  longSnapshot,
  noCompilation,
  preserveNumeric,
  same,
  type Factory,
  type Scenario,
} from './fixture.js';
import { LIMITS } from '../../support/fixture.js';
import type { ExecutionContextSnapshot, FastSystemState } from '../../../host/index.js';

export const USER = 0x400000n,
  KERNEL = 0x401000n,
  USER_SP = 0x403ff0n,
  KERNEL_SP = 0x404ff0n;
export const FAST: FastSystemState = {
  star: 0x0020000800000000n,
  lstar: KERNEL,
  fmask: 0x200n,
  sysenterCs: 8n,
  sysenterEip: KERNEL,
  sysenterEsp: KERNEL_SP,
  kernelGsBase: 0n,
};
export const FAST_FORMS = [
  { kind: 'syscall', user: '0f0549ffc875f9', kernel: '480f07', instructions: 4 },
  {
    kind: 'sysret32',
    user: '0f344b75fb',
    kernel: 'b90200400041bb0202000048bcf03f4000000000000f07',
    instructions: 7,
  },
  { kind: 'sysexit32', user: '0f344b75fb', kernel: '0f35', instructions: 4 },
  { kind: 'sysexit64', user: '0f3449ffc875f9', kernel: '480f35', instructions: 4 },
  {
    kind: 'gs',
    user: '0f0549ffc875f9',
    kernel:
      '0f01f865488924250000000065488b24250800000050586548ff04251000000065488b2425000000000f01f8480f07',
    instructions: 12,
  },
] as const;
export type FastForm = (typeof FAST_FORMS)[number];

export function fastSetup(compiler: WebAssembly.Module, form: FastForm) {
  const ram = new Uint8Array(0x12000).fill(0xa5);
  ram.fill(0, 0x1000, 0x5000);
  for (const [at, value] of [
    [0x1000, 0x2027n],
    [0x2000, 0x3027n],
    [0x3010, 0x4027n],
    [0x4000, 0x9067n],
    [0x4008, 0xa063n],
    [0x4018, 0xc067n],
    [0x4020, 0xd063n],
    [0x4028, 0xe063n],
  ] as const)
    ram.set(little(value), at);
  ram.fill(0x82, 0x9000, 0xb000);
  ram.set(hex(form.user), 0x9000);
  ram.set(hex(form.kernel), 0xa000);
  ram.set(hex('0f30'), 0xa100);
  ram.set(little(KERNEL_SP), 0xe008);
  ram.set(little(0n), 0xe010);
  const user = longSnapshot(0n, 0x409000n);
  user.cpl = 3;
  for (const [name, segment] of Object.entries(user.segments)) {
    segment.dpl = 3;
    segment.selector = name === 'cs' ? 0x33 : 0x2b;
  }
  if (form.kind === 'sysret32' || form.kind === 'sysexit32') {
    user.mode = 'compatibility';
    user.segments.cs.long = false;
    user.segments.cs.default32 = true;
    user.segments.cs.selector = form.kind === 'sysexit32' ? 0x1b : 0x23;
    user.segments.ss.selector = form.kind === 'sysexit32' ? 0x23 : 0x2b;
  } else if (form.kind === 'sysexit64') {
    user.segments.cs.selector = 0x2b;
    user.segments.ss.selector = 0x33;
  }
  const kernel: ExecutionContextSnapshot = {
    ...user,
    mode: 'long64',
    cpl: 0,
    segments: {
      ...user.segments,
      cs: { ...user.segments.cs, selector: 8, dpl: 0, default32: false, long: true },
      ss: { ...user.segments.ss, selector: 16, dpl: 0 },
    },
  };
  const paging = { cr0: 0x80010033n, cr2: 0xdeadn, cr3: 0x1000n, cr4: 0x628n, efer: 0xd01n };
  return {
    ram,
    user,
    kernel,
    paging,
    options: {
      compiler,
      memoryModel: 'ia32e-paged' as const,
      paging,
      fastSystem: FAST,
      context: user,
      entry: USER,
      memory: {
        backings: [{ id: 'ram', bytes: ram }],
        mappings: [
          {
            base: 0n,
            backing: 'ram',
            offset: 0,
            length: ram.length,
            permissions: { read: true, write: true, execute: true },
          },
        ],
      },
      memoryLimits: { maxBackings: 1, maxMappings: 1, maxBackingBytes: ram.length },
      limits: { ...LIMITS, maxTranslationsPerRun: 1 },
    },
  };
}

export function warmScenarios(compiler: WebAssembly.Module, make: Factory): Scenario[] {
  return FAST_FORMS.map((form) => ({
    name: `context reuse warms ${form.kind} round trips under a one-translation allowance`,
    async run() {
      const setup = fastSetup(compiler, form),
        cpu = await make(setup.options);
      try {
        const numeric = preserveNumeric(cpu);
        if (form.kind === 'gs') {
          cpu.setContext(setup.kernel);
          cpu.setState(initial(KERNEL + 0x100n, { 0: 0x405000n, 1: 0xc0000102n, 2: 0n }));
          const programmed = await cpu.run({ budget: 1n });
          equal(programmed.retired, 1n, 'guest KERNEL_GS_BASE WRMSR');
          equal(cpu.readFastSystemState().kernelGsBase, 0x405000n, 'guest bank publication');
          cpu.setContext(setup.user);
        }
        const input = (n: number) =>
          initial(
            USER,
            {
              1: form.kind.startsWith('sysexit') ? USER_SP : 0x1122334400000001n,
              2: form.kind.startsWith('sysexit') ? USER + 2n : 0x1122334400000002n,
              3: form.kind.endsWith('32') ? BigInt(n) : 0x1122334400000003n,
              4: USER_SP,
              8: form.kind.endsWith('32') ? 0x1122334400000008n : BigInt(n),
            },
            0x202n,
          );
        cpu.setTimeState({ tsc: 100n, tscAux: 7 });
        cpu.setState(input(1));
        for (let i = 0; i < form.instructions; i++) {
          const part = await cpu.run({ budget: 1n });
          equal(part.reason, 'budget', 'finite budget-one priming completes');
          equal(part.retired, 1n, 'one priming instruction');
        }
        equal(
          cpu.readTimeState().tsc,
          100n + BigInt(form.instructions),
          'literal fast-system priming guest time',
        );
        same(cpu.readContext(), setup.user, 'priming returns complete user facts');
        if (form.kind === 'gs') cpu.writePhysicalMemory(0xe010n, little(0n));
        const memory = cpu.readPhysicalMemory(0n, setup.ram.length),
          before = input(101);
        cpu.setState(before);
        cpu.setTimeState({ tsc: 1000n, tscAux: 7 });
        await noCompilation(async () => {
          const result = await cpu.run({ budget: BigInt(form.instructions * 101) });
          equal(result.reason, 'budget', 'all101 warm cycles complete with quota1');
          equal(result.retired, BigInt(form.instructions * 101), 'literal full cycle work');
          equal(
            cpu.readTimeState().tsc,
            1000n + BigInt(form.instructions * 101),
            'all syscall SYSRET SYSENTER SYSEXIT and SWAPGS work ticks exactly once',
          );
          equal(result.resources.compilations, 0, 'no additional Rust compilation');
          equal(result.resources.generatedBytes, 0, 'no additional generated bytes');
          const writes: Record<number, bigint> = form.kind.endsWith('32') ? { 3: 0n } : { 8: 0n };
          if (!form.kind.startsWith('sysexit')) Object.assign(writes, { 1: USER + 2n, 11: 0x202n });
          same(
            result.state,
            changed(
              before,
              USER + BigInt(form.user.length / 2),
              writes,
              form.kind.startsWith('sysexit') ? 0x46n : 0x246n,
            ),
            'independent full warm scalar result',
          );
          check(result.resources.nativeEntries > 0, 'real generated invocation performed');
        });
        if (form.kind === 'gs') memory.set(little(101n), 0xe010);
        same(cpu.readPhysicalMemory(0n, memory.length), memory, 'all memory and code guards');
        const shortInput = input(3);
        cpu.setState(shortInput);
        await noCompilation(async () => {
          for (let i = 0; i < form.instructions * 3; i++) {
            const part = await cpu.run({ budget: 1n });
            equal(part.reason, 'budget', 'warm budget-one resume makes progress');
            equal(part.retired, 1n, 'one instruction per short resume');
            equal(part.resources.compilations, 0, 'warm short resumes do not compile');
            equal(part.resources.generatedBytes, 0, 'warm short resumes generate no bytes');
          }
        });
        const shortWrites: Record<number, bigint> = form.kind.endsWith('32')
          ? { 3: 0n }
          : { 8: 0n };
        if (!form.kind.startsWith('sysexit'))
          Object.assign(shortWrites, { 1: USER + 2n, 11: 0x202n });
        same(
          cpu.readState(),
          changed(
            shortInput,
            USER + BigInt(form.user.length / 2),
            shortWrites,
            form.kind.startsWith('sysexit') ? 0x46n : 0x246n,
          ),
          'literal scalar result after budget-one warm resumptions',
        );
        equal(
          cpu.readTimeState().tsc,
          1000n + BigInt(form.instructions * 104),
          'warm short resumes preserve exact fast-system clock',
        );
        if (form.kind === 'gs') memory.set(little(104n), 0xe010);
        same(
          cpu.readPhysicalMemory(0n, memory.length),
          memory,
          'short resumes preserve all code table and stack guards',
        );
        same(cpu.readContext(), setup.user, 'full returned user caches');
        same(cpu.readPagingState(), setup.paging, 'control and CR2 authority preserved');
        same(
          cpu.readFastSystemState(),
          { ...FAST, kernelGsBase: form.kind === 'gs' ? 0x405000n : 0n },
          'complete live bank',
        );
        numeric();
      } finally {
        cpu.dispose();
      }
    },
  }));
}
