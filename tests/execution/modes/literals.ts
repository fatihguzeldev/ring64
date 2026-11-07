import { check, equal, exit, fault, memory } from '../../support/fixture.js';
import { LONG, changed, context, input, using, type Scenario } from './fixture.js';

export function literalScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'mode opcode collisions distinguish REX from legacy INC',
      async run() {
        for (const ctx of [LONG, context('protected'), context('compatibility')])
          await using(compiler, '40b878563412', ctx, async (cpu) => {
            const state = input();
            cpu.setState(state);
            const result = await cpu.run({ budget: 1n });
            exit(
              result,
              'budget',
              1n,
              1n,
              ctx.mode === 'long64'
                ? changed(state, 0x1006n, { 0: 0x12345678n })
                : changed(state, 0x1001n, { 0: 0x1122334455667789n }, 3n),
            );
            equal(result.fault, undefined, 'no linear fault');
            equal(result.segmentFault, undefined, 'no segment fault');
          });
      },
    },
    {
      name: 'address32 IP relative offsets precede full FS base while LEA ignores it',
      async run() {
        for (const opcode of ['8b', '8d'])
          await using(
            compiler,
            `6764${opcode}0500000000`,
            { mode: 'long64', fsBase: 0x100000000n, gsBase: 0n },
            async (cpu) => {
              const state = input(0xffff800000001000n);
              cpu.setState(state);
              const result = await cpu.run({ budget: 1n });
              exit(
                result,
                'budget',
                1n,
                1n,
                changed(state, 0xffff800000001008n, { 0: opcode === '8b' ? 0x12345678n : 0x1008n }),
              );
            },
            {
              entry: 0xffff800000001000n,
              data: opcode === '8b' ? [{ base: 0x100001008n, bytes: '78563412' }] : [],
            },
          );
      },
    },
    {
      name: 'ignored long64 segment prefixes retain earlier FS selection',
      async run() {
        for (const code of ['643e8b00', '3e648b00'])
          await using(
            compiler,
            code,
            { mode: 'long64', fsBase: 0x10000n, gsBase: 0n },
            async (cpu) => {
              const state = input(0x1000n, { 0: 0x2000n });
              cpu.setState(state);
              exit(
                await cpu.run({ budget: 1n }),
                'budget',
                1n,
                1n,
                changed(state, 0x1004n, { 0: 0x12345678n }),
              );
            },
            {
              data: [
                { base: 0x12000n, bytes: '78563412' },
                { base: 0x2000n, bytes: 'a5a5a5a5' },
              ],
            },
          );
      },
    },
    {
      name: 'virtual8086 fetches through its synthetic RW data CS cache',
      async run() {
        await using(compiler, 'b83412', context('virtual8086'), async (cpu) => {
          const state = input();
          cpu.setState(state);
          exit(
            await cpu.run({ budget: 1n }),
            'budget',
            1n,
            1n,
            changed(state, 0x1003n, { 0: 0x1122334455661234n }),
          );
        });
      },
    },
    {
      name: 'address16 truncates starting offset without imposing a 64 KiB operand limit',
      async run() {
        for (const limit of [0xffffffff, 0xffff]) {
          const ctx = context();
          ctx.segments.ds.base = 0x10000n;
          ctx.segments.ds.limit = limit;
          await using(
            compiler,
            '678b00',
            ctx,
            async (cpu) => {
              const state = input(0x1000n, { 3: 0x112233440000ffffn, 6: 0x1122334400000000n });
              cpu.setState(state);
              const result = await cpu.run({ budget: 1n });
              if (limit === 0xffffffff)
                exit(result, 'budget', 1n, 1n, changed(state, 0x1003n, { 0: 0x1122334412345678n }));
              else {
                exit(result, 'segment-fault', 1n, 0n, state);
                equal(result.fault, undefined, 'no linear fault');
                check(result.segmentFault, 'segment tuple');
                for (const [key, value] of Object.entries({
                  instructionPc: 0x1000n,
                  segment: 'ds',
                  offset: 0xffffn,
                  width: 4,
                  access: 'read',
                  cause: 'limit',
                  failingOffset: 0x10000n,
                }))
                  equal(result.segmentFault[key as keyof typeof result.segmentFault], value, key);
              }
            },
            { data: [{ base: 0x1ffffn, bytes: '78563412' }] },
          );
        }
      },
    },
    {
      name: 'stack address size is independent of 67 and operand-size slots',
      async run() {
        for (const code of ['6750', '6650']) {
          const ctx = context();
          ctx.segments.ss.base = 0x20000n;
          await using(
            compiler,
            code,
            ctx,
            async (cpu) => {
              const state = input(0x1000n, { 0: 0x1122334411223344n, 4: 0x1122334400010010n });
              cpu.setState(state);
              exit(
                await cpu.run({ budget: 1n }),
                'budget',
                1n,
                1n,
                changed(state, 0x1002n, {
                  4: code === '6750' ? 0x112233440001000cn : 0x112233440001000en,
                }),
              );
              memory(cpu, 0x3000cn, code === '6750' ? '44332211' : 'a5a54433');
            },
            { data: [{ base: 0x3000cn, bytes: 'a5a5a5a5' }] },
          );
        }
      },
    },
    {
      name: 'CS default16 does not truncate sequential EIP after a near32 transfer',
      async run() {
        const ctx = context('protected', false);
        ctx.segments.cs.base = 0x20000n;
        ctx.segments.cs.limit = 0x1ffff;
        await using(
          compiler,
          '66e9faef0000',
          ctx,
          async (cpu) => {
            const state = input();
            cpu.setState(state);
            const result = await cpu.run({ budget: 2n });
            exit(result, 'budget', 2n, 2n, changed(state, 0x10001n, {}, 0x8d6n));
            const ranges = cpu.inspectTranslations().flatMap((m) => m.dependencies);
            check(
              ranges.some((r) => r.start === 0x21000n),
              'first linear source',
            );
            check(
              ranges.some((r) => r.start === 0x30000n),
              'target linear source',
            );
            cpu.setState(state);
            exit(
              await cpu.run({ budget: 2n, stop: 0x10000n }),
              'stop',
              2n,
              1n,
              changed(state, 0x10000n),
            );
          },
          { codeBase: 0x21000n, data: [{ base: 0x30000n, bytes: 'f5', execute: true }] },
        );
      },
    },
    {
      name: 'short conditional near16 truncates only a taken target',
      async run() {
        for (const flags of [2n, 0x42n])
          await using(
            compiler,
            '667500',
            context(),
            async (cpu) => {
              const state = input(0x10000n, {}, flags);
              cpu.setState(state);
              exit(
                await cpu.run({ budget: 1n }),
                'budget',
                1n,
                1n,
                changed(state, flags === 2n ? 3n : 0x10003n),
              );
            },
            { entry: 0x10000n },
          );
      },
    },
    {
      name: 'real reset-style hidden CS base is imported without selector reconstruction',
      async run() {
        const ctx = context('real', false, false);
        ctx.segments.cs = {
          ...ctx.segments.cs,
          type: 'read-write',
          base: 0xffff0000n,
          limit: 0xffff,
        };
        await using(
          compiler,
          '66b878563412',
          ctx,
          async (cpu) => {
            const state = input(0xfff0n);
            cpu.setState(state);
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(state, 0xfff6n, { 0: 0x1122334412345678n }),
            );
          },
          { entry: 0xfff0n, codeBase: 0xfffffff0n },
        );
      },
    },
    {
      name: 'real address calculation uses enabled A20 and preserves upper AL neighbors',
      async run() {
        const ctx = context('real', false, false);
        ctx.segments.ds.base = 0xffff0n;
        ctx.segments.ds.limit = 0xffff;
        await using(
          compiler,
          'a0ffff',
          ctx,
          async (cpu) => {
            const state = input();
            cpu.setState(state);
            exit(
              await cpu.run({ budget: 1n }),
              'budget',
              1n,
              1n,
              changed(state, 0x1003n, { 0: 0x112233445566777bn }),
            );
          },
          {
            data: [
              { base: 0x10ffefn, bytes: '7b' },
              { base: 0xffefn, bytes: 'a5' },
            ],
          },
        );
      },
    },
    {
      name: 'linear32 initial addition wraps while full operand spans are checked',
      async run() {
        for (const cross of [false, true]) {
          const ctx = context();
          ctx.segments.ds.base = cross ? 0xfffffffen : 0xfffffff0n;
          await using(
            compiler,
            '8b03',
            ctx,
            async (cpu) => {
              const state = input(0x1000n, { 3: cross ? 0n : 0x20n });
              cpu.setState(state);
              const result = await cpu.run({ budget: 1n });
              if (cross) {
                exit(result, 'data-fault', 1n, 0n, state);
                fault(result, {
                  instructionPc: 0x1000n,
                  segment: 'ds',
                  address: 0xfffffffen,
                  width: 4,
                  access: 'read',
                  cause: 'address-range',
                  failingAddress: 0x100000000n,
                });
              } else
                exit(result, 'budget', 1n, 1n, changed(state, 0x1002n, { 0: 0x1122334412345678n }));
            },
            {
              data: [
                { base: cross ? 0xfffffffen : 0x10n, bytes: cross ? 'a5a5' : '78563412' },
                { base: 0x100000000n, bytes: 'a5a5' },
              ],
            },
          );
        }
      },
    },
    {
      name: 'BT signed word adjustment wraps the effective offset before DS base',
      async run() {
        const ctx = context();
        ctx.segments.ds.base = 0x10000n;
        ctx.segments.ds.limit = 0x1ffff;
        await using(
          compiler,
          '670fa308',
          ctx,
          async (cpu) => {
            const state = input(0x1000n, { 3: 2n, 6: 0n, 1: 0x11223344ffffffffn });
            cpu.setState(state);
            const result = await cpu.run({ budget: 1n });
            equal(result.state.flags & 0x43n, 0x43n, 'defined BT flags');
            check((result.state.flags & ~0x8d7n) === 0n, 'valid arithmetic flags');
            exit(result, 'budget', 1n, 1n, changed(state, 0x1004n, {}, result.state.flags));
            memory(cpu, 0x1fffen, '00000080');
            memory(cpu, 0xfffen, '00000000');
          },
          {
            data: [
              { base: 0x1fffen, bytes: '00000080' },
              { base: 0xfffen, bytes: '00000000' },
            ],
          },
        );
      },
    },
    {
      name: '66 near CALL and JMP retain long64 targets and eight-byte return slots',
      async run() {
        for (const code of ['66e801000000', '66e901000000'])
          await using(
            compiler,
            code,
            LONG,
            async (cpu) => {
              const state = input(0x1000n, { 4: 0x4010n });
              cpu.setState(state);
              exit(
                await cpu.run({ budget: 1n }),
                'budget',
                1n,
                1n,
                changed(state, 0x1007n, code[2] === 'e' && code[3] === '8' ? { 4: 0x4008n } : {}),
              );
              memory(
                cpu,
                0x4008n,
                code.startsWith('66e8') ? '0610000000000000' : 'a5a5a5a5a5a5a5a5',
              );
            },
            { data: [{ base: 0x4008n, bytes: 'a5a5a5a5a5a5a5a5' }] },
          );
      },
    },
  ];
}
