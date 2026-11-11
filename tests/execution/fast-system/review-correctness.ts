import type { FastSystemState } from '../../../host/index.js';
import { longSnapshot } from '../../support/context.js';
import {
  BANK,
  PC,
  check,
  equal,
  hex,
  initial,
  same,
  usingPaged,
  type Scenario,
} from '../paging/fixture.js';

const roots = [
  [0x1000n, 0x2027n],
  [0x1800n, 0x2027n],
  [0x2000n, 0x3027n],
  [0x3010n, 0x4027n],
  [0x4000n, 0x9063n],
] as const;
function bank(): FastSystemState {
  return {
    star: 0x0020000800000000n,
    lstar: 0x402000n,
    fmask: 0x200n,
    sysenterCs: 8n,
    sysenterEip: 0x402000n,
    sysenterEsp: 0x404ff0n,
    kernelGsBase: 0x406000n,
  };
}

export function fastSystemReviewCorrectnessScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'fast review typed protection diagnostics distinguish privilege admission from return target values',
      async run() {
        for (const packet of [
          { code: '480f07', cpl: 3, phase: 'privilege' },
          { code: '0f01f8', cpl: 1, phase: 'privilege' },
          { code: '0f35', cpl: 2, phase: 'privilege' },
          { code: '480f07', cpl: 0, phase: 'target' },
          { code: '0f34', cpl: 0, phase: 'target', nullCs: true },
        ]) {
          const context = longSnapshot();
          context.cpl = packet.cpl;
          context.segments.cs.selector = 8 | packet.cpl;
          context.segments.ss.selector = 16 | packet.cpl;
          for (const segment of Object.values(context.segments)) segment.dpl = packet.cpl;
          await usingPaged(
            compiler,
            { code: packet.code, context, bank: { ...BANK, efer: 0x501n } },
            async (cpu) => {
              cpu.setFastSystemState({ ...bank(), sysenterCs: 'nullCs' in packet ? 0n : 8n });
              const before = initial(
                PC,
                { 1: packet.cpl === 0 ? 0x800000000000n : 0x402000n, 2: 0x402000n, 11: 0x202n },
                0x10202n,
              );
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              equal(result.reason, 'protection-fault', 'selected own GP');
              equal(result.retired, 0n, 'own fault does not retire');
              equal(result.protectionFault?.vector, 13, 'GP vector');
              equal(result.protectionFault?.errorCode, 0, 'hard-zero error');
              equal(result.protectionFault?.phase, packet.phase, 'producer-specific failed phase');
              equal(result.protectionFault?.instructionPc, PC, 'source identity');
              same(result.state.registers, before.registers, 'no partial GPR publication');
              same(cpu.readContext(), context, 'no partial context publication');
            },
          );
        }
      },
    },
    {
      name: 'fast review CPL1 and CPL2 entry remains legal and is not confused with privileged MSR or return admission',
      async run() {
        for (const cpl of [1, 2])
          for (const code of ['0f05', '0f34']) {
            const context = longSnapshot();
            context.cpl = cpl;
            context.segments.cs.selector = 8 | cpl;
            context.segments.ss.selector = 16 | cpl;
            for (const segment of Object.values(context.segments)) segment.dpl = cpl;
            await usingPaged(
              compiler,
              { code, context, words: roots, bank: { ...BANK, efer: 0x501n } },
              async (cpu) => {
                cpu.setFastSystemState(bank());
                const before = initial(PC, { 4: 0x1234567880000000n }, 0x10202n);
                cpu.setState(before);
                const result = await cpu.run({ budget: 1n });
                equal(result.reason, 'budget', `CPL${cpl} ${code} successful entry`);
                equal(result.retired, 1n, 'one entry');
                equal(result.state.rip, 0x402000n, 'unmapped entry is committed before fetch');
                equal(result.state.flags, 2n, 'RF clears and entry removes IF');
                equal(
                  result.state.registers[4],
                  code === '0f05' ? before.registers[4] : 0x404ff0n,
                  'instruction-specific stack effect',
                );
                equal(cpu.readContext().cpl, 0, 'entry destination CPL0');
                equal(cpu.readContext().mode, 'long64', 'entry destination Long64');
                equal(cpu.readPagingState().cr2, 0n, 'entry does not preflight destination');
                same(result.state.event, { kind: 'ready' }, 'entry is not an event source');
              },
            );
          }
      },
    },
    {
      name: 'fast review all return widths fault on supervisor-only target fetch after committing CPL3 exactly once',
      async run() {
        for (const code of ['0f07', '480f07', '0f35', '480f35'])
          for (const deliver of [false, true])
            await usingPaged(
              compiler,
              {
                code,
                words: [...roots, [0x4010n, 0xb063n]],
                bank: { ...BANK, efer: 0xd01n, cr2: 0xdeadn },
                spans: [{ physical: 0xb000n, bytes: hex('48ffc0'), execute: true }],
              },
              async (cpu) => {
                cpu.setFastSystemState(bank());
                const before = initial(PC, { 1: 0x402000n, 2: 0x402000n, 11: 0x202n }, 0x202n);
                cpu.setState(before);
                const result = await cpu.run({
                  budget: 2n,
                  ...(deliver ? { eventDelivery: { budget: 0n } } : {}),
                });
                equal(
                  result.reason,
                  deliver ? 'event-budget' : 'page-fault',
                  'U/S denial belongs to destination fetch',
                );
                equal(result.retired, 1n, 'return retired before fault');
                equal(result.remaining, 1n, 'destination instruction never began');
                equal(result.state.rip, 0x402000n, 'failed destination remains current');
                equal(
                  result.state.registers[0],
                  before.registers[0],
                  'unfetched target INC cannot execute',
                );
                equal(cpu.readContext().cpl, 3, 'fault uses returned privilege');
                equal(cpu.readPagingState().cr2, 0x402000n, 'destination CR2');
                if (deliver) {
                  check(result.state.event.kind === 'pending', 'selected target PF');
                  equal(result.state.event.exception.vector, 14, 'target fault vector');
                  equal(
                    result.state.event.exception.errorCode,
                    21,
                    'present user instruction-fetch protection',
                  );
                  equal(
                    result.state.event.exception.instructionPc,
                    0x402000n,
                    'target instruction identity',
                  );
                  equal(result.state.event.exception.returnPc, 0x402000n, 'target retry identity');
                  equal(result.state.event.exception.savedFlags, 0x10202n, 'fault RF image');
                  equal(result.deliveryAttempts, 0n, 'automatic entry remains bounded separately');
                } else equal(result.pageFault?.errorCode, 21, 'literal P/U/I error bits');
              },
            );
      },
    },
    {
      name: 'fast review noncanonical discarded halves do not fault SYSEXIT32 and synthetic compatibility SS drives a real stack operand',
      async run() {
        for (const sysexit of [false, true])
          await usingPaged(
            compiler,
            {
              code: sysexit ? '66670f35' : '66670f07',
              bank: { ...BANK, efer: 0x501n },
              words: [...roots, [0x4010n, 0xb067n], [0x4018n, 0xc067n]],
              spans: [
                { physical: 0xb000n, bytes: hex('6650'), execute: true },
                { physical: 0xc000n, bytes: new Uint8Array(0x1000).fill(0xa5) },
              ],
            },
            async (cpu) => {
              cpu.setFastSystemState(bank());
              cpu.setState(
                initial(
                  PC,
                  {
                    0: 0x112233445566beefn,
                    1: sysexit ? 0x1234567800403ff0n : 0x8877665500402000n,
                    2: 0x8877665500402000n,
                    4: 0x1234567800403ff0n,
                    11: 0x202n,
                  },
                  0x202n,
                ),
              );
              const returned = await cpu.run({ budget: 1n });
              equal(returned.reason, 'budget', 'discarded noncanonical high halves accepted');
              equal(returned.state.rip, 0x402000n, 'truncated return target');
              equal(
                returned.state.registers[4],
                sysexit ? 0x403ff0n : 0x1234567800403ff0n,
                'return-specific full RSP effect',
              );
              equal(cpu.readContext().segments.ss.default32, true, 'synthetic SS.B1');
              const pushed = await cpu.run({ budget: 1n });
              equal(pushed.reason, 'budget', 'ordinary PUSH uses installed compatibility cache');
              equal(pushed.state.rip, 0x402002n, 'operand16 PUSH consumed exactly');
              equal(
                pushed.state.registers[4],
                sysexit ? 0x403feen : 0x1234567800403feen,
                'stack-size32 arithmetic preserves unrelated bank bits',
              );
              const expected = new Uint8Array(0x1000).fill(0xa5);
              expected.set(hex('efbe'), 0xfee);
              same(
                cpu.readPhysicalMemory(0xc000n, 0x1000),
                expected,
                'only actual two-byte stack slot committed',
              );
            },
          );
      },
    },
    {
      name: 'fast review clean RF0 TF0 SYSRET enables its immediate trap without an inherited observed control bit',
      async run() {
        for (const code of ['0f07', '480f07'])
          for (const deliver of [false, true])
            await usingPaged(compiler, { code, bank: { ...BANK, efer: 0x501n } }, async (cpu) => {
              cpu.setFastSystemState(bank());
              cpu.setState(initial(PC, { 1: 0x402000n, 11: 0x302n }, 2n));
              const result = await cpu.run({
                budget: 1n,
                stop: 0x402000n,
                ...(deliver ? { eventDelivery: { budget: 0n } } : {}),
              });
              equal(
                result.reason,
                deliver ? 'event-budget' : 'debug-exception',
                'new TF beats last-budget and stop',
              );
              equal(result.retired, 1n, 'return completed before trap');
              equal(result.state.flags, 0x302n, 'new flags retained');
              equal(result.state.rip, 0x402000n, 'trap at committed destination');
              equal(cpu.readContext().cpl, 3, 'trap under destination privilege');
              equal(cpu.readPagingState().cr2, 0n, 'unmapped destination was not fetched');
              equal(cpu.readDebugState().dr6 & 0x4000n, 0x4000n, 'single-step cause published');
            });
      },
    },
    {
      name: 'fast review effective REX prefix cancellation and ignored F2 F3 survive generated transfer execution',
      async run() {
        const packets = [
          {
            code: 'f2664f0f07',
            mode: 'long64',
            rip: 0xffff800000402000n,
            sp: 0x403ff0n,
            rcx: 0xffff800000402000n,
          },
          {
            code: '48660f07',
            mode: 'compatibility',
            rip: 0x402000n,
            sp: 0x403ff0n,
            rcx: 0x1122334400402000n,
          },
          {
            code: '66f34f0f35',
            mode: 'long64',
            rip: 0xffff800000402000n,
            sp: 0xffff800000403ff0n,
            rcx: 0xffff800000403ff0n,
          },
          {
            code: '4f67660f35',
            mode: 'compatibility',
            rip: 0x402000n,
            sp: 0x403ff0n,
            rcx: 0x1122334400403ff0n,
          },
        ] as const;
        for (const packet of packets)
          await usingPaged(
            compiler,
            { code: packet.code, bank: { ...BANK, efer: 0x501n } },
            async (cpu) => {
              cpu.setFastSystemState(bank());
              const before = initial(
                PC,
                {
                  1: packet.rcx,
                  2: packet.mode === 'long64' ? 0xffff800000402000n : 0x8877665500402000n,
                  4: 0x403ff0n,
                  11: 0x202n,
                },
                2n,
              );
              cpu.setState(before);
              const result = await cpu.run({ budget: 1n });
              equal(result.reason, 'budget', 'selected prefixed transfer admitted');
              equal(result.state.rip, packet.rip, 'effective return width');
              equal(result.state.registers[4], packet.sp, 'effective stack result');
              equal(
                cpu.readContext().mode,
                packet.mode,
                'REX cancellation controls destination mode',
              );
              equal(
                result.state.registers[1],
                before.registers[1],
                'ignored REX bits do not change register selection',
              );
              equal(result.state.registers[2], before.registers[2], 'return preserves RDX source');
            },
          );
        await usingPaged(
          compiler,
          { code: '90', context: longSnapshot(0n, 0x404000n) },
          async (cpu) => {
            cpu.setFastSystemState(bank());
            cpu.writePhysicalMemory(0x9ffbn, hex('f34f0f01f8'));
            cpu.setState(initial(PC + 0xffbn, {}, 2n));
            const result = await cpu.run({ budget: 1n });
            equal(result.reason, 'budget', 'last-byte ModR/M needs no fictitious following fetch');
            equal(result.state.rip, 0x401000n, 'prefixes count toward exact SWAPGS successor');
            equal(
              cpu.readContext().segments.gs.base,
              0x406000n,
              'all ignored REX bits leave GS choice intact',
            );
            equal(cpu.readFastSystemState().kernelGsBase, 0x404000n, 'real GS exchange committed');
            equal(
              cpu.readPagingState().cr2,
              0n,
              'unmapped next page not fetched under last budget',
            );
          },
        );
      },
    },
    {
      name: 'fast review newly written return operands remain live across helpers without an earlier host publication',
      async run() {
        for (const sysexit of [false, true]) {
          const code = sysexit
            ? '48b900f040000080ffff48ba002040000080ffff480f35'
            : '48b9002040000080ffff49bb020200000000000048bc00f040000080ffff480f07';
          await usingPaged(compiler, { code, bank: { ...BANK, efer: 0x501n } }, async (cpu) => {
            cpu.setFastSystemState(bank());
            cpu.setState(
              initial(
                PC,
                { 1: 0x800000000000n, 2: 0x800000000000n, 4: 0x800000000000n, 11: 0x100n },
                2n,
              ),
            );
            const result = await cpu.run({ budget: sysexit ? 3n : 4n });
            equal(
              result.reason,
              'budget',
              'live values replace deliberately invalid stale raw inputs',
            );
            equal(result.retired, sysexit ? 3n : 4n, 'moves and return retire once');
            equal(result.state.rip, 0xffff800000402000n, 'live target GPR consumed');
            equal(
              result.state.registers[4],
              0xffff80000040f000n,
              'live stack consumed or preserved',
            );
            equal(
              result.state.flags,
              sysexit ? 2n : 0x202n,
              'live flags source consumed without spurious TF',
            );
            equal(cpu.readContext().cpl, 3, 'return committed');
          });
        }
      },
    },
    {
      name: 'fast review descriptor and null GS reloads feed SWAPGS through the same authority and retain loaded attributes',
      async run() {
        for (const selector of [0n, 0x18n]) {
          const context = longSnapshot(0n, 0xffff800000404000n);
          context.gdtr = { base: 0x405000n, limit: 31 };
          const gdt = new Uint8Array(32);
          gdt.set(hex('ffff00604093cf00'), 24);
          await usingPaged(
            compiler,
            {
              code: '8ee80f01f80f32',
              context,
              words: [...roots, [0x4028n, 0xe063n]],
              spans: [{ physical: 0xe000n, bytes: gdt }],
            },
            async (cpu) => {
              cpu.setFastSystemState({ ...bank(), kernelGsBase: 0x407000n });
              cpu.setState(
                initial(PC, { 0: selector, 1: 0xc0000102n, 2: 0xffffffffffffffffn }, 2n),
              );
              const reload = await cpu.run({ budget: 1n });
              equal(reload.reason, 'budget', 'GS reload admitted');
              const loaded = cpu.readContext().segments.gs;
              equal(loaded.base, selector === 0n ? 0n : 0x406000n, 'normalized reloaded base');
              const result = await cpu.run({ budget: 2n });
              equal(result.reason, 'budget', 'SWAPGS and KERNEL_GS_BASE read complete');
              equal(
                result.state.registers[0],
                selector === 0n ? 0n : 0x406000n,
                'old reloaded GS becomes actual KERNEL_GS_BASE',
              );
              equal(result.state.registers[2], 0n, 'no stale high GS base retained');
              same(
                cpu.readContext().segments.gs,
                { ...loaded, base: 0x407000n },
                'SWAPGS changes base only even on unusable cache',
              );
            },
          );
        }
      },
    },
  ];
}
