import {
  LONG,
  R,
  map,
  mapped,
  context,
  profiles,
  using,
  input,
  changed,
  outcome,
  stack,
  seed,
  x87,
  other,
  equal,
  memory,
  fault,
  noFault,
  type Scenario,
} from './fixture.js';

export function hintScenarios(compiler: WebAssembly.Module): Scenario[] {
  return [
    {
      name: 'all LFENCE MFENCE SFENCE low-rm aliases ignore operands and pending x87 across imported profiles',
      async run() {
        for (const p of profiles)
          for (let modrm = 0xe8; modrm <= 0xff; modrm++) {
            const code = '6764' + (p.mode === 'long64' ? '4f' : '') + '0fae' + modrm.toString(16);
            const execution = p.mode === 'long64' ? LONG : context(p.mode, p.code32, p.stack32);
            await using(compiler, code, execution, async (cpu) => {
              const before = input(),
                numeric = stack({}, 5, 0x37b, 0x8084);
              cpu.setState(before);
              seed(cpu, numeric);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(
                result,
                'budget',
                1n,
                1n,
                0n,
                0n,
                changed(before, 0x1000n + BigInt(code.length / 2)),
              );
              noFault(result);
              x87(cpu, numeric);
              other(cpu);
              memory(cpu, 0x1000n, code);
              equal(result.resources.cachedArtifacts, 1, 'fence retains source owner');
            });
          }
      },
    },
    {
      name: 'fences preserve checked streaming-store visibility to subsequent ordinary loads and normal retirement',
      async run() {
        await using(
          compiler,
          '0fc3030faef80faef00faee8488b0b',
          LONG,
          async (cpu) => {
            const before = input(0x1000n, { 3: 0x6000n, 0: 0x8877665544332211n }),
              numeric = stack({}, 5, 0x37b, 0x8084);
            cpu.setState(before);
            seed(cpu, numeric);
            const result = await cpu.run({ budget: 5n, repeatBudget: 0n });
            outcome(
              result,
              'budget',
              5n,
              5n,
              0n,
              0n,
              changed(before, 0x100fn, { 1: 0xa5a5a5a544332211n }),
            );
            noFault(result);
            x87(cpu, numeric);
            other(cpu);
            memory(cpu, 0x6000n, '11223344a5a5a5a5');
          },
          { data: [{ base: 0x6000n, bytes: 'a5'.repeat(8) }] },
        );
      },
    },
    {
      name: 'PREFETCH four hints consume full EA syntax but ignore prefixes inaccessible segments and noncanonical data',
      async run() {
        for (const p of profiles)
          for (let selector = 0; selector < 4; selector++) {
            const execution = p.mode === 'long64' ? LONG : context(p.mode, p.code32, p.stack32);
            if (execution.mode !== 'long64' && execution.mode !== 'virtual8086') {
              execution.segments.ds.usable = false;
              execution.segments.ds.limit = 0;
              execution.segments.ds.type = 'code';
            }
            const code =
              (p.mode !== 'long64' && !p.code32 ? '67' : '') +
              '66f2f30f18' +
              (0x84 + selector * 8).toString(16) +
              '23ffffffff';
            await using(compiler, code, execution, async (cpu) => {
              const before = input(0x1000n, { 3: 0x800000000001n, 1: 0n }),
                numeric = stack({}, 5, 0x37b, 0x8084);
              cpu.setState(before);
              seed(cpu, numeric);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(
                result,
                'budget',
                1n,
                1n,
                0n,
                0n,
                changed(before, 0x1000n + BigInt(code.length / 2)),
              );
              noFault(result);
              x87(cpu, numeric);
              other(cpu);
              memory(cpu, 0x1000n, code);
              equal(result.resources.cachedArtifacts, 1, 'hint does not invalidate code');
            });
          }
      },
    },
    {
      name: 'PAUSE ignores effective REX and operand prefixes without consulting RCX or consuming repeat budget',
      async run() {
        for (const p of profiles)
          for (const code of p.mode === 'long64'
            ? ['f390', '66f390', 'f34190', '66f34990', '41f390', 'f2f390']
            : ['f390', '66f390', 'f2f390']) {
            const execution = p.mode === 'long64' ? LONG : context(p.mode, p.code32, p.stack32);
            await using(compiler, code, execution, async (cpu) => {
              const before = input(0x1000n, { 1: 0n }),
                numeric = stack({}, 5, 0x37b, 0x8084);
              cpu.setState(before);
              seed(cpu, numeric);
              const result = await cpu.run({ budget: 1n, repeatBudget: 0n });
              outcome(
                result,
                'budget',
                1n,
                1n,
                0n,
                0n,
                changed(before, 0x1000n + BigInt(code.length / 2)),
              );
              noFault(result);
              x87(cpu, numeric);
              other(cpu);
            });
          }
        await using(compiler, '4190', LONG, async (cpu) => {
          const before = input(),
            numeric = stack({}, 5);
          cpu.setState(before);
          seed(cpu, numeric);
          const result = await cpu.run({ budget: 1n });
          outcome(
            result,
            'budget',
            1n,
            1n,
            1n,
            0n,
            changed(before, 0x1002n, {
              0: before.registers[8]! & 0xffffffffn,
              8: before.registers[0]! & 0xffffffffn,
            }),
          );
          x87(cpu, numeric);
          other(cpu);
          noFault(result);
        });
      },
    },
    {
      name: 'CLFLUSH uses one readable byte with no execute permission or x87 check in all imported profiles',
      async run() {
        for (const p of profiles) {
          const execution = p.mode === 'long64' ? LONG : context(p.mode, p.code32, p.stack32),
            address16 = p.mode !== 'long64' && !p.code32;
          const code = '0fae' + (address16 ? '3f' : '38');
          await using(
            compiler,
            code,
            execution,
            async (cpu) => {
              const before = input(0x1000n, { [address16 ? 3 : 0]: 0x6001n }),
                numeric = stack({}, 5, 0x37b, 0x8084);
              cpu.setState(before);
              seed(cpu, numeric);
              const result = await cpu.run({ budget: 1n });
              outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1003n));
              noFault(result);
              x87(cpu, numeric);
              other(cpu);
              memory(cpu, 0x6001n, 'a5');
              equal(result.resources.cachedArtifacts, 1, 'flush retains source owner');
            },
            { data: [{ base: 0x6001n, bytes: 'a5', read: true, write: false, execute: false }] },
          );
        }
      },
    },
    {
      name: 'CLFLUSH permits execute-only segments while ordinary reads fail and private mapping R remains mandatory',
      async run() {
        for (const code32 of [false, true])
          for (const stack32 of [false, true])
            for (const selected of ['cs', 'ds'] as const)
              for (const read of [false, true]) {
                const execution = context('protected', code32, stack32);
                execution.segments[selected].type = 'code';
                const address = code32 ? '' : '67',
                  segment = selected === 'cs' ? '2e' : '';
                const flush = segment + address + '0fae38',
                  load = segment + address + '8a00';
                await using(
                  compiler,
                  flush + load,
                  execution,
                  async (cpu) => {
                    const before = input(0x1000n, { 0: 0x6000n }),
                      numeric = stack({}, 5, 0x37b, 0x8084);
                    cpu.setState(before);
                    seed(cpu, numeric);
                    const first = await cpu.run({ budget: 1n });
                    if (!read) {
                      outcome(first, 'data-fault', 1n, 0n, 1n, 0n, before);
                      fault(first, {
                        instructionPc: 0x1000n,
                        address: 0x6000n,
                        width: 1,
                        access: 'read',
                        cause: 'permission',
                        failingAddress: 0x6000n,
                        segment: selected,
                      });
                    } else {
                      const next = changed(before, 0x1000n + BigInt(flush.length / 2));
                      outcome(first, 'budget', 1n, 1n, 1n, 0n, next);
                      noFault(first);
                      const ordinary = await cpu.run({ budget: 1n });
                      outcome(ordinary, 'segment-fault', 1n, 0n, 1n, 0n, next);
                      equal(
                        ordinary.segmentFault?.cause,
                        'type',
                        'ordinary Read keeps its segment restriction',
                      );
                      equal(ordinary.segmentFault?.width, 1, 'ordinary byte control');
                      equal(ordinary.segmentFault?.access, 'read', 'ordinary Read control access');
                    }
                    x87(cpu, numeric);
                    other(cpu);
                  },
                  { data: [{ base: 0x6000n, bytes: 'a5', read, write: !read, execute: false }] },
                );
              }
      },
    },
    {
      name: 'CLFLUSH keeps unusable and segment-limit faults and accepts exactly the readable final segment byte',
      async run() {
        for (const cause of ['unusable', 'limit', 'valid'] as const) {
          const execution = context('protected');
          execution.segments.ds.type = 'code';
          execution.segments.ds.limit = cause === 'limit' ? 0x5fff : 0x6000;
          execution.segments.ds.usable = cause !== 'unusable';
          await using(
            compiler,
            '0fae38',
            execution,
            async (cpu) => {
              const before = input(0x1000n, { 0: 0x6000n }),
                numeric = stack({}, 5);
              cpu.setState(before);
              seed(cpu, numeric);
              const result = await cpu.run({ budget: 1n });
              outcome(
                result,
                cause === 'valid' ? 'budget' : 'segment-fault',
                1n,
                cause === 'valid' ? 1n : 0n,
                1n,
                0n,
                cause === 'valid' ? changed(before, 0x1003n) : before,
              );
              if (cause === 'valid') noFault(result);
              else {
                equal(result.segmentFault?.cause, cause, 'flush retains context failure');
                equal(result.segmentFault?.width, 1, 'flush context probe width');
                equal(
                  result.segmentFault?.access,
                  'read',
                  'flush segment diagnostic uses read direction',
                );
                equal(result.fault, undefined, 'context failure precedes backing');
              }
              x87(cpu, numeric);
              other(cpu);
            },
            { data: [{ base: 0x6000n, bytes: 'a5', read: true, write: false }] },
          );
        }
      },
    },
    {
      name: 'CLFLUSH at u64 MAX probes one byte and retains identity-aliased executable owners and context',
      async run() {
        const code = '0fae38';
        await mapped(compiler, code, [], [map(0xffffffffffffffffn, 'code', 1, R)], async (cpu) => {
          const before = input(0x1000n, { 0: 0xffffffffffffffffn }),
            numeric = stack({}, 5),
            execution = cpu.readContext();
          for (let repeat = 0; repeat < 2; repeat++) {
            cpu.setState(before);
            seed(cpu, numeric);
            const result = await cpu.run({ budget: 1n });
            outcome(result, 'budget', 1n, 1n, 1n, 0n, changed(before, 0x1003n));
            noFault(result);
            x87(cpu, numeric);
            other(cpu);
            memory(cpu, 0x1000n, code);
            equal(result.resources.cachedArtifacts, 1, 'flush never invalidates executable bytes');
            equal(
              result.resources.compilations,
              repeat === 0 ? 1 : 0,
              'flush retains reusable translation',
            );
            equal(
              JSON.stringify(cpu.readContext(), (_, v: unknown) =>
                typeof v === 'bigint' ? v.toString() : v,
              ),
              JSON.stringify(execution, (_, v: unknown) =>
                typeof v === 'bigint' ? v.toString() : v,
              ),
              'flush preserves imported context',
            );
          }
        });
      },
    },
    {
      name: 'selected streaming and hint decode classes retain deciding-byte diagnostics and required-tail precedence',
      async run() {
        for (const [code, reason] of [
          ['0ff704', 'invalid-encoding'],
          ['660ff704', 'invalid-encoding'],
          ['0fe7c0', 'invalid-encoding'],
          ['660fe7c0', 'invalid-encoding'],
          ['0f2bc0', 'invalid-encoding'],
          ['660f2bc0', 'invalid-encoding'],
          ['0fc3c0', 'invalid-encoding'],
          ['0fae2c', 'unsupported'],
          ['0fae34', 'unsupported'],
          ['660faef0', 'unsupported'],
          ['f30faee8', 'unsupported'],
          ['0f1824', 'unsupported'],
          ['0f18fc', 'unsupported'],
          ['f290', 'unsupported'],
          ['f3f290', 'unsupported'],
          ['f00faef4', 'invalid-encoding'],
          ['f00f188423ffffffff', 'invalid-encoding'],
          ['f00faebc23ffffffff', 'invalid-encoding'],
          ['f00fe78423ffffffff', 'invalid-encoding'],
          ['f0660ff7c1', 'invalid-encoding'],
          ['f0f390', 'unsupported'],
        ] as const)
          await using(compiler, code, LONG, async (cpu) => {
            const before = input(),
              numeric = stack({}, 5, 0x37b, 0x8084);
            cpu.setState(before);
            seed(cpu, numeric);
            const result = await cpu.run({ budget: 1n });
            outcome(result, reason, 1n, 0n, 1n, 0n, before);
            noFault(result);
            x87(cpu, numeric);
            other(cpu);
            equal(result.resources.compilations, 0, 'rejected class owns no artifact');
          });
        for (const full of [
          '0f188423ffffffff',
          '0faebc23ffffffff',
          '0fe78423ffffffff',
          'f00fe78423ffffffff',
          '660ff7c4',
        ])
          for (let length = 1; length < full.length / 2; length++) {
            const code = full.slice(0, length * 2);
            await using(compiler, code, LONG, async (cpu) => {
              const before = input(),
                numeric = stack({}, 5, 0x37b, 0x8084);
              cpu.setState(before);
              seed(cpu, numeric);
              const result = await cpu.run({ budget: 1n });
              outcome(result, 'fetch-fault', 1n, 0n, 1n, 0n, before);
              fault(result, {
                instructionPc: 0x1000n,
                address: 0x1000n + BigInt(length),
                width: 1,
                access: 'execute',
                cause: 'unmapped',
                failingAddress: 0x1000n + BigInt(length),
                segment: 'cs',
              });
              x87(cpu, numeric);
              other(cpu);
            });
          }
        for (const [code, reason] of [
          ['67'.repeat(12) + '0faee8', 'budget'],
          ['67'.repeat(13) + '0faee8', 'invalid-encoding'],
        ] as const)
          await using(compiler, code, LONG, async (cpu) => {
            const before = input(),
              numeric = stack({}, 5, 0x37b, 0x8084);
            cpu.setState(before);
            seed(cpu, numeric);
            const result = await cpu.run({ budget: 1n });
            outcome(
              result,
              reason,
              1n,
              reason === 'budget' ? 1n : 0n,
              1n,
              0n,
              reason === 'budget' ? changed(before, 0x100fn) : before,
            );
            x87(cpu, numeric);
            other(cpu);
            noFault(result);
          });
      },
    },
  ];
}
